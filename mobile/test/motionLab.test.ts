import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commonScale } from '../src/ui/motionSeq.ts';
import {
  LEAD_MS, MAX_DT_MS, MOTION_ORDER, TAIL_MS, WALK, WALK_FRAME_MS, advance, buildTrack, compareBounds, extentAt, fitFrame0Height, frameAt, inPlaceFrame,
  initialClock, nextBoundary, phaseAt, prevBoundary, restartClock, scaleFromFrame0, seekClock, setSpeed, stageHeightFor, togglePlay, walkAt, walkPlan,
  walkStepTime, type Clock,
} from '../src/ui/motionLab.ts';

const m30 = JSON.parse(readFileSync(new URL('../../design-assets/motion30/manifest.json', import.meta.url), 'utf8'));
const m12 = JSON.parse(readFileSync(new URL('../../design-assets/motion-v2/manifest.json', import.meta.url), 'utf8'));

test('比較: 両版の合計時間が一致（前1000＋動作＋後1500）。動作の長さは まばたき300 / 伸び750 / 寝起き6400', () => {
  const expectMotion = { blink: 300, stretch: 750, sleep: 6400 } as const;
  for (const m of MOTION_ORDER) {
    const o = buildTrack(m, 'old');
    const n = buildTrack(m, 'new');
    assert.equal(o.total, n.total, m);
    assert.equal(o.motionStart, LEAD_MS);
    assert.equal(n.motionStart, LEAD_MS);
    assert.equal(o.motionEnd - o.motionStart, expectMotion[m]);
    assert.equal(n.motionEnd - n.motionStart, expectMotion[m]);
    assert.equal(o.total, LEAD_MS + expectMotion[m] + TAIL_MS);
    assert.equal(n.total, o.total);
  }
});

test('比較: 指定の姿勢の並びと時間（旧[1,2,3]/[4,5,6,5,7]/寝起き、新[1..4]/[5..14]/寝起き並べ替え）', () => {
  const seq = (m: Parameters<typeof buildTrack>[0], v: 'old' | 'new') => buildTrack(m, v).segs.map((s) => s.frame);
  assert.deepEqual(seq('blink', 'old'), [0, 1, 2, 3, 0]);
  assert.deepEqual(seq('blink', 'new'), [0, 1, 2, 3, 4, 0]);
  assert.deepEqual(seq('stretch', 'old'), [0, 4, 5, 6, 5, 7, 0]);
  assert.deepEqual(seq('stretch', 'new'), [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0]);
  assert.deepEqual(seq('sleep', 'old'), [0, 8, 9, 10, 11, 10, 9, 8, 0]);
  assert.deepEqual(seq('sleep', 'new'), [0, 15, 16, 17, 18, 19, 20, 21, 22, 26, 27, 25, 23, 24, 28, 29, 0]);
  // 各コマの表示時間
  assert.ok(buildTrack('blink', 'old').segs.slice(1, 4).every((s) => s.ms === 100));
  assert.ok(buildTrack('blink', 'new').segs.slice(1, 5).every((s) => s.ms === 75));
  assert.ok(buildTrack('stretch', 'old').segs.slice(1, 6).every((s) => s.ms === 150));
  assert.ok(buildTrack('stretch', 'new').segs.slice(1, 11).every((s) => s.ms === 75));
  const so = buildTrack('sleep', 'old').segs;
  const sn = buildTrack('sleep', 'new').segs;
  assert.deepEqual(so.map((s) => s.ms), [1000, 150, 150, 150, 5500, 150, 150, 150, 1500]);
  assert.deepEqual(sn.map((s) => s.ms), [1000, 75, 75, 75, 75, 75, 75, 5500, 56.25, 56.25, 56.25, 56.25, 56.25, 56.25, 56.25, 56.25, 1500]);
  // 寝入りと起床は各450ms
  assert.equal(sn.slice(1, 7).reduce((a, s) => a + s.ms, 0), 450);
  assert.equal(sn.slice(8, 16).reduce((a, s) => a + s.ms, 0), 450);
});

