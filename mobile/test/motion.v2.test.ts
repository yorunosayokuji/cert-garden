import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHARACTERS } from '../src/state/characters.ts';
import { FLOOR_POLYGON, defOf, footprintRect, starterLayout } from '../src/state/furniture.ts';
import {
  CANVAS, Walker, clipOf, fittedRect, frameAt, freeIntervals, intervalOf, nearestFree, parseCatalog, spanAt, spriteRect, strideWeights,
  type CharMotion, type Env, type Rect, type WalkerState,
} from '../src/state/roomMotion.ts';

const ROOT = new URL('../../', import.meta.url);
const raw = JSON.parse(readFileSync(new URL('design-assets/app-completion-20261020/runtime-motion-catalog-v2.json', ROOT), 'utf8')) as unknown;
const catalog = parseCatalog(raw);
const byId = new Map(catalog.characters.map((c) => [c.id, c]));
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const obstaclesOf = (layout = starterLayout()): Rect[] =>
  layout.placed.flatMap((p) => {
    const d = defOf(p.id)!;
    if (d.layer === 'floor') return [];
    const [l, t, r, b] = footprintRect(d, p.x, p.y);
    return [{ l, t, r, b }];
  });

test('索引: 全26体が揃い、待機と左右の歩きを持ち、参照する全コマの画像が実在し、読み込む範囲の規則に合う', () => {
  assert.equal(catalog.characters.length, 26);
  assert.deepEqual(catalog.characters.map((c) => c.id).sort(), CHARACTERS.map((c) => c.id).sort());
  let refs = 0;
  const src = read('../src/ui/motionCatalog.ts');
  const m = /require\.context\(\s*'[^']+',\s*true,\s*(\/\^.*\/),?\s*\)/s.exec(src);
  assert.ok(m, 'require.context の正規表現を読み取れる');
  const re = new RegExp(m![1]!.slice(1, -1));
  for (const c of catalog.characters) {
    for (const n of ['idle', 'walk_left', 'walk_right']) assert.ok(c.clips[n] && c.clips[n]!.frames.length >= 2, `${c.id}/${n}`);
    for (const [name, clip] of Object.entries(c.clips)) {
      for (const f of clip.frames) {
        refs++;
        assert.ok(existsSync(new URL(f.file, ROOT)), `${c.id}/${name}: ${f.file}`);
        assert.ok(re.test(`./${f.file.replace(/^design-assets\//, '')}`), `${f.file} は読み込む範囲に含まれる`);
        assert.ok(f.ms > 0);
      }
    }
  }
  assert.equal(refs, 682, '索引の参照数（再利用を含む）');
});

test('kind: 巻き角=二足・花襟長耳=四足・コウモリ=飛行・脚のない星/雲/ミント=浮遊、ラベンダー=跳ね。全員を四足に統一しない', () => {
  const k = (id: string) => byId.get(id)!.kind;
  assert.equal(k('curlyhorn'), 'biped');
  assert.equal(k('flowerlong'), 'quadruped');
  assert.match(k('bat'), /fly|float/);
  assert.equal(k('lavender'), 'hopper');
  for (const id of ['mint', 'hoshiru', 'cloudghost']) assert.match(k(id), /float/, id);
  assert.ok(new Set(catalog.characters.map((c) => c.kind)).size >= 4);
});

