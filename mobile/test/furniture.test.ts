import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEMO_CONFIG, MemoryStorage, StudyCore, CoreError, codes, BitPatternsContent, treeStage } from '../../src/mobile.ts';
import {
  TREE_GROWTH, TREE_STAGE_INDEX, growthDef, FURNITURE, FURNITURE_KEY, LayoutStore, SHOP_ITEMS, STARTER_IDS, defOf, drawOrder, drawRect, isValidLayout, moveBy, moveTo, onlyOwned, ownedSet,
  placeItem, placementProblem, starterLayout, storeAway, type Layout,
} from '../src/state/furniture.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { CORE_KEY } from '../src/state/kvStorage.ts';
import { ROOM_IDS, RoomStore } from '../src/state/room.ts';

const manifest = JSON.parse(readFileSync(new URL('../../design-assets/app-completion-20261020/garden/manifest.json', import.meta.url), 'utf8')) as {
  items: { id: string; name: string; file: string; anchor: number[]; referenceWidth: number; roomWidth: number; defaultGround: number[]; footprint: number[]; layer: string; trialPointCost: number; visible_bbox: number[]; moneyPrice: unknown }[];
  starterFurniture: string[];
  floorPolygon: number[][];
};

test('家具8点: 数値・順序・スターター・仮ポイントがmanifestと一致し、画像が実在し、金額はない', () => {
  assert.equal(manifest.items.length, 8);
  assert.deepEqual(FURNITURE.map((f) => f.id), manifest.items.map((i) => i.id));
  for (const m of manifest.items) {
    const f = defOf(m.id)!;
    assert.deepEqual(
      { name: f.name, anchor: f.anchor, referenceWidth: f.referenceWidth, roomWidth: f.roomWidth, defaultGround: f.defaultGround, footprint: f.footprint, layer: f.layer, trialPointCost: f.trialPointCost },
      { name: m.name, anchor: m.anchor, referenceWidth: m.referenceWidth, roomWidth: m.roomWidth, defaultGround: m.defaultGround, footprint: m.footprint, layer: m.layer, trialPointCost: m.trialPointCost },
      m.id,
    );
    assert.equal(m.moneyPrice, null);
    // 見える幅は visible_bbox から。キャンバス幅(512)や78%の仮定を使わない
    assert.equal(m.visible_bbox[2]! - m.visible_bbox[0]!, m.referenceWidth, m.id);
    assert.ok(existsSync(new URL(`../../${m.file}`, import.meta.url)), m.file);
  }
  assert.deepEqual([...STARTER_IDS], manifest.starterFurniture);
  assert.deepEqual(SHOP_ITEMS.map((f) => f.trialPointCost), [30, 40, 20, 30, 20]);
  assert.equal(SHOP_ITEMS.length, 5);
});

test('描画寸法: 見える幅が部屋幅×roomWidth、足元(anchor)が指定の床位置に一致', () => {
  for (const f of FURNITURE) {
    const r = drawRect(f, 400, [0.5, 0.6]);
    const scale = r.size / 512;
    assert.ok(Math.abs(f.referenceWidth * scale - f.roomWidth * 400) < 1e-9, f.id);
    assert.ok(Math.abs(r.left + f.anchor[0] * scale - 200) < 1e-9 && Math.abs(r.top + f.anchor[1] * scale - 240) < 1e-9, f.id);
  }
});

