import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CompositeContent, DiagnosticEngine, PackContent, listPackThemes, type DiagView, type LearningPack } from '../../src/mobile.ts';
import { DIAG_KEY, KvDiagStorage } from '../src/state/diagnosticStore.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { CORE_KEY } from '../src/state/kvStorage.ts';
import { ROSTER_KEY } from '../src/state/roster.ts';

const pack = JSON.parse(readFileSync(new URL('../../design-assets/app-completion-20261020/learning-pack.json', import.meta.url), 'utf8')) as LearningPack;
const ids = (q: string) => listPackThemes(pack).filter((t) => t.qualificationId === q).map((t) => t.themeId);
const engine = (kv: MemoryKv, now = Date.parse('2026-10-20T09:00:00+09:00')) =>
  new DiagnosticEngine({ storage: new KvDiagStorage(kv), content: new CompositeContent(new PackContent(pack)), clock: { now: () => now } });

test('端末の保存: 初回チェックは専用キーに保存され、再読込で続きから。学習・編成の保存には触れない', async () => {
  const kv = new MemoryKv();
  const a = engine(kv);
  await a.load();
  const v = (await a.start('eco', ids('eco'))) as Extract<DiagView, { kind: 'question' }>;
  const sel = await a.select('eco', v.step, v.options[0]!.id);
  assert.deepEqual([...kv.map.keys()], [DIAG_KEY]);
  assert.ok(!kv.map.has(CORE_KEY) && !kv.map.has(ROSTER_KEY));
  const b = engine(kv);
  assert.deepEqual(await b.load(), { corrupt: false });
  assert.deepEqual(await b.view('eco'), sel);
});

test('壊れた保存文字列は上書きせず、操作を拒否する。空は空として始められる', async () => {
  const kv = new MemoryKv();
  kv.map.set(DIAG_KEY, '{oops');
  const e = engine(kv);
  assert.equal((await e.load()).corrupt, true);
  await assert.rejects(e.start('eco', ids('eco')));
  assert.equal(kv.map.get(DIAG_KEY), '{oops');

  const fresh = engine(new MemoryKv());
  assert.deepEqual(await fresh.load(), { corrupt: false });
  assert.equal((await fresh.view('eco')).kind, 'none');
});

test('保存の書込みが失敗しても、保存済みの原本は消えない', async () => {
  const kv = new MemoryKv();
  const e = engine(kv);
  await e.load();
  await e.start('qc-3', ids('qc-3'));
  const saved = kv.map.get(DIAG_KEY);
  kv.failNextWrites = 1;
  await assert.rejects(e.dismiss('qc-3'));
  assert.equal(kv.map.get(DIAG_KEY), saved);
});