test('寸法: 1体の共通referenceWidthで換算し、コマごとのbboxで幅を合わせ直さない。足元はclip.anchor。78%の仮定を使わない', () => {
  for (const c of catalog.characters) {
    for (const [name, clip] of Object.entries(c.clips)) {
      const r = spriteRect(c, clip, 400, { x: 200, y: 300 });
      assert.ok(Math.abs((r.side * c.referenceWidth) / CANVAS - c.roomWidth * 400) < 1e-6, `${c.id}/${name}: 見える幅 = 部屋幅×roomWidth`);
      assert.ok(Math.abs(r.left + (r.side * clip.anchor[0]) / CANVAS - 200) < 1e-6 && Math.abs(r.top + (r.side * clip.anchor[1]) / CANVAS - 300) < 1e-6, `${c.id}/${name}: 足元`);
    }
  }
  // 同じ個体の全クリップで、画像の大きさは同じ（コマごとに変わらない）
  const a = byId.get('anzu')!;
  assert.equal(spriteRect(a, a.clips.idle!, 400, { x: 0, y: 0 }).side, spriteRect(a, a.clips.walk_right!, 400, { x: 0, y: 0 }).side);
  for (const f of ['CharacterSprite.tsx', 'RoomCrowd.tsx', 'MotionCheck.tsx', 'Companion.tsx', 'Home.tsx']) {
    const s = read(`../src/ui/${f}`);
    assert.ok(!/VISIBLE_RATIO|\b0\.78\b/.test(s), `${f} に旧78%の仮定が無い`);
    assert.ok(!/scaleX|rotate|translateY|Animated/.test(s), `${f} に反転・回転・上下揺れ・変形が無い`);
  }
});

test('机の帯: 高さが上限を超えるときだけ共通倍率で縮め、超えなければ基準どおり', () => {
  const c = byId.get('anzu')!;
  const clip = c.clips.idle!;
  const free = fittedRect(c, clip, 100, undefined, { x: 0, y: 0 });
  assert.ok(Math.abs((free.side * c.referenceWidth) / CANVAS - 100) < 1e-6);
  const capped = fittedRect(c, clip, 100, 20, { x: 0, y: 0 });
  assert.ok(capped.side < free.side);
  assert.ok(((clip.anchor[1] - (clip.frames[0]!.bbox?.[1] ?? 0)) / CANVAS) * capped.side <= 20 + 1e-6);
  assert.equal(fittedRect(c, clip, 100, 9999, { x: 0, y: 0 }).side, free.side);
});

test('時刻→コマ: ループは周回し、非ループは最後で止まる', () => {
  const clip = { frames: [{ file: 'a', ms: 100 }, { file: 'b', ms: 300 }], anchor: [0, 0] as [number, number] };
  assert.deepEqual([0, 99, 100, 399, 400, 500].map((t) => frameAt(clip, t)), [0, 0, 1, 1, 0, 1]);
  assert.equal(frameAt(clip, 9999, false), 1);
});

test('床: 多角形の横の範囲、家具の膨らませた足元と他の個体を避けた立てる区間、最も近い空き', () => {
  const sp = spanAt(FLOOR_POLYGON, 0.6)!;
  assert.ok(sp[0] > 0.05 && sp[1] < 0.95 && sp[0] < sp[1]);
  assert.equal(spanAt(FLOOR_POLYGON, 0.1), null);
  const free = freeIntervals(FLOOR_POLYGON, 0.6, 0.05, 0.02, [{ l: 0.4, t: 0.55, r: 0.6, b: 0.62 }], []);
  assert.equal(free.length, 2);
  assert.ok(free[0]![1] <= 0.4 - 0.05 + 1e-9 && free[1]![0] >= 0.6 + 0.05 - 1e-9);
  assert.equal(intervalOf(0.5, free), null);
  const n = nearestFree(0.5, free)!;
  assert.ok(intervalOf(n, free));
  assert.equal(nearestFree(0.5, []), null);
  const withOther = freeIntervals(FLOOR_POLYGON, 0.6, 0.05, 0.02, [], [{ x: 0.5, y: 0.62, halfW: 0.05 }]);
  assert.equal(withOther.length, 2, '近いYの他の個体は避ける');
  assert.equal(freeIntervals(FLOOR_POLYGON, 0.6, 0.05, 0.02, [], [{ x: 0.5, y: 0.8, halfW: 0.05 }]).length, 1, '離れたYは避けない');
});

const envOf = (obstacles: Rect[], others: Env['others'] = [], canWalk = true): Env => ({ poly: FLOOR_POLYGON, obstacles, others, canWalk });
const half = (c: CharMotion) => c.roomWidth * 0.3;