test('スターター3点は有効な配置で、床内・重なりなし。ラグが最背面で、ほかは足元Y順', () => {
  const l = starterLayout();
  assert.deepEqual(l.placed.map((p) => p.id), [...STARTER_IDS]);
  for (const p of l.placed) assert.equal(placementProblem(l, p.id, p.x, p.y), null, p.id);
  const order = drawOrder({ ...l, placed: [...l.placed].reverse() }).map((p) => p.id);
  assert.equal(order[0], 'leaf-rug');
  const ys = drawOrder(l).slice(1).map((p) => p.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
});

test('移動: 床の外・他の家具との重なりは確定前に弾き、元の位置のまま。ラグの上には置ける', () => {
  const l = starterLayout();
  assert.equal(moveTo(l, 'wood-stool', 0.02, 0.95), null, '床の外');
  assert.equal(moveTo(l, 'wood-stool', 0.5, 0.47), null, '知恵の木と重なる');
  assert.equal(moveBy(l, 'missing', 0.1, 0), null);
  const ok = moveBy(l, 'wood-stool', 0.04, 0.02)!;
  assert.ok(ok && ok.placed.find((p) => p.id === 'wood-stool')!.x === 0.68);
  assert.equal(l.placed.find((p) => p.id === 'wood-stool')!.x, 0.64, '元の配置は変わらない');
  // ラグ(床)の上にスツールを置ける
  assert.equal(placementProblem(l, 'wood-stool', 0.5, 0.77), null);
  assert.match(placementProblem(l, 'wood-stool', 0.5, 0.47)!, /重なり/);
});

test('置く・しまう: 所有を残して配置だけ外し、既定位置が塞がっていても近くの空きへ。8点すべて同時に置ける', () => {
  let l: Layout = starterLayout();
  const stored = storeAway(l, 'wood-stool');
  assert.equal(stored.placed.length, 2);
  assert.deepEqual(placeItem(stored, 'wood-stool')!.placed.find((p) => p.id === 'wood-stool'), { id: 'wood-stool', x: 0.64, y: 0.6 });
  assert.equal(placeItem(l, 'wood-stool'), null, '置いてあるものは二重に置かない');
  for (const f of SHOP_ITEMS) {
    const next = placeItem(l, f.id);
    assert.ok(next, `${f.id} を置ける`);
    l = next!;
    for (const p of l.placed) assert.equal(placementProblem({ ...l, placed: l.placed.filter((q) => q.id !== p.id) }, p.id, p.x, p.y), null, `${p.id} 配置後も有効`);
  }
  assert.equal(l.placed.length, 8);
  assert.equal(new Set(l.placed.map((p) => p.id)).size, 8);
});

test('配置の保存: 再読込で復帰。無ければスターター。壊れた保存は上書きしない。所有の無い家具は描かない', async () => {
  const kv = new MemoryKv();
  const s = new LayoutStore(kv);
  assert.deepEqual(await s.load(), { layout: starterLayout(), corrupt: false });
  assert.ok(!kv.map.has(FURNITURE_KEY), '読むだけでは保存を作らない');
  const moved = moveBy(starterLayout(), 'wood-stool', 0.04, 0)!;
  await s.save(moved);
  assert.deepEqual((await new LayoutStore(kv).load()).layout, moved);
  assert.ok(!kv.map.has(CORE_KEY));

  for (const bad of ['{x', JSON.stringify({ version: 1, placed: [{ id: 'ghost', x: 0.5, y: 0.5 }] }), JSON.stringify({ version: 1, placed: [{ id: 'bookcase', x: 2, y: 0.5 }] }), JSON.stringify({ version: 1, placed: [{ id: 'bookcase', x: 0.5, y: 0.5 }, { id: 'bookcase', x: 0.6, y: 0.5 }] })]) {
    const k = new MemoryKv();
    k.map.set(FURNITURE_KEY, bad);
    const r = await new LayoutStore(k).load();
    assert.equal(r.corrupt, true);
    assert.equal(k.map.get(FURNITURE_KEY), bad);
  }
  assert.ok(isValidLayout(starterLayout()));
  const withBook = placeItem(starterLayout(), 'bookcase')!;
  assert.deepEqual(onlyOwned(withBook, ownedSet([])).placed.map((p) => p.id), [...STARTER_IDS]);
  assert.ok(onlyOwned(withBook, ownedSet(['bookcase'])).placed.some((p) => p.id === 'bookcase'));
});

test('部屋: 元のCの部屋(first)と編集できる室内(home)を分け、旧保存の部屋選択はそのまま読める', async () => {
  assert.ok(ROOM_IDS.includes('first') && ROOM_IDS.includes('home'));
  const kv = new MemoryKv();
  const rs = new RoomStore(kv);
  await rs.save('first');
  assert.equal(await rs.load(), 'first');
  kv.map.set('certgarden:room:v1', JSON.stringify({ room: 'forest' }));
  assert.equal(await rs.load(), 'forest');
});

// ---- 知恵の木の成長画 ----
const growth = JSON.parse(readFileSync(new URL('../../design-assets/app-completion-20261020/garden/tree-growth/manifest.json', import.meta.url), 'utf8')) as {
  referenceWidth: number; roomWidth: number; stageAtUniqueStudyDays: number[];
  stages: { stage: number; file: string; anchor: number[] }[];
};
const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('木の成長画: 4段階の画像が実在し、全段階が共通の寸法(referenceWidth/anchor)と、既存の見える幅(roomWidth)・家具ID/配置/障害物のまま', () => {
  assert.equal(growth.stages.length, 4);
  for (const s of growth.stages) {
    assert.ok(existsSync(new URL(`../../${s.file}`, import.meta.url)), s.file);
    assert.deepEqual(s.anchor, [...TREE_GROWTH.anchor]);
  }
  assert.equal(growth.referenceWidth, TREE_GROWTH.referenceWidth);
  const tree = defOf('knowledge-tree')!;
  assert.equal(growth.roomWidth, tree.roomWidth);
  assert.equal(growthDef(tree).roomWidth, tree.roomWidth);
  assert.deepEqual([tree.id, tree.defaultGround, tree.footprint, tree.layer, tree.trialPointCost], ['knowledge-tree', [0.5, 0.47], [0.13, 0.08], 'object', 0]);
  assert.equal(growthDef(defOf('wood-stool')!), defOf('wood-stool'), '他の家具は変えない');
  // どの段階でも同じ大きさ・同じ足元（各画像の余白を段階ごとに合わせ直さない）
  const g = growthDef(tree);
  const r = drawRect(g, 400, [0.5, 0.47]);
  assert.ok(Math.abs((g.referenceWidth * (r.size / 512)) - tree.roomWidth * 400) < 1e-9);
  assert.ok(Math.abs(r.left + g.anchor[0] * (r.size / 512) - 200) < 1e-9 && Math.abs(r.top + g.anchor[1] * (r.size / 512) - 188) < 1e-9);
  // 元の木の画像は家具として保持
  assert.ok(existsSync(new URL('../../design-assets/app-completion-20261020/garden/knowledge-tree.png', import.meta.url)));
});

test('木の段階: 世話の日数0/1/3/7で 種/芽/若木/実の木。途中の日は同じ段階で、減らない。絵と文の段階が同じ', () => {
  assert.deepEqual(growth.stageAtUniqueStudyDays, [0, 1, 3, 7]);
  const idx = (n: number) => TREE_STAGE_INDEX[treeStage(n)];
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 30].map(idx), [0, 1, 1, 2, 2, 2, 3, 3]);
  const seq = Array.from({ length: 12 }, (_, n) => idx(n));
  assert.ok(seq.every((v, i) => i === 0 || v >= seq[i - 1]!), '日数が増えて段階が下がらない');
  assert.deepEqual(Object.keys(TREE_STAGE_INDEX), ['seed', 'sprout', 'leaf', 'fruit']);
});

