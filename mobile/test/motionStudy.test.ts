import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GAIT_DESIGN, LEGS, isSupport, supportCount, supportSegments, swingSegments } from '../src/ui/gaitDesign.ts';
import { advance, extentAt, initialClock, seekClock, setSpeed, togglePlay, type Clock } from '../src/ui/motionLab.ts';
import {
  STAND_FRAME, STAND_SHEET, STUDY_FIXED, STUDY_MOTIONS, STUDY_ORDER, STUDY_WALK, WALK_V4_DURATION_MS, WALK_V4_FRAMES, WALK_V4_REFERENCE_WIDTH, WALK_V4_STRIDE_PX,
  anchorHalfWidth, fitScale, fitScaleCentered,
  frameIndexAt, frameMs, frameStartMs, roomScale, stepStudy, studyPoseAt, studyTotal, studyWalkPlan, walkBounds, walkPoseAt, type StudyMotion, type StudyPose,
} from '../src/ui/motionStudy.ts';

const manifest = JSON.parse(readFileSync(new URL('../../design-assets/motion-v3/manifest.json', import.meta.url), 'utf8'));

// 全身連動の歩き30姿勢＋休止1コマ（motion-v4）は親が scripts/render-full-walk.mjs を実行して manifest.json を置く。無い間は関連試験を「受領待ち」として skip（成功扱いにしない）
const V4_URL = new URL('../../design-assets/motion-v4/manifest.json', import.meta.url);
const V4_READY = existsSync(V4_URL);
const SKIP_V4 = V4_READY ? false : '受領待ち: design-assets/motion-v4/manifest.json が未配置';
const walkV4 = V4_READY ? JSON.parse(readFileSync(V4_URL, 'utf8')).atlases.walk : null;

// 歩行の休憩は moving=false で、歩行シートの0コマとは別シート（walkV4Idle）の絵。シート名で区別する
const key = (p: StudyPose) => `${p.sheet}:${p.frame}:${p.facing}`;

test('素材の整合: 枚数・秒数が manifest と一致（伸び30/3200・寝入り24/2400・起き30/3000・keys8）。矩形がシート内で連番', () => {
  for (const m of STUDY_ORDER) {
    const d = STUDY_MOTIONS[m];
    if (d.sheet === 'walkV4') {
      // 歩くは全身連動を組んだ30姿勢の描画（motion-v4）。値の突き合わせは下の v4 試験。旧walk24枚/旧rigは既定では再生しない
      assert.equal(d.frameCount, 30);
      assert.equal(d.durationMs, 1800);
      continue;
    }
    const a = manifest.atlases[d.sheet];
    assert.equal(a.frameCount, d.frameCount, m);
    assert.equal(a.frames.length, d.frameCount, m);
    assert.equal(a.durationMs, d.durationMs, m);
  }
  assert.equal(manifest.atlases.keys.frames.length, 8);
  for (const key of ['keys', 'walk', 'stretch', 'down', 'up']) {
    const a = manifest.atlases[key];
    assert.ok(a.referenceWidth > 0);
    a.frames.forEach((f: { index: number; rect: number[] }, i: number) => {
      assert.equal(f.index, i);
      const [x, y, w, h] = f.rect as [number, number, number, number];
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= a.width && y + h <= a.height, `${key}#${i}`);
    });
  }
});