test('比較: 同じ経過時刻なら両版とも同じ動作区間（前/動作/保持/後）。保持5500msも同じ窓', () => {
  for (const m of MOTION_ORDER) {
    const o = buildTrack(m, 'old');
    const n = buildTrack(m, 'new');
    for (let t = 0; t <= o.total + 50; t += 25) assert.equal(phaseAt(o, t), phaseAt(n, t), `${m}@${t}`);
    assert.deepEqual(o.hold, n.hold);
  }
  assert.deepEqual(buildTrack('sleep', 'old').hold, [1450, 6950]);
  assert.equal(buildTrack('blink', 'old').hold, null);
  // 動作前1000msと動作後1500msは両版とも立ち姿(0)
  for (const m of MOTION_ORDER) for (const v of ['old', 'new'] as const) {
    const tr = buildTrack(m, v);
    assert.equal(frameAt(tr, 0), 0);
    assert.equal(frameAt(tr, 999.9), 0);
    assert.equal(frameAt(tr, tr.motionEnd), 0);
    assert.equal(frameAt(tr, tr.total + 5000), 0);
    assert.equal(frameAt(tr, -10), 0);
    assert.notEqual(frameAt(tr, LEAD_MS), 0);
  }
  // 眠りの保持中は 11(旧) / 21(新)
  assert.equal(frameAt(buildTrack('sleep', 'old'), 3000), 11);
  assert.equal(frameAt(buildTrack('sleep', 'new'), 3000), 21);
});

test('比較: 全コマ番号が範囲内（旧0–11・新0–29）。新30は0–29の全姿勢を使い、旧12も全姿勢を使う', () => {
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  for (const m of MOTION_ORDER) {
    buildTrack(m, 'old').segs.forEach((s) => usedOld.add(s.frame));
    buildTrack(m, 'new').segs.forEach((s) => usedNew.add(s.frame));
  }
  assert.deepEqual([...usedOld].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
  assert.deepEqual([...usedNew].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i));
  assert.equal(m12.atlases.apricot.frames.length, 12);
  assert.equal(m30.atlases.apricot30.frames.length, 30);
  assert.equal(m30.atlases.walk.frames.length, 12);
});

test('時計: 停止中は時刻が進まない／速度を変えても位相が飛ばない／終端で止まる／大きな隙間は上限で丸める', () => {
  const total = 2800;
  let c: Clock = initialClock(true);
  c = advance(c, 16, total);
  assert.equal(c.elapsed, 16);
  const paused = togglePlay(c, total);
  assert.equal(paused.playing, false);
  assert.equal(advance(paused, 5000, total), paused, '停止中は不変');
  // 0.25倍
  const slow = setSpeed(c, 0.25);
  assert.equal(slow.elapsed, c.elapsed, '速度変更で時刻は変わらない');
  assert.equal(advance(slow, 80, total).elapsed, 16 + 20);
  // 隙間の丸め（非表示から戻った直後）
  assert.equal(advance(initialClock(true), 60_000, total).elapsed, MAX_DT_MS);
  // 終端で止まる（total を超えない）
  let e: Clock = { elapsed: total - 10, playing: true, speed: 1 };
  e = advance(e, 50, total);
  assert.equal(e.elapsed, total);
  assert.equal(e.playing, false);
  // 終端から再生を押すと最初から
  assert.equal(togglePlay(e, total).elapsed, 0);
  assert.equal(togglePlay(e, total).playing, true);
  // はじめから
  assert.equal(restartClock({ elapsed: 900, playing: false, speed: 0.25 }, true).elapsed, 0);
  assert.equal(restartClock({ elapsed: 900, playing: true, speed: 1 }, false).playing, false, 'reduce-motion時は再生しない');
  // 実時間16msx1000回を 1倍と0.25倍で比べ、0.25倍はちょうど1/4（位相がずれない）
  let a: Clock = initialClock(true);
  let b: Clock = setSpeed(initialClock(true), 0.25);
  for (let i = 0; i < 100; i++) {
    a = advance(a, 16, 1e9);
    b = advance(b, 16, 1e9);
  }
  assert.equal(b.elapsed * 4, a.elapsed);
});