test('木の描画の接続: 箱庭は世話の段階を渡し、成長画が無ければ元の木のまま。学ぶ画面の絵と文は同じ段階。水やりの絵を偽らない', () => {
  const home = src('../src/ui/Home.tsx');
  assert.match(home, /treeStage=\{snapshot\.tree\.stage\}/);
  const room = src('../src/ui/RoomEditor.tsx');
  assert.match(room, /TREE_STAGE_IMAGES\[TREE_STAGE_INDEX\[treeStage\]\]/);
  assert.match(room, /const def = grown \? growthDef\(base\) : base/, '画像が無ければ元の寸法のまま');
  assert.match(room, /grown \?\? FURNITURE_IMAGES\[p\.id\]/);
  const learn = src('../src/ui/LearnTab.tsx');
  assert.match(learn, /TREE_STAGE_IMAGES\[TREE_STAGE_INDEX\[snapshot\.tree\.stage\]\]/);
  assert.match(learn, /TREE_TEXT\[snapshot\.tree\.stage\]/);
  assert.match(learn, /水やりをする動物の絵はまだ作っていません/);
  assert.ok(!/じょうろ|水やりをする動物の絵ができ/.test(learn + room));
  assert.ok(!/scaleX|rotate|Animated/.test(room), '変形・反転で代用しない');
  const assets = src('../src/ui/furnitureAssets.ts');
  assert.equal((assets.match(/tree-growth\/[0-3]\.png/g) ?? []).length, 4);
});