test('境界: 各コマの頭の時刻でそのコマ、直前は1つ前。範囲外は両端へ丸める。歩くは周期で巻き戻る', () => {
  for (const m of STUDY_ORDER) {
    const d = STUDY_MOTIONS[m];
    for (let i = 0; i < d.frameCount; i++) {
      assert.equal(frameIndexAt(m, frameStartMs(m, i)), i, `${m}#${i}`);
      if (i > 0) assert.equal(frameIndexAt(m, frameStartMs(m, i) - 0.001), i - 1, `${m}#${i}-`);
    }
    assert.equal(frameIndexAt(m, -50), 0);
    assert.equal(frameIndexAt(m, 0), 0);
    assert.equal(frameMs(m) * d.frameCount, d.durationMs);
    if (d.loop) {
      assert.equal(studyTotal(m), Infinity);
      assert.equal(frameIndexAt(m, d.durationMs), 0, '1周期で頭へ');
      assert.equal(frameIndexAt(m, d.durationMs * 3 + frameMs(m) * 5), 5);
    } else {
      assert.equal(studyTotal(m), d.durationMs);
      assert.equal(frameIndexAt(m, d.durationMs), d.frameCount - 1, '終端は最後のコマ');
      assert.equal(frameIndexAt(m, d.durationMs + 99999), d.frameCount - 1);
    }
  }
});

function sweep(m: StudyMotion, speed: 0.25 | 1, ticks: number, dt = 16): { frames: number[]; end: Clock } {
  const total = studyTotal(m);
  let c: Clock = setSpeed(initialClock(true), speed);
  const frames = [studyPoseAt(m, c.elapsed).frame];
  for (let i = 0; i < ticks && c.playing; i++) {
    c = advance(c, dt, total);
    frames.push(studyPoseAt(m, c.elapsed).frame);
  }
  return { frames, end: c };
}

test('時計: 通常でも0.25倍でもポーズを飛ばさず、全コマを通って終端で止まる。止めた時計は動かず、速度変更で絵は変わらない', () => {
  for (const m of ['stretch', 'down', 'up'] as const) {
    const n = STUDY_MOTIONS[m].frameCount;
    for (const speed of [1, 0.25] as const) {
      const { frames, end } = sweep(m, speed, 100000);
      assert.equal(end.playing, false, `${m}@${speed} は終端で止まる`);
      assert.equal(end.elapsed, STUDY_MOTIONS[m].durationMs);
      assert.equal(frames[0], 0);
      assert.equal(frames[frames.length - 1], n - 1);
      for (let i = 1; i < frames.length; i++) assert.ok(frames[i]! - frames[i - 1]! === 0 || frames[i]! - frames[i - 1]! === 1, `${m}@${speed} コマ飛び ${frames[i - 1]}→${frames[i]}`);
      assert.equal(new Set(frames).size, n, `${m}@${speed} の全コマを通る`);
    }
  }
  // 歩く: 3周期ぶん進めても (周期内で) 飛ばない
  const w = sweep('walk', 1, 400);
  for (let i = 1; i < w.frames.length; i++) assert.ok((w.frames[i]! - w.frames[i - 1]! + 30) % 30 <= 1);
  assert.equal(new Set(w.frames).size, 30);
  // 停止中は時刻もポーズも不変。再開しても同じ絵から
  const mid: Clock = { elapsed: 1234, playing: true, speed: 1 };
  const paused = togglePlay(mid, 3200);
  assert.equal(paused.playing, false);
  assert.equal(advance(paused, 5000, 3200), paused);
  assert.equal(key(studyPoseAt('stretch', paused.elapsed)), key(studyPoseAt('stretch', mid.elapsed)));
  // 速度を変えても経過時刻・絵は変わらない（位相が飛ばない）
  const slow = setSpeed(mid, 0.25);
  assert.equal(slow.elapsed, mid.elapsed);
  assert.equal(key(studyPoseAt('down', slow.elapsed)), key(studyPoseAt('down', mid.elapsed)));
  // 実時間が同じなら 0.25倍はちょうど1/4（位相がずれない）
  let a: Clock = initialClock(true);
  let b: Clock = setSpeed(initialClock(true), 0.25);
  for (let i = 0; i < 100; i++) {
    a = advance(a, 16, 1e9);
    b = advance(b, 16, 1e9);
  }
  assert.equal(b.elapsed * 4, a.elapsed);
});

