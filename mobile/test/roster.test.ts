import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHARACTERS, CHARACTER_IDS } from '../src/state/characters.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { SETTINGS_KEY, SettingsStore } from '../src/state/notebook.ts';
import { ROSTER_KEY, RosterStore, defaultRoster, isValidRoster, setCompanion, setSlot } from '../src/state/roster.ts';

const catalog = JSON.parse(readFileSync(new URL('../../design-assets/app-completion-20261020/character-catalog.json', import.meta.url), 'utf8')) as {
  characters: { id: string; name: string; roomWidth: number; designAccepted: boolean; clips: Record<string, unknown> }[];
};

test('26体: id・名前・順序・部屋幅がカタログと一致し、重複登録がない', () => {
  assert.equal(catalog.characters.length, 26);
  assert.deepEqual(CHARACTERS.map((c) => c.id), catalog.characters.map((c) => c.id));
  assert.deepEqual(CHARACTERS.map((c) => c.name), catalog.characters.map((c) => c.name));
  assert.deepEqual(CHARACTERS.map((c) => c.roomWidth), catalog.characters.map((c) => c.roomWidth));
  assert.equal(new Set(CHARACTER_IDS).size, 26);
  assert.equal(CHARACTER_IDS.filter((id) => id === 'kokemaru').length, 1);
  assert.ok(catalog.characters.every((c) => c.designAccepted));
});

test('3枠: 別の枠にいる個体を選ぶと入れ替わり、重複しない', () => {
  const r0 = defaultRoster();
  assert.deepEqual(r0.room, ['cream', 'lavender', 'anzu']);
  const r1 = setSlot(r0, 0, 'kokemaru');
  assert.deepEqual(r1.room, ['kokemaru', 'lavender', 'anzu']);
  const r2 = setSlot(r1, 0, 'anzu'); // anzu は枠2にいる → 入れ替え
  assert.deepEqual(r2.room, ['anzu', 'lavender', 'kokemaru']);
  assert.equal(setSlot(r2, 0, 'anzu'), r2);
  assert.equal(setSlot(r2, 3, 'mint'), r2);
  assert.equal(setSlot(r2, 0, 'nobody'), r2);
  for (const id of CHARACTER_IDS) assert.ok(isValidRoster(setSlot(r0, 1, id)));
  assert.equal(setCompanion(r0, 'cloudghost').companion, 'cloudghost');
  assert.equal(setCompanion(r0, 'x'), r0);
});

test('旧設定からの移行: apricot は あんず(anzu)、cream/lavender も引き継ぐ。旧保存は書き換えない', async () => {
  const kv = new MemoryKv();
  await new SettingsStore(kv).save({ companion: 'lavender', reduceMotion: false });
  const before = kv.map.get(SETTINGS_KEY);
  const s = new RosterStore(kv);
  assert.equal((await s.load('lavender')).roster.companion, 'lavender');
  assert.equal((await s.load('apricot')).roster.companion, 'anzu');
  assert.equal((await s.load(undefined)).roster.companion, 'anzu');
  assert.equal(kv.map.get(SETTINGS_KEY), before);
  assert.ok(!kv.map.has(ROSTER_KEY), '読むだけでは保存を作らない');
});

test('保存と再読込: 3枠と学習相棒が復帰し、別キーで学習の保存に触れない', async () => {
  const kv = new MemoryKv();
  const s = new RosterStore(kv);
  let r = setSlot(defaultRoster(), 1, 'kokemaru');
  r = setCompanion(setSlot(r, 2, 'cloudghost'), 'mushroom');
  await s.save(r);
  const again = await new RosterStore(kv).load();
  assert.equal(again.corrupt, false);
  assert.deepEqual(again.roster, r);
  assert.deepEqual([...kv.map.keys()], [ROSTER_KEY]);
});

test('壊れた保存は上書きせず corrupt を返し、既定の編成を表示用に返す', async () => {
  for (const bad of ['{oops', JSON.stringify({ version: 1, room: ['cream', 'cream', 'anzu'], companion: 'anzu' }), JSON.stringify({ version: 1, room: ['cream', 'anzu'], companion: 'anzu' }), JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, room: ['cream', 'lavender', 'anzu'], companion: 'ghost' })]) {
    const kv = new MemoryKv();
    kv.map.set(ROSTER_KEY, bad);
    const l = await new RosterStore(kv).load('apricot');
    assert.equal(l.corrupt, true);
    assert.deepEqual(l.roster, defaultRoster('apricot'));
    assert.equal(kv.map.get(ROSTER_KEY), bad);
  }
});

test('素材: 26体の原画(静止画)がdesign-assetsに実在する。動く連番はここに置かず、索引(runtime-motion-catalog-v2)から引く', () => {
  const src = readFileSync(new URL('../src/ui/characterAssets.ts', import.meta.url), 'utf8');
  const paths = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]!);
  assert.equal(paths.length, 26);
  for (const p of paths) {
    const url = new URL(p.replace('../../../', '../../'), import.meta.url);
    assert.doesNotThrow(() => readFileSync(url), p);
  }
  assert.ok(!/IDLE_CLIPS|ms:/.test(src), '旧い待機の連番表は無い');
});