test('コマ送り/スクラブ: 両版の切り替わり時刻を順に進み、戻れて、端で止まる。時刻を決めると両側が同じ時刻の絵になる', () => {
  for (const m of MOTION_ORDER) {
    const o = buildTrack(m, 'old');
    const n = buildTrack(m, 'new');
    const bounds = compareBounds(o, n);
    assert.equal(bounds[0], 0);
    assert.equal(bounds[bounds.length - 1], o.total);
    for (let i = 1; i < bounds.length; i++) assert.ok(bounds[i]! > bounds[i - 1]!);
    // 進むと必ず昇順で、少なくとも片側の絵が変わる
    let t = 0;
    let steps = 0;
    while (t < o.total) {
      const nt = nextBoundary(bounds, t);
      assert.ok(nt > t);
      // 終端以外の止まる時刻では、少なくとも片側の絵が変わる
      if (nt < o.total) assert.ok(frameAt(o, nt) !== frameAt(o, t) || frameAt(n, nt) !== frameAt(n, t), `${m}: ${t}→${nt} で絵が変わらない`);
      assert.equal(prevBoundary(bounds, nt), t, '戻すと元の時刻');
      t = nt;
      steps++;
    }
    assert.equal(steps, bounds.length - 1);
    assert.equal(nextBoundary(bounds, o.total), o.total, '終端で止まる');
    assert.equal(prevBoundary(bounds, 0), 0, '先頭で止まる');
    // スクラブ: 範囲外は丸め、操作中は止まる
    const s = seekClock({ elapsed: 0, playing: true, speed: 1 }, o.total + 999, o.total);
    assert.equal(s.elapsed, o.total);
    assert.equal(s.playing, false);
    assert.equal(seekClock(s, -5, o.total).elapsed, 0);
    // 同じ経過時間 → 同じ区間の絵（時刻をひとつ決めれば両枠が決まる）
    const mid = o.motionStart + 10;
    assert.equal(phaseAt(o, mid), phaseAt(n, mid));
  }
  // 新30の1コマ送りは、まばたきの中で旧より細かい（75ms刻みと100ms刻み）
  const bb = compareBounds(buildTrack('blink', 'old'), buildTrack('blink', 'new'));
  assert.ok(bb.includes(1075) && bb.includes(1100));
});