test('寝入りと起きるは別シート・別枚数・別の秒数。起きるは寝入りの逆再生ではなく、自分のコマを0→最後へ進む', () => {
  const down = STUDY_MOTIONS.down;
  const up = STUDY_MOTIONS.up;
  assert.notEqual(down.sheet, up.sheet);
  assert.notEqual(manifest.atlases[down.sheet].file, manifest.atlases[up.sheet].file);
  assert.notEqual(manifest.atlases[down.sheet].sha256, manifest.atlases[up.sheet].sha256);
  assert.equal(down.frameCount, 24);
  assert.equal(up.frameCount, 30);
  assert.notEqual(down.durationMs, up.durationMs);
  // 起きるを頭から終わりへ再生すると 0..29 の昇順。寝入りは 0..23 の昇順で、互いのコマ列を共有しない
  const seq = (m: StudyMotion) => Array.from({ length: STUDY_MOTIONS[m].frameCount }, (_, i) => studyPoseAt(m, frameStartMs(m, i)));
  assert.deepEqual(seq('up').map((p) => [p.sheet, p.frame]), Array.from({ length: 30 }, (_, i) => ['up', i]));
  assert.deepEqual(seq('down').map((p) => [p.sheet, p.frame]), Array.from({ length: 24 }, (_, i) => ['down', i]));
});