function run(c: CharMotion, start: { x: number; y: number }, seconds: number, env: (s: WalkerState) => Env, seed = 7) {
  const w = new Walker(c, start, seed);
  const log: WalkerState[] = [w.state()];
  for (let t = 0; t < seconds * 1000; t += 80) {
    w.step(80, env(w.state()));
    log.push(w.state());
  }
  return log;
}

test('全26体: 家具と壁を貫通せず、向きに合う歩きクリップだけを使い、開始/停止は描いてある向きだけ。反転や逆再生をしない', () => {
  const obstacles = obstaclesOf();
  for (const c of catalog.characters) {
    const y = 0.64;
    const log = run(c, { x: 0.3, y }, 150, () => envOf(obstacles), c.id.length * 13);
    let walked = false;
    for (const s of log) {
      assert.ok(c.clips[s.clip], `${c.id}: ${s.clip} は索引にある`);
      assert.ok(s.frame >= 0 && s.frame < c.clips[s.clip]!.frames.length, `${c.id}: コマ番号`);
      const span = spanAt(FLOOR_POLYGON, y)!;
      assert.ok(s.x >= span[0] + half(c) - 1e-6 && s.x <= span[1] - half(c) + 1e-6, `${c.id}: 床の中 x=${s.x}`);
      for (const o of obstacles) if (y >= o.t - 0.02 && y <= o.b + 0.02) assert.ok(!(s.x > o.l - half(c) + 1e-6 && s.x < o.r + half(c) - 1e-6), `${c.id}: 家具の中に入らない x=${s.x}`);
      if (s.phase === 'walk') {
        walked = true;
        assert.equal(s.clip, `walk_${s.dir}`);
      }
      if (s.phase === 'start') assert.equal(s.clip, `start_${s.dir}`);
      if (s.phase === 'stop') assert.equal(s.clip, `stop_${s.dir}`);
      if (s.phase === 'idle') assert.equal(s.clip, 'idle');
    }
    assert.ok(walked, `${c.id}: 150秒のうちに歩く`);
    // 画面の移動は連続（1ステップで歩幅の数倍を飛ばさない）
    const stride = c.strideRatio * c.roomWidth;
    for (let i = 1; i < log.length; i++) assert.ok(Math.abs(log[i]!.x - log[i - 1]!.x) <= stride + 1e-9, `${c.id}: 位置が連続`);
  }
});

test('歩幅: 歩行1周で strideRatio×見える幅 だけ進み、壁・家具の手前では周の途中でも止まる。停止/コマ送りの間は動かない', () => {
  for (const id of ['anzu', 'lavender', 'bat', 'leafwrap', 'mint']) {
    const c = byId.get(id)!;
    const stride = c.strideRatio * c.roomWidth;
    const w = new Walker(c, { x: 0.5, y: 0.7 }, 3);
    let walkedCycles = 0;
    let xAtWalkStart = 0;
    let prev = w.state();
    for (let t = 0; t < 60000; t += 40) {
      w.step(40, envOf([]));
      const s = w.state();
      if (s.phase === 'walk' && prev.phase !== 'walk') xAtWalkStart = prev.x;
      if (prev.phase === 'walk' && s.phase !== 'walk') {
        const moved = Math.abs(s.x - xAtWalkStart);
        const cycles = moved / stride;
        assert.ok(Math.abs(cycles - Math.round(cycles)) < 1e-6 && Math.round(cycles) >= 1 && Math.round(cycles) <= 3, `${id}: 歩行は整数周期 (${cycles})`);
        walkedCycles += Math.round(cycles);
      }
      prev = s;
    }
    assert.ok(walkedCycles >= 1, id);
  }
  // 壁際: 区間が歩幅より短ければ歩かない
  const c = byId.get('anzu')!;
  const tiny = run(c, { x: 0.5, y: 0.6 }, 60, () => envOf([{ l: 0, t: 0.5, r: 0.5 - 0.0, b: 0.7 }, { l: 0.5 + 0.0, t: 0.5, r: 1, b: 0.7 }]));
  assert.ok(tiny.every((s) => s.phase === 'idle'), '全区間が塞がれたら待機のまま');
  assert.ok(tiny.every((s) => s.x === tiny[0]!.x));
});