test('表示: 旧12と新30は0番(立ち姿)の全身高さが同じになる倍率。atlas内は全コマ同倍率で、全コマが枠と stage に余白つきで収まる', () => {
  const oldA = m12.atlases.apricot;
  const newA = m30.atlases.apricot30;
  const walkA = m30.atlases.walk;
  for (const paneW of [150, 158, 171, 200, 240]) {
    const maxW = paneW - 8;
    const h0 = Math.floor(fitFrame0Height([oldA, newA], maxW));
    const sOld = scaleFromFrame0(oldA, h0);
    const sNew = scaleFromFrame0(newA, h0);
    // 0番の高さが旧新で一致（足元は anchor=[w/2,h] で同じ y）
    assert.ok(Math.abs(oldA.frames[0].rect[3] * sOld - h0) < 1e-9);
    assert.ok(Math.abs(newA.frames[0].rect[3] * sNew - h0) < 1e-9);
    assert.ok(Math.abs(oldA.frames[0].rect[3] * sOld - newA.frames[0].rect[3] * sNew) < 1e-9);
    // 全コマが枠の幅に収まり、stage に上下12px以上の余白で収まる
    assert.ok(extentAt(oldA, sOld).w <= maxW + 1e-9 && extentAt(newA, sNew).w <= maxW + 1e-9);
    const stage = stageHeightFor([oldA, newA], h0, 12);
    assert.ok(stage - 24 >= extentAt(oldA, sOld).h - 1e-9 && stage - 24 >= extentAt(newA, sNew).h - 1e-9);
  }
  // その場歩行: 最大高さ(299)×倍率が stage-24 以内（広い画面でも尾の上端が切れない）
  for (const w of [150, 170, 300, 420]) {
    const h0 = Math.floor(fitFrame0Height([walkA], w));
    const s = scaleFromFrame0(walkA, h0);
    assert.ok(extentAt(walkA, s).h + 24 <= stageHeightFor([walkA], h0, 12));
    assert.ok(extentAt(walkA, s).w <= w + 1e-9);
  }
  // 部屋の歩行: 旧0番(立ち止まり)と歩行0番が同じ高さ
  const sRoomOld = 0.23 * 351 / oldA.referenceWidth;
  const sRoomWalk = scaleFromFrame0(walkA, oldA.frames[0].rect[3] * sRoomOld);
  assert.ok(Math.abs(walkA.frames[0].rect[3] * sRoomWalk - oldA.frames[0].rect[3] * sRoomOld) < 1e-9);
  // 歩行の可視幅は部屋の23%前後（過大・過小でない）
  const visible = walkA.referenceWidth * sRoomWalk / 351;
  assert.ok(visible > 0.2 && visible < 0.26, `歩行の可視幅 ${visible}`);
  // 旧版の既存の共通倍率は変更していない
  assert.ok(Math.abs(commonScale(oldA, 100) * oldA.referenceWidth - 100) < 1e-9);
});

test('素材の整合: 各コマの矩形がシート内・anchorが下端中央・インデックス連番', () => {
  for (const key of ['apricot30', 'walk']) {
    const a = m30.atlases[key];
    a.frames.forEach((f: { index: number; rect: number[]; anchor: number[] }, i: number) => {
      assert.equal(f.index, i);
      const [x, y, w, h] = f.rect as [number, number, number, number];
      assert.ok(x >= 0 && y >= 0 && x + w <= a.width && y + h <= a.height, `${key}#${i}`);
      assert.deepEqual(f.anchor, [w / 2, h]);
    });
  }
  assert.equal(m30.atlases.apricot30.width, 1024);
  assert.equal(m30.atlases.apricot30.height, 1536);
  assert.equal(m30.atlases.walk.width, 1536);
  assert.equal(m30.atlases.walk.height, 1024);
});

test('歩行: 1周期1200msで12コマ、距離は体幅の0.25〜0.35／周期、歩行帯と可動域の内側', () => {
  const plan = walkPlan();
  assert.equal(WALK.cycleMs, 1200);
  assert.equal(WALK_FRAME_MS, 100);
  const strideBody = plan.stride / WALK.bodyRatio;
  assert.ok(strideBody >= 0.25 && strideBody <= 0.35, `体幅比 ${strideBody}`);
  assert.equal(plan.legMs, plan.cycles * 1200, '片道は整数周期');
  // 1周期（1200ms）で進む距離 = stride
  const a = walkAt(0);
  const b = walkAt(1200);
  assert.ok(Math.abs(Math.abs(a.x - b.x) - plan.stride) < 1e-9);
  // 全周期の全サンプルで範囲内、コマは0–11、片道で12コマすべてを使う
  const used = new Set<number>();
  for (let t = 0; t < plan.slotMs * 4; t += 7) {
    const s = walkAt(t);
    assert.ok(s.x >= WALK.xMin - 1e-9 && s.x <= WALK.xMax + 1e-9, `x ${s.x}@${t}`);
    assert.equal(s.y, 0.86, 'ラベンダー(.66)・クリーム(.64)の手前の床');
    assert.ok(Number.isInteger(s.frame) && s.frame >= 0 && s.frame <= 11);
    if (s.moving) used.add(s.frame);
  }
  assert.equal(used.size, 12);
  // 体の可視幅(部屋の23%)が歩行帯の中心 .25〜.75 で部屋の内側(0〜1)に収まる
  assert.equal(WALK.xMin, 0.3);
  assert.equal(WALK.xMax, 0.7);
  assert.ok(WALK.xMin - WALK.bodyRatio / 2 > 0 && WALK.xMax + WALK.bodyRatio / 2 < 1);
});