test('歩行: 片道は整数周期で、1周期の移動は可視幅(90論理px)の 14/90 倍。折返しは休んでから。移動中に反転せず、位置は連続', () => {
  const plan = studyWalkPlan();
  assert.ok(Number.isInteger(plan.cycles) && plan.cycles >= 1);
  assert.equal(plan.cycleMs, 1800);
  assert.equal(plan.legMs, plan.cycles * plan.cycleMs, '片道は整数周期');
  assert.equal(plan.slotMs, plan.legMs + plan.restMs);
  assert.equal(WALK_V4_STRIDE_PX, 14);
  assert.equal(WALK_V4_REFERENCE_WIDTH, 90);
  assert.ok(Math.abs(plan.stride / STUDY_WALK.bodyRatio - WALK_V4_STRIDE_PX / WALK_V4_REFERENCE_WIDTH) < 1e-12, '1周期=14論理px/基準幅90px');
  assert.ok(Math.abs((plan.xMax - plan.xMin) - plan.stride * plan.cycles) < 1e-12);
  // 体(可視幅の23%)が部屋の内側に収まる
  assert.ok(plan.xMin - STUDY_WALK.bodyRatio / 2 > 0 && plan.xMax + STUDY_WALK.bodyRatio / 2 < 1);
  // 1周期ぶん進むとちょうど stride
  const a = walkPoseAt(0);
  const b = walkPoseAt(plan.cycleMs);
  assert.ok(Math.abs(Math.abs(a.x - b.x) - plan.stride) < 1e-9);
  assert.equal(a.facing, 'left');
  assert.equal(a.x, plan.xMax);
  // 片道の終わりで止まり、休みは idle の1コマ（浮足を接地させた4脚立ち）。向きは休みの後半で変わり、歩き出す前に済んでいる
  const endLeg = walkPoseAt(plan.legMs);
  assert.equal(endLeg.moving, false);
  assert.equal(endLeg.sheet, 'walkV4Settle', '休みは足を下げる6枚から');
  assert.equal(endLeg.frame, 0);
  assert.equal(endLeg.x, plan.xMin);
  assert.equal(endLeg.facing, 'left');
  // 休み1500ms: 最初の240msは settle 0..5（40ms刻み）、最後の240msは start 0..5、その間は idle。位置は休み中動かない
  const at = (rr: number) => walkPoseAt(plan.legMs + rr);
  for (let i = 0; i < 6; i++) {
    assert.deepEqual([at(i * 40).sheet, at(i * 40).frame], ['walkV4Settle', i]);
    assert.deepEqual([at(i * 40 + 39).sheet, at(i * 40 + 39).frame], ['walkV4Settle', i]);
    const s = plan.restMs - 240 + i * 40;
    assert.deepEqual([at(s).sheet, at(s).frame], ['walkV4Start', i]);
    assert.deepEqual([at(s + 39).sheet, at(s + 39).frame], ['walkV4Start', i]);
  }
  assert.deepEqual([at(240).sheet, at(240).frame], [STAND_SHEET, STAND_FRAME]);
  assert.deepEqual([at(plan.restMs - 241).sheet, at(plan.restMs - 241).frame], [STAND_SHEET, STAND_FRAME]);
  for (let rr = 0; rr < plan.restMs; rr += 20) assert.equal(at(rr).x, plan.xMin, `休み中に動いた @${rr}`);
  assert.equal(at(239).facing, 'left', 'settle は元の向き');
  assert.equal(at(plan.restMs - 240).facing, 'right', 'start は次の向き（反転は中間の idle だけ）');
  assert.equal(at(plan.restMs / 2 - 1).sheet, STAND_SHEET);
  const lateRest = walkPoseAt(plan.slotMs - 1);
  assert.equal(lateRest.moving, false);
  assert.equal(lateRest.facing, 'right');
  const back = walkPoseAt(plan.slotMs + 1);
  assert.equal(back.moving, true);
  assert.equal(back.sheet, 'walkV4');
  assert.equal(back.facing, 'right');
  assert.equal(back.frame, 0, '片道の頭は歩行の0番');
  // 全サンプルで: 範囲内・連続・反転は止まっている間だけ・移動中は歩行シート/休みは立ち姿
  const dt = 5;
  const maxStep = (plan.stride / plan.cycleMs) * dt + 1e-9;
  const used = new Set<number>();
  let prev = walkPoseAt(0);
  for (let t = dt; t < plan.slotMs * 4; t += dt) {
    const s = walkPoseAt(t);
    assert.ok(s.x >= plan.xMin - 1e-9 && s.x <= plan.xMax + 1e-9);
    assert.equal(s.y, STUDY_WALK.y);
    assert.ok(Math.abs(s.x - prev.x) <= maxStep, `瞬間移動 @${t}`);
    if (s.facing !== prev.facing) assert.ok(!s.moving && !prev.moving, `移動中に反転 @${t}`);
    if (s.moving) {
      assert.equal(s.sheet, 'walkV4');
      assert.ok(s.frame >= 0 && s.frame <= 29);
      used.add(s.frame);
    } else {
      assert.ok(['walkV4Settle', 'walkV4Idle', 'walkV4Start'].includes(s.sheet), `休みのシート ${s.sheet}`);
      assert.ok(s.frame >= 0 && s.frame <= 5);
      if (s.sheet === STAND_SHEET) assert.equal(s.frame, STAND_FRAME);
    }
    prev = s;
  }
  assert.equal(used.size, 30);
});