test('短い幅(320px)の修理: 箱庭の説明文と見出しは固定高さにせず折り返し、学ぶ画面の列は幅を残してボタンが下へ回る。教材の注意は現状の正確な文', () => {
  const home = src('../src/ui/Home.tsx');
  assert.ok(!/note: \{[^}]*\bheight: NOTE_H/.test(home), '説明文を固定の高さにしない');
  assert.match(home, /minHeight: NOTE_H/);
  assert.match(home, /top: \{ minHeight: TOP_H, flexDirection: 'row', flexWrap: 'wrap'/);
  assert.match(home, /stats: \{ flexDirection: 'row', flexWrap: 'wrap'/);
  assert.match(home, /setNoteH\(/);
  const learn = src('../src/ui/LearnTab.tsx');
  assert.match(learn, /qHead: \{ flexDirection: 'row', flexWrap: 'wrap'/);
  assert.match(learn, /themeRow: \{ flexDirection: 'row', flexWrap: 'wrap'/);
  assert.match(learn, /grow: \{ flexGrow: 1, flexShrink: 1, flexBasis: 200/);
  assert.ok(!/numberOfLines/.test(learn), '資格名を切り落とさない');
  assert.match(learn, /言葉の問題は作者が確認した段階です/);
  assert.ok(!/言葉の問題の意味の確認は途中です/.test(learn));
  assert.match(learn, /専門家による監修はありません/);
});

// ---- 仮ポイントでの入手（学習コア側の保存） ----
const openCore = (storage = new MemoryStorage()) =>
  StudyCore.open({ storage, content: new BitPatternsContent(), clock: { now: () => 0 }, config: DEMO_CONFIG, newId: () => 'x' });

function savedWith(points: number, extra: Record<string, unknown> = {}): MemoryStorage {
  const st = new MemoryStorage();
  st.setRaw(JSON.stringify({
    schemaVersion: 1, wallet: { fruits: 8, maxFruits: 10 }, points, studySeconds: {}, completedThemes: {}, reviews: {}, mastery: {}, stages: {}, completions: {}, log: [], ...extra,
  }));
  return st;
}

test('入手: ポイントの減算と所持が1回の保存。すでに持っていれば何も引かず、不足は何も変えない', async () => {
  const st = savedWith(100);
  const core = await openCore(st);
  assert.deepEqual(core.getGardenSnapshot().ownedFurniture, []);
  const r1 = await core.purchaseFurniture('bookcase', 30);
  assert.deepEqual(r1, { duplicate: false, points: 70 });
  const r2 = await core.purchaseFurniture('bookcase', 30);
  assert.deepEqual(r2, { duplicate: true, points: 70 });
  // 二重押下(同時)でも1回だけ
  const [a, b] = await Promise.all([core.purchaseFurniture('armchair', 40), core.purchaseFurniture('armchair', 40)]);
  assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
  assert.equal(core.getGardenSnapshot().points, 30);
  // 残高不足
  await assert.rejects(core.purchaseFurniture('leaf-pot', 40), (e: unknown) => e instanceof CoreError && e.code === codes.insufficientPoints);
  assert.equal(core.getGardenSnapshot().points, 30);
  assert.ok(!core.getGardenSnapshot().ownedFurniture.includes('leaf-pot'));
  // 再読込で所持・残高が復帰
  const again = await openCore(st);
  assert.deepEqual(again.getGardenSnapshot().ownedFurniture, ['bookcase', 'armchair']);
  assert.equal(again.getGardenSnapshot().points, 30);
  // 不正な指定
  await assert.rejects(core.purchaseFurniture('', 10), CoreError);
  await assert.rejects(core.purchaseFurniture('x', -5), CoreError);
  await assert.rejects(core.purchaseFurniture('x', 1.5), CoreError);
});

test('入手の保存失敗: 残高も所持も変わらず、再試行で1回だけ引かれる', async () => {
  const inner = savedWith(50);
  let fail = 1;
  const flaky = {
    load: () => inner.load(),
    async save(s: Parameters<MemoryStorage['save']>[0]) {
      if (fail-- > 0) throw new Error('disk full');
      return inner.save(s);
    },
  };
  const core = await StudyCore.open({ storage: flaky, content: new BitPatternsContent(), clock: { now: () => 0 }, config: DEMO_CONFIG });
  await assert.rejects(core.purchaseFurniture('coffee-table', 30), (e: unknown) => e instanceof CoreError && e.code === codes.storageWrite);
  assert.equal(core.getGardenSnapshot().points, 50);
  assert.deepEqual(core.getGardenSnapshot().ownedFurniture, []);
  assert.equal((await openCore(inner)).getGardenSnapshot().points, 50, '保存済みの原本も変わらない');
  await core.purchaseFurniture('coffee-table', 30);
  assert.equal(core.getGardenSnapshot().points, 20);
});

test('旧保存(家具の項目なし)はそのまま読め、壊れた家具の項目は黙って初期化せず拒否する', async () => {
  const old = savedWith(10);
  const core = await openCore(old);
  assert.equal(core.getGardenSnapshot().points, 10);
  assert.deepEqual(core.getGardenSnapshot().ownedFurniture, []);
  for (const bad of [{ furniture: 'x' }, { furniture: { owned: 'a' } }, { furniture: { owned: [1] } }, { furniture: { owned: ['a', 'a'] } }]) {
    const st = savedWith(10, bad);
    await assert.rejects(openCore(st), (e: unknown) => e instanceof CoreError && e.code === codes.corruptStorage);
  }
});
