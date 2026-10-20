import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fruitEta } from '../src/state/format.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { NOTEBOOK_KEY, NotebookStore, type NotebookEntry } from '../src/state/notebook.ts';
import { CORE_KEY } from '../src/state/kvStorage.ts';

test('手帳: 旧データ(資格IDも取得の記録もない)をそのまま読み、新しい任意項目は往復して保存される。学習の保存とは別', async () => {
  const kv = new MemoryKv();
  const old = [{ id: 'a', name: 'ITパスポート', date: '2026-10-01', memo: 'めも' }];
  kv.map.set(NOTEBOOK_KEY, JSON.stringify(old));
  const s = new NotebookStore(kv);
  assert.deepEqual(await s.load(), old);
  const next: NotebookEntry[] = [...old, { id: 'b', name: 'FP技能検定 3級', date: '', memo: '', qualificationId: 'fp-3', passed: true }];
  await s.save(next);
  assert.deepEqual(await new NotebookStore(kv).load(), next);
  assert.ok(!kv.map.has(CORE_KEY));
  // 削除しても残りは変わらない
  await s.save(next.filter((e) => e.id !== 'a'));
  assert.deepEqual((await s.load()).map((e) => e.id), ['b']);
});

test('手帳: 壊れた項目(型違いの資格ID/取得の記録)は初期化せず例外にし、原文を残す。バッジや学習時間を自動付与しない', async () => {
  for (const bad of [[{ id: 'a', name: 'x', date: '', memo: '', qualificationId: 5 }], [{ id: 'a', name: 'x', date: '', memo: '', passed: 'yes' }]]) {
    const kv = new MemoryKv();
    const text = JSON.stringify(bad);
    kv.map.set(NOTEBOOK_KEY, text);
    await assert.rejects(new NotebookStore(kv).load());
    assert.equal(kv.map.get(NOTEBOOK_KEY), text);
  }
  const src = readFileSync(new URL('../src/ui/Tabs.tsx', import.meta.url), 'utf8');
  assert.match(src, /公式の証明ではありません/);
  assert.match(src, /自分の記録/);
  assert.ok(!/passed: true.*studySeconds|studySeconds.*passed: true/.test(src), '学習記録から合格を自動付与しない');
});

test('実までの表示: 分単位で切り上げ、1時間以上は時間表示、満タンは空', () => {
  const now = 1_000_000;
  assert.equal(fruitEta(null, now), '');
  assert.equal(fruitEta(now + 1, now), 'あと1分');
  assert.equal(fruitEta(now + 12 * 60_000, now), 'あと12分');
  assert.equal(fruitEta(now + 60 * 60_000, now), 'あと1時間');
  assert.equal(fruitEta(now + 90 * 60_000, now), 'あと1時間30分');
  assert.equal(fruitEta(now - 5, now), 'あと1分', '過ぎていても負にしない');
});

test('選択状態のDOM意味: radio/checkbox の Pressable には aria-checked を添える（見た目だけの☑にしない）', () => {
  const dir = new URL('../src/ui/', import.meta.url);
  const skip = new Set(['MotionLab.tsx', 'MotionStudy.tsx']); // 旧い見くらべ（通常の操作から外した）
  let seen = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !skip.has(n))) {
    const lines = readFileSync(new URL(f, dir), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/accessibilityRole="(radio|checkbox)"/.test(l)) return;
      seen++;
      const win = lines.slice(Math.max(0, i - 10), i + 10).join('\n');
      assert.match(win, /aria-checked=/, `${f}:${i + 1} に aria-checked がある`);
      assert.match(win, /role="(radio|checkbox)"/, `${f}:${i + 1} に role がある`);
    });
  }
  assert.ok(seen >= 10);
});

test('初回チェックの結果に内部のconcept IDを出さない', () => {
  const src = readFileSync(new URL('../src/ui/Diagnostic.tsx', import.meta.url), 'utf8');
  assert.ok(!/\.concept\b/.test(src));
});