test('1コマ送り/戻し: 飛ばさず両端で止まる。歩行は休みの立ち姿と向き替えも1手ずつ', () => {
  for (const m of ['stretch', 'down', 'up'] as const) {
    const n = STUDY_MOTIONS[m].frameCount;
    const total = studyTotal(m);
    let c: Clock = initialClock(false);
    const seen = [studyPoseAt(m, c.elapsed).frame];
    for (let i = 0; i < n + 3; i++) {
      c = seekClock(c, stepStudy(m, c.elapsed, 1), total);
      seen.push(studyPoseAt(m, c.elapsed).frame);
    }
    assert.deepEqual(seen.slice(0, n), Array.from({ length: n }, (_, i) => i), `${m} 進む`);
    assert.ok(seen.slice(n).every((f) => f === n - 1), `${m} 終端で止まる`);
    for (let i = 0; i < n + 3; i++) c = seekClock(c, stepStudy(m, c.elapsed, -1), total);
    assert.equal(studyPoseAt(m, c.elapsed).frame, 0, `${m} 先頭で止まる`);
    // 終端(elapsed=total)から戻すと1つ前のコマ
    const atEnd = seekClock(c, total, total);
    assert.equal(studyPoseAt(m, stepStudy(m, atEnd.elapsed, -1)).frame, n - 2);
    // 途中で止めたあとの前/次も、見えているコマの隣
    const mid = frameStartMs(m, 3) + frameMs(m) * 0.4;
    assert.equal(studyPoseAt(m, stepStudy(m, mid, 1)).frame, 4);
    assert.equal(studyPoseAt(m, stepStudy(m, mid, -1)).frame, 2);
  }
  // 歩行: 2スロットぶん進めて、毎回「見える状態」が変わり、歩行コマは1ずつ進む
  const plan = studyWalkPlan();
  // 歩行コマ + settle 6 + idle 1 + 向き替え 1 + start 6
  const perSlot = plan.cycles * 30 + 14;
  assert.equal(walkBounds(plan).length, perSlot);
  const bounds = walkBounds(plan);
  assert.ok(bounds.every((b, i) => i === 0 || b > bounds[i - 1]!), '区切りは昇順・重複なし');
  assert.ok(bounds.every((b) => b < plan.slotMs));
  let t = 0;
  let prev = walkPoseAt(t);
  const seen = [key(prev)];
  const stands: string[] = [];
  for (let i = 0; i < perSlot * 2 + 1; i++) {
    t = stepStudy('walk', t, 1);
    const p = walkPoseAt(t);
    assert.notEqual(key(p), key(prev), `絵が変わらない @${t}`);
    if (p.moving && prev.moving) assert.equal(p.frame, (prev.frame + 1) % 30);
    if (!p.moving) stands.push(key(p));
    seen.push(key(p));
    prev = p;
  }
  // 休みで見える絵は、settle 6枚 → idle（元の向き）→ idle（次の向き）→ start 6枚（片道ごと。6姿勢をコマ送りで個別に見られる）
  const six = (sheet: string, facing: string) => Array.from({ length: 6 }, (_, i) => `${sheet}:${i}:${facing}`);
  assert.deepEqual(stands.slice(0, 14), [...six('walkV4Settle', 'left'), 'walkV4Idle:0:left', 'walkV4Idle:0:right', ...six('walkV4Start', 'right')]);
  assert.deepEqual(stands.slice(14, 28), [...six('walkV4Settle', 'right'), 'walkV4Idle:0:right', 'walkV4Idle:0:left', ...six('walkV4Start', 'left')]);
  // 戻しは進めた道を逆にたどる
  for (let i = seen.length - 2; i >= 0; i--) {
    t = stepStudy('walk', t, -1);
    assert.equal(key(walkPoseAt(t)), seen[i], `戻し #${i}`);
  }
  assert.equal(stepStudy('walk', 0, -1), 0);
});

test('歩く以外は固定位置。部屋の倍率は各シートの基準幅が部屋幅の23%、拡大は全コマが枠に収まる共通倍率', () => {
  for (const m of ['stretch', 'down', 'up'] as const) {
    for (const t of [0, 500, 1500, 99999]) {
      const p = studyPoseAt(m, t);
      assert.equal(p.x, STUDY_FIXED.x);
      assert.equal(p.y, STUDY_FIXED.y);
      assert.equal(p.facing, 'left');
      assert.equal(p.moving, false);
    }
  }
  for (const S of [320, 340, 420]) {
    for (const k of ['walk', 'stretch', 'down', 'up']) {
      const a = manifest.atlases[k];
      const s = roomScale(S, a.referenceWidth);
      assert.ok(Math.abs((a.referenceWidth * s) / S - 0.23) < 1e-12, `${k}@${S}`);
    }
  }
  for (const k of ['keys', 'walk', 'stretch', 'down', 'up']) {
    const a = manifest.atlases[k];
    for (const [w, h] of [[316, 260], [140, 120]]) {
      const s = fitScale(a, w!, h!);
      const e = extentAt(a, s);
      assert.ok(e.w <= w! + 1e-9 && e.h <= h! + 1e-9, `${k} が枠に収まる`);
      assert.ok(Math.abs(e.w - w!) < 1e-9 || Math.abs(e.h - h!) < 1e-9, `${k} はどちらかの辺に接する最大倍率`);
    }
  }
});

