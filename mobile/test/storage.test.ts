import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BitPatternsContent, CoreError, StudyCore, codes } from '../../src/mobile.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { CORE_KEY, KvStorage } from '../src/state/kvStorage.ts';
import { NOTEBOOK_KEY, NotebookStore, SettingsStore, validateEntry } from '../src/state/notebook.ts';
import { readFileSync } from 'node:fs';
import { anchorFrom } from '../src/ui/poses.ts';

const open = (kv: MemoryKv, t = Date.parse('2026-10-12T09:00:00+09:00')) =>
  StudyCore.open({ storage: new KvStorage(kv), content: new BitPatternsContent(), clock: { now: () => t } });

test('端末の保存: 再読込み後も同じ問題・進捗・実が残り、二重に消費しない', async () => {
  const kv = new MemoryKv();
  const a = await open(kv);
  const v = await a.startStage('it-passport', 'bit-patterns');
  assert.equal(a.getGardenSnapshot().fruits, 7);
  const adv = await a.advance(v.stageId, v.step);
  await a.interrupt(v.stageId);

  const b = await open(kv); // 再読込み相当
  const r = b.findResumable();
  assert.equal(r?.id, v.stageId);
  const resumed = await b.resume(v.stageId);
  assert.equal(resumed.phase, adv.view.phase);
  const again = await b.startStage('it-passport', 'bit-patterns'); // 二重開始は再開扱い
  assert.equal(again.stageId, v.stageId);
  assert.equal(b.getGardenSnapshot().fruits, 7);
});

test('壊れた保存データは黙って初期化せず、そのまま残して失敗する', async () => {
  const kv = new MemoryKv();
  kv.map.set(CORE_KEY, '{broken');
  await assert.rejects(open(kv), (e: unknown) => e instanceof CoreError && e.code === 'CORRUPT_STORAGE');
  assert.equal(kv.map.get(CORE_KEY), '{broken');

  kv.map.set(CORE_KEY, JSON.stringify({ schemaVersion: 2 }));
  await assert.rejects(open(kv), (e: unknown) => e instanceof CoreError && e.code === 'CORRUPT_STORAGE');
  assert.equal(kv.map.get(CORE_KEY), JSON.stringify({ schemaVersion: 2 }));
});

test('保存失敗: 状態は巻き戻り、実は減らず、再試行で1回だけ消費する', async () => {
  const kv = new MemoryKv();
  const core = await open(kv);
  kv.failNextWrites = 1;
  await assert.rejects(core.startStage('it-passport', 'bit-patterns'), (e: unknown) => e instanceof CoreError && e.code === 'STORAGE_WRITE_FAILED');
  assert.equal(core.getGardenSnapshot().fruits, 8);
  assert.equal(core.findResumable(), undefined);
  await core.startStage('it-passport', 'bit-patterns');
  assert.equal(core.getGardenSnapshot().fruits, 7);
});

test('手帳: 学習の保存とは別キー。壊れたデータは例外にして上書きしない', async () => {
  const kv = new MemoryKv();
  const nb = new NotebookStore(kv);
  assert.deepEqual(await nb.load(), []);
  await nb.save([{ id: 'a', name: 'ITパスポート', date: '2026-10-01', memo: '' }]);
  assert.ok(kv.map.has(NOTEBOOK_KEY));
  assert.ok(!kv.map.has(CORE_KEY));
  kv.map.set(NOTEBOOK_KEY, 'oops');
  await assert.rejects(nb.load());
  assert.equal(kv.map.get(NOTEBOOK_KEY), 'oops');
});

test('手帳の入力検査と設定の既定値', async () => {
  assert.ok(validateEntry('', ''));
  assert.ok(validateEntry('FP', '2026-13-40'));
  assert.ok(validateEntry('FP', '10/12'));
  assert.equal(validateEntry('FP', ''), null);
  assert.equal(validateEntry('FP', '2026-02-28'), null);
  const s = new SettingsStore(new MemoryKv());
  assert.deepEqual(await s.load(), { companion: 'apricot', reduceMotion: false });
});

const manifest = JSON.parse(readFileSync(new URL('../../design-assets/manifest.json', import.meta.url), 'utf8'));

test('素材: 3体×6ポーズの anchor と切り出し位置が manifest から取れる', () => {
  for (const id of ['cream', 'lavender', 'apricot'] as const) {
    ['idle', 'sleep', 'roll', 'cheer', 'encourage', 'celebrate'].forEach((p, i) => {
      const a = anchorFrom(manifest, id, p as 'idle');
      assert.equal(a.index, i);
      assert.ok(a.x > 0 && a.x < 512 && a.y > 0 && a.y < 512);
    });
  }
});

test('壊れた手帳: date/memoの型・不正日付・重複id・資格名なしを拒否し、原文を変えない。通常の手帳は読める', async () => {
  const good = [{ id: 'a', name: 'ITパスポート', date: '2026-10-12', memo: '' }, { id: 'b', name: '基本情報', date: '', memo: 'メモ' }];
  const bad: unknown[] = [
    [{ id: 'a', name: 'x', date: 5, memo: '' }],
    [{ id: 'a', name: 'x', date: '', memo: null }],
    [{ id: 'a', name: 'x', memo: '' }],
    [{ id: 'a', name: 'x', date: '2026-02-30', memo: '' }],
    [{ id: 'a', name: 'x', date: '2026/10/12', memo: '' }],
    [{ id: 'a', name: '  ', date: '', memo: '' }],
    [{ id: 'a', name: 'x', date: '', memo: '' }, { id: 'a', name: 'y', date: '', memo: '' }],
    [null],
  ];
  const kv = new MemoryKv();
  kv.map.set(NOTEBOOK_KEY, JSON.stringify(good));
  assert.deepEqual(await new NotebookStore(kv).load(), good);
  for (const b of bad) {
    const raw = JSON.stringify(b);
    kv.map.set(NOTEBOOK_KEY, raw);
    await assert.rejects(new NotebookStore(kv).load(), /壊れています/);
    assert.equal(kv.map.get(NOTEBOOK_KEY), raw);
  }
});

test('保存失敗: 中断の保存が失敗しても状態を保ち、再試行で保存でき、実を二重に消費しない', async () => {
  const kv = new MemoryKv();
  const core = await open(kv);
  const v = await core.startStage('it-passport', 'bit-patterns');
  const before = kv.map.get(CORE_KEY);
  kv.failNextWrites = 1;
  await assert.rejects(core.interrupt(v.stageId), (e: unknown) => e instanceof CoreError && e.code === codes.storageWrite);
  assert.equal(kv.map.get(CORE_KEY), before, '失敗時は保存済みデータを変えない');
  assert.equal(core.getStageView(v.stageId).status, 'active', 'メモリ上も中断扱いにならない');
  await core.interrupt(v.stageId);
  await core.resume(v.stageId);
  assert.equal(core.getGardenSnapshot().fruits, 7);
  assert.equal(core.findResumable()?.id, v.stageId);
  const reopened = await open(kv);
  assert.equal(reopened.getGardenSnapshot().fruits, 7);
});