test('前進の重み: 索引のtravelWeights(ラベンダーの左右)を優先して使い、仮の曲線で代用しない。接地のコマではその場に留まる。重みの無い個体だけ時間に比例', () => {
  const l = byId.get('lavender')!;
  assert.deepEqual(l.clips.walk_right!.travelWeights, [0, 0, 0.4, 0.6, 0, 0, 0, 0]);
  assert.deepEqual(l.clips.walk_left!.travelWeights, [0, 0, 0.15, 0.3, 0.3, 0.25, 0, 0]);
  const rawLeft = (raw as { characters: { id: string; clips: { walk_left: { travelWeights: number[] } } }[] }).characters.find((c) => c.id === 'lavender')!.clips.walk_left.travelWeights;
  assert.deepEqual(l.clips.walk_left!.travelWeights, rawLeft, '既存の左の値を上書きしない');
  for (const name of ['walk_left', 'walk_right']) {
    const w = strideWeights(l, l.clips[name]!);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.deepEqual(w.map((v) => v > 0), l.clips[name]!.travelWeights!.map((v) => v > 0));
  }
  // 歩かせて確かめる: 重み0のコマの間は位置が動かない（右: 3,4コマ目=踏切/空中だけ進む）
  for (const name of ['walk_left', 'walk_right'] as const) {
    const clip = l.clips[name]!;
    const w = clip.travelWeights!;
    const walker = new Walker(l, { x: 0.5, y: 0.7 }, 11);
    let prev = walker.state();
    let movedInZero = 0;
    let movedInTravel = 0;
    for (let t = 0; t < 120000; t += 20) {
      walker.step(20, envOf([]));
      const s = walker.state();
      if (prev.phase === 'walk' && s.phase === 'walk' && prev.clip === name && s.clip === name) {
        const d = Math.abs(s.x - prev.x);
        if (w[prev.frame] === 0 && w[s.frame] === 0) movedInZero += d;
        else movedInTravel += d;
      }
      prev = s;
    }
    assert.ok(movedInZero < 1e-9, `${name}: 接地のコマで滑らない`);
    assert.ok(movedInTravel > 0, `${name}: 踏切/空中で前進する`);
  }
  const a = byId.get('anzu')!;
  const wa = strideWeights(a, a.clips.walk_left!);
  const clip = a.clips.walk_left!;
  assert.ok(wa.every((v, i) => Math.abs(v - clip.frames[i]!.ms / clip.frames.reduce((n, f) => n + f.ms, 0)) < 1e-9));
});

test('家具が重なる開始位置は空き床へ移し、動かせない時は動かさない。止める/再開で時間を取り戻さない', () => {
  const c = byId.get('anzu')!;
  const obs = obstaclesOf();
  const tree = obs.find((o) => o.l < 0.5 && o.r > 0.5)!;
  const w = new Walker(c, { x: (tree.l + tree.r) / 2, y: (tree.t + tree.b) / 2 }, 1);
  assert.equal(w.relocate(envOf(obs)), true);
  const moved = w.state().x;
  assert.ok(moved <= tree.l - half(c) + 1e-6 || moved >= tree.r + half(c) - 1e-6);
  const blockedAll = new Walker(c, { x: 0.5, y: 0.6 }, 1);
  assert.equal(blockedAll.relocate(envOf([{ l: 0, t: 0.5, r: 1, b: 0.7 }])), false);
  assert.equal(blockedAll.state().x, 0.5);
  // 歩行中に settle すると待機の最初のコマへ。そのまま step(0) では動かない
  const wk = new Walker(c, { x: 0.5, y: 0.7 }, 5);
  for (let t = 0; t < 30000 && wk.state().phase !== 'walk'; t += 40) wk.step(40, envOf([]));
  assert.equal(wk.state().phase, 'walk');
  const x = wk.state().x;
  wk.settle();
  assert.deepEqual([wk.state().phase, wk.state().clip, wk.state().frame, wk.state().x], ['idle', 'idle', 0, x]);
  wk.step(0, envOf([]));
  assert.equal(wk.state().x, x);
  // 歩けない状態(編集中・非表示など)では待機のまま
  const still = run(c, { x: 0.5, y: 0.7 }, 120, () => envOf([], [], false));
  assert.ok(still.every((s) => s.phase === 'idle' && s.x === 0.5));
});