test('足運びの設計データ: 接地 LH0/LF25/RH50/RF75%、支持65%・運び35%。支持と運びで周期を過不足なく覆い、常に2〜3脚が支持', () => {
  assert.deepEqual(GAIT_DESIGN.touchdownPct, { LH: 0, LF: 25, RH: 50, RF: 75 });
  assert.equal(GAIT_DESIGN.supportPct, 65);
  assert.equal(GAIT_DESIGN.swingPct, 35);
  assert.equal(GAIT_DESIGN.supportPct + GAIT_DESIGN.swingPct, 100);
  for (const leg of LEGS) {
    const sum = (segs: [number, number][]) => segs.reduce((a, [s, e]) => a + (e - s), 0);
    assert.equal(sum(supportSegments(leg)), 65, leg);
    assert.equal(sum(swingSegments(leg)), 35, leg);
    // 接地の瞬間は支持の頭、その直前は運びの最後
    assert.equal(isSupport(leg, GAIT_DESIGN.touchdownPct[leg]), true);
    assert.equal(isSupport(leg, GAIT_DESIGN.touchdownPct[leg] - 0.01), false);
  }
  // 右前の支持は周期の終わりをまたぐ [75,100] と [0,40]
  assert.deepEqual(supportSegments('RF'), [[75, 100], [0, 40]]);
  for (let p = 0; p < 100; p += 0.5) {
    const n = supportCount(p);
    assert.ok(n >= 2 && n <= 3, `${p}% で支持 ${n}脚`);
  }
  // 接地の順は 左後→左前→右後→右前
  const order = [...LEGS].sort((a, b) => GAIT_DESIGN.touchdownPct[a] - GAIT_DESIGN.touchdownPct[b]);
  assert.deepEqual(order, ['LH', 'LF', 'RH', 'RF']);
});

test('拡大の倍率(中央): 足元を中央に置き左右反転しても、全コマの左右が枠から出ない（合成atlas・素材不要）', () => {
  // 尾が左へ長いコマ(anchor 40/幅 50)と、右へ長いコマ(anchor 5/幅 50)。反転しても片側の最大幅 45 が半幅
  const a = { frames: [{ rect: [0, 0, 50, 30], anchor: [40, 30] }, { rect: [50, 0, 50, 24], anchor: [5, 24] }] };
  assert.equal(anchorHalfWidth(a), 45);
  const s = fitScaleCentered(a, 180, 1000);
  assert.ok(Math.abs(s - 2) < 1e-12, '幅が効く: 180/(2*45)');
  for (const f of a.frames) {
    const w = f.rect[2]!;
    const ax = f.anchor[0]!;
    for (const flip of [false, true]) {
      const left = 90 - (flip ? w - ax : ax) * s;
      assert.ok(left >= -1e-9 && left + w * s <= 180 + 1e-9, `anchor ${ax} flip ${flip}`);
    }
  }
  assert.ok(Math.abs(fitScaleCentered(a, 1000, 60) - 2) < 1e-12, '高さが効く: 60/30');
});