test('歩行: 止まると足も止まり、休んでから折り返す。反転は停止中だけ。位置は連続（瞬間移動しない）', () => {
  const plan = walkPlan();
  let prev = walkAt(0);
  const dtStep = 5;
  const maxStep = (plan.stride / WALK.cycleMs) * dtStep + 1e-9; // 1サンプルで進める最大距離
  for (let t = dtStep; t < plan.slotMs * 6; t += dtStep) {
    const s = walkAt(t);
    assert.ok(Math.abs(s.x - prev.x) <= maxStep, `瞬間移動 @${t}`);
    if (s.facing !== prev.facing) assert.ok(!s.moving && !prev.moving, `歩行中に反転 @${t}`);
    if (!s.moving) {
      assert.equal(s.frame, 0, '止まれば足も止まる');
      assert.equal(s.x, prev.moving ? s.x : prev.x, '休み中は動かない');
    }
    prev = s;
  }
  // 端で止まり、休み（restMs）を挟んでから反対へ歩き出す。左向きは原画の向き、右向きは反転
  assert.equal(walkAt(0).facing, 'left');
  assert.equal(walkAt(0).x, WALK.xMax);
  const endLeft = walkAt(plan.legMs);
  assert.equal(endLeft.moving, false);
  assert.equal(endLeft.x, WALK.xMin);
  assert.equal(walkAt(plan.legMs + WALK.restMs - 1).moving, false);
  assert.equal(walkAt(plan.legMs + WALK.restMs - 1).facing, 'right', '歩き出す前に向きは変わっている');
  const back = walkAt(plan.slotMs + 1);
  assert.equal(back.moving, true);
  assert.equal(back.facing, 'right');
  assert.ok(back.x > WALK.xMin);
  // 折り返して右端で止まり、再び左へ
  assert.equal(walkAt(plan.slotMs + plan.legMs).x, WALK.xMax);
  assert.equal(walkAt(plan.slotMs * 2 + 1).facing, 'left');
});

test('歩行: 停止した時計では距離もコマも変わらない。その場の歩行と部屋の歩行は同じ時間から決まる', () => {
  const c = { elapsed: 3400, playing: false, speed: 1 as const };
  const frozen = advance(c, 5000, Infinity);
  assert.equal(frozen, c);
  assert.deepEqual(walkAt(frozen.elapsed), walkAt(c.elapsed));
  assert.equal(inPlaceFrame(frozen.elapsed), inPlaceFrame(c.elapsed));
  // 移動中は部屋のコマ番号とその場のコマ番号が同じ時刻で一致（片道の頭から数える）
  const s = walkAt(2500);
  assert.equal(s.moving, true);
  assert.equal(s.frame, inPlaceFrame(2500));
  // 歩行のコマ送りは100msごと。端で止まる
  assert.equal(walkStepTime(0, 1), 100);
  assert.equal(walkStepTime(150, 1), 200);
  assert.equal(walkStepTime(150, -1), 100);
  assert.equal(walkStepTime(300, -1), 200);
  assert.equal(walkStepTime(0, -1), 0);
  // 0.25倍でも位置は共通時間から求まるだけ（位相が飛ばない）
  let a = { elapsed: 0, playing: true, speed: 1 as const } as Clock;
  let b = setSpeed(a, 0.25);
  for (let i = 0; i < 40; i++) {
    a = advance(a, 16, Infinity);
    b = advance(b, 16, Infinity);
  }
  assert.ok(Math.abs(walkAt(a.elapsed).x - walkAt(b.elapsed * 4).x) < 1e-9);
});