test('同室3体のすれ違い: 近いYでは重ならず、間隔を保つ', () => {
  const starts = [{ x: 0.3, y: 0.64 }, { x: 0.7, y: 0.66 }, { x: 0.5, y: 0.79 }];
  const chars = [byId.get('anzu')!, byId.get('pomuri')!, byId.get('bat')!];
  const walkers = chars.map((c, i) => new Walker(c, starts[i]!, 100 + i));
  const obstacles = obstaclesOf();
  for (let t = 0; t < 240000; t += 80) {
    const cur = walkers.map((w) => w.state());
    walkers.forEach((w, i) => w.step(80, envOf(obstacles, cur.filter((_, j) => j !== i).map((s) => ({ x: s.x, y: s.y, halfW: half(chars[cur.indexOf(s)]!) })))));
    const now = walkers.map((w) => w.state());
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      if (Math.abs(now[i]!.y - now[j]!.y) < 0.05) assert.ok(Math.abs(now[i]!.x - now[j]!.x) >= half(chars[i]!) + half(chars[j]!) - 1e-6, `${i}-${j} が重ならない t=${t}`);
    }
  }
});

test('選択切替・非表示・動きを減らす時にタイマーを止める実装になっている（時計は1か所で、cleanupで破棄）', () => {
  const crowd = read('../src/ui/RoomCrowd.tsx');
  assert.match(crowd, /clearInterval/);
  assert.match(crowd, /!opts\.run[\s\S]*settle/);
  assert.match(crowd, /Math\.min\(now - last, MAX_DT\)/);
  const home = read('../src/ui/Home.tsx');
  assert.match(home, /canWalk: editable && !editing && active && !reduceMotion/);
  assert.match(home, /run: active && !reduceMotion && !editing/);
  const sprite = read('../src/ui/CharacterSprite.tsx');
  assert.match(sprite, /clearTimeout/);
  const check = read('../src/ui/MotionCheck.tsx');
  assert.match(check, /clearTimeout/);
});

test('parseCatalog: 壊れた索引は黙って通さない', () => {
  const bad = (f: (o: any) => void) => () => {
    const o = JSON.parse(JSON.stringify({ characters: catalog.characters.slice(0, 2) }));
    f(o);
    return parseCatalog(o);
  };
  assert.throws(bad((o) => { delete o.characters[0].clips.idle; }), /idle/);
  assert.throws(bad((o) => { o.characters[0].referenceWidth = 0; }), /幅/);
  assert.throws(bad((o) => { o.characters[0].clips.walk_left.anchor = [1, 9999]; }), /anchor/);
  assert.throws(bad((o) => { o.characters[0].clips.walk_left.frames[0].ms = 0; }), /コマ/);
  assert.throws(bad((o) => { o.characters[1].id = o.characters[0].id; }), /重複/);
  assert.throws(bad((o) => { o.characters[0].clips.walk_left.travelWeights = [1, 2]; }), /travelWeights/);
  assert.throws(bad((o) => { o.characters[0].clips.walk_left.travelWeights = o.characters[0].clips.walk_left.frames.map(() => 0); }), /travelWeights/);
  assert.equal(clipOf(catalog.characters[0]!, 'nope'), catalog.characters[0]!.clips.idle);
});