test('v4 全身の歩き: 枚数30・1800ms・連番・矩形がPNG内（親が manifest を置くまで受領待ち）', { skip: SKIP_V4 }, () => {
  const a = walkV4;
  assert.equal(a.frameCount, WALK_V4_FRAMES);
  assert.equal(a.durationMs, WALK_V4_DURATION_MS);
  assert.equal(a.frames.length, 30);
  assert.equal(STUDY_MOTIONS.walk.sheet, 'walkV4');
  assert.equal(STUDY_MOTIONS.walk.frameCount, a.frameCount);
  assert.equal(STUDY_MOTIONS.walk.durationMs, a.durationMs);
  assert.ok(a.referenceWidth > 0 && a.width > 0 && a.height > 0);
  a.frames.forEach((f: { index: number; rect: number[]; anchor: number[] }, i: number) => {
    assert.equal(f.index, i);
    const [x, y, w, h] = f.rect as [number, number, number, number];
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= a.width && y + h <= a.height, `v4#${i} 矩形`);
    assert.ok(f.anchor[0]! >= 0 && f.anchor[0]! <= w && f.anchor[1]! >= 0 && f.anchor[1]! <= h, `v4#${i} anchor が矩形内`);
  });
});

test('v4 全身連動の歩き: referenceWidth は部屋の歩幅(14/90)の基準と一致し、休止の1コマと移行6枚ずつは歩行と同じ寸法・anchor・基準幅（受領待ち）', { skip: SKIP_V4 }, () => {
  const a = walkV4;
  const manifestV4 = JSON.parse(readFileSync(V4_URL, 'utf8'));
  for (const k of ['settle', 'start']) {
    const s = manifestV4.atlases[k];
    assert.equal(s.frameCount, 6, k);
    assert.equal(s.frames.length, 6, k);
    assert.equal(s.referenceWidth, a.referenceWidth, k);
    s.frames.forEach((f: { index: number; rect: number[]; anchor: number[] }, i: number) => {
      assert.equal(f.index, i);
      assert.deepEqual(f.rect.slice(2), a.frames[0].rect.slice(2), `${k}#${i} 寸法`);
      assert.deepEqual(f.anchor, a.frames[0].anchor, `${k}#${i} anchor`);
      const [rx, ry, rw, rh] = f.rect as [number, number, number, number];
      assert.ok(rx + rw <= s.width && ry + rh <= s.height, `${k}#${i} 矩形`);
    });
  }
  const idle = manifestV4.atlases.idle;
  assert.equal(a.referenceWidth, WALK_V4_REFERENCE_WIDTH);
  assert.equal(idle.referenceWidth, a.referenceWidth);
  assert.equal(idle.frameCount, 1);
  assert.equal(idle.frames.length, 1);
  const f0 = a.frames[0];
  const fi = idle.frames[0];
  assert.deepEqual(fi.rect.slice(2), f0.rect.slice(2), '休止は歩行と同じ寸法');
  assert.deepEqual(fi.anchor, f0.anchor, '休止は歩行と同じ anchor（足元がずれない）');
  assert.ok(fi.rect[0] + fi.rect[2] <= idle.width && fi.rect[1] + fi.rect[3] <= idle.height);
  // 全コマが同じ寸法・同じ anchor（コマごとの拡縮なし）
  for (const f of a.frames as { rect: number[]; anchor: number[] }[]) {
    assert.deepEqual(f.rect.slice(2), f0.rect.slice(2));
    assert.deepEqual(f.anchor, f0.anchor);
  }
});

test('v4 全身の歩き: 部屋の往復で全コマ・左右反転とも部屋の横幅に収まる／拡大は共通倍率で枠に収まる（受領待ち）', { skip: SKIP_V4 }, () => {
  const a = walkV4;
  const plan = studyWalkPlan();
  for (const S of [320, 375, 420]) {
    const s = roomScale(S, a.referenceWidth);
    const half = anchorHalfWidth(a) * s;
    assert.ok(plan.xMin * S - half >= 0, `左端で尾/頭が切れる @${S}`);
    assert.ok(plan.xMax * S + half <= S, `右端で尾/頭が切れる @${S}`);
  }
  for (const [w, h] of [[316, 260], [140, 120]]) {
    const s = fitScaleCentered(a, w!, h!);
    assert.ok(2 * anchorHalfWidth(a) * s <= w! + 1e-9 && extentAt(a, s).h <= h! + 1e-9);
  }
});
