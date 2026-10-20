import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuestionHolds, type QuestionRef } from '../../src/mobile.ts';
import { HOLDS_KEY, KvHoldStorage } from '../src/state/holdStore.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { CORE_KEY } from '../src/state/kvStorage.ts';
import { DEFAULT_QUAL, LEARN_PREFS_KEY, LearnPrefsStore } from '../src/state/learnPrefs.ts';

const ref: QuestionRef = { questionId: 'eco:t1:3', qualificationId: 'eco', themeId: 't1', contentVersion: 'v1', prompt: '問題文' };
const holds = (kv: MemoryKv, now = 1000) => new QuestionHolds({ storage: new KvHoldStorage(kv), clock: { now: () => now }, newId: () => 'r1' });

test('端末の保存: 保留と記録は専用キーに残り、再読込で復帰。学習の保存には触れない。解除も保存される', async () => {
  const kv = new MemoryKv();
  const a = holds(kv);
  await a.load();
  await a.report(ref, 'explanation', 'メモ', true);
  assert.deepEqual([...kv.map.keys()], [HOLDS_KEY]);
  assert.ok(!kv.map.has(CORE_KEY));
  const b = holds(kv, 2000);
  await b.load();
  assert.equal(b.list().length, 1);
  assert.equal(b.reports()[0]!.memo, 'メモ');
  assert.equal(b.isHeld('eco:t1:3#recheck'), true);
  await b.release('eco:t1:3');
  const c = holds(kv);
  await c.load();
  assert.equal(c.list().length, 0);
  assert.equal(c.reports().length, 1, '解除しても記録は残る');
});

test('壊れた保存文字列・書込み失敗でも原本は消えない', async () => {
  const kv = new MemoryKv();
  kv.map.set(HOLDS_KEY, '{oops');
  const a = holds(kv);
  assert.equal((await a.load()).corrupt, true);
  await assert.rejects(a.hold(ref));
  assert.equal(kv.map.get(HOLDS_KEY), '{oops');

  const kv2 = new MemoryKv();
  const b = holds(kv2);
  await b.load();
  await b.hold(ref);
  const saved = kv2.map.get(HOLDS_KEY);
  kv2.failNextWrites = 1;
  await assert.rejects(b.release('eco:t1:3'));
  assert.equal(kv2.map.get(HOLDS_KEY), saved);
  assert.equal(b.list().length, 1, '失敗した解除は反映されない');
});

test('学ぶ画面の資格の保存: 最後に選んだ資格を覚え、知らない値・壊れた値は既定に戻し、学習の保存に触れない', async () => {
  const kv = new MemoryKv();
  const s = new LearnPrefsStore(kv);
  assert.equal(await s.load(), DEFAULT_QUAL);
  await s.save('fp-3');
  assert.equal(await new LearnPrefsStore(kv).load(), 'fp-3');
  assert.deepEqual([...kv.map.keys()], [LEARN_PREFS_KEY]);
  kv.map.set(LEARN_PREFS_KEY, JSON.stringify({ qualificationId: 'ghost' }));
  assert.equal(await s.load(), DEFAULT_QUAL);
  kv.map.set(LEARN_PREFS_KEY, '{x');
  assert.equal(await s.load(), DEFAULT_QUAL);
});
