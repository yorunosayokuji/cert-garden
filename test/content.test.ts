import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUALIFICATIONS, THEMES, buildBitTheme, makeBitQuestion, themeKey, validateQuestion, CORE_BITS } from '../src/index.ts';
import type { Question } from '../src/index.ts';

test('カタログ: 10資格・ID重複なし・級違いで水増ししない', () => {
  assert.equal(QUALIFICATIONS.length, 10);
  assert.equal(new Set(QUALIFICATIONS.map((q) => q.id)).size, 10);
  assert.equal(new Set(QUALIFICATIONS.map((q) => q.name)).size, 10, '同名（級違い）の重複登録がない');
  assert.ok(QUALIFICATIONS.every((q) => !/[0-9]級/.test(q.name)), '名前に級を混ぜない（gradeに分離）');
});

test('カタログ: 存在と教材完成を区別する（教材があるのはITパスポートの1テーマだけ）', () => {
  const authored = QUALIFICATIONS.filter((q) => q.contentStatus !== 'not_authored');
  assert.deepEqual(authored.map((q) => q.id), ['it-passport']);
  assert.equal(THEMES.length, 1);
  assert.notEqual(themeKey('it-passport', 'x'), themeKey('fp-3', 'x'), '資格が違えば同じテーマIDでも記録の鍵が混ざらない');
});

test('ビット問題: 3〜12ビットの全形式で機械検算に合格し、誤選択肢が正解と重ならない', () => {
  for (const form of ['count', 'bits_for'] as const) {
    for (let bits = 3; bits <= 12; bits++) {
      const q = makeBitQuestion(form, bits, `t-${form}-${bits}`, `seed-${bits}`);
      assert.deepEqual(validateQuestion(q), [], `${form} ${bits}`);
      const correct = q.options.filter((o) => o.isCorrect);
      assert.equal(correct.length, 1);
      // 実装(2**n)とは別の経路で期待値を出して照合
      const expected = form === 'count' ? Math.pow(2, bits) : bits;
      assert.equal(correct[0]!.value, expected);
      assert.ok(q.options.filter((o) => !o.isCorrect).every((o) => o.value !== expected));
      assert.equal(new Set(q.options.map((o) => o.value)).size, 4);
    }
  }
});

test('ビット問題: 4ビットでは 2n と 2^(n-1) が共に8で衝突するため別の誤選択肢に差し替える', () => {
  const q = makeBitQuestion('count', 4, 'q', 's');
  assert.deepEqual(q.options.map((o) => o.value).sort((a, b) => a! - b!), [4, 8, 16, 32]);
});

test('中心問題6問は 4/5/6/7/8/10 ビットで、数値違いのみ', () => {
  const t = buildBitTheme();
  assert.equal(t.coreQuestions.length, 6);
  assert.deepEqual(CORE_BITS, [4, 5, 6, 7, 8, 10]);
  const nums = t.coreQuestions.map((q) => q.options.find((o) => o.isCorrect)!.value);
  assert.deepEqual(nums, [16, 32, 64, 128, 256, 1024]);
});

const base = (): Question => makeBitQuestion('count', 8, 'q', 's');

test('検証器: 正解が複数の問題を拒否する', () => {
  const q = base();
  q.options.find((o) => !o.isCorrect)!.isCorrect = true;
  assert.ok(validateQuestion(q).some((p) => p.includes('正解が複数')));
});

test('検証器: 正解が無い問題を拒否する', () => {
  const q = base();
  q.options.forEach((o) => (o.isCorrect = false));
  assert.ok(validateQuestion(q).some((p) => p.includes('正解が無い')));
});

test('検証器: 選択肢の文・ID・数値の重複を拒否する', () => {
  const dupText = base();
  dupText.options[1]!.text = dupText.options[0]!.text;
  assert.ok(validateQuestion(dupText).some((p) => p.includes('文の重複')));
  const dupId = base();
  dupId.options[1]!.id = dupId.options[0]!.id;
  assert.ok(validateQuestion(dupId).some((p) => p.includes('IDの重複')));
  const dupVal = base();
  dupVal.options[0]!.value = dupVal.options[1]!.value; // 誤選択肢が正解と同値になる
  assert.ok(validateQuestion(dupVal).some((p) => p.includes('数値が重複')));
});

test('検証器: 検算値と違う選択肢が正解になっている問題（誤った解答キー）を拒否する', () => {
  const q = base();
  const correct = q.options.find((o) => o.isCorrect)!;
  const wrong = q.options.find((o) => !o.isCorrect)!;
  correct.isCorrect = false;
  wrong.isCorrect = true;
  assert.ok(validateQuestion(q).some((p) => p.includes('正解に設定されていない')));
});

test('検証器: 2の累乗でない通り数や、検算値の選択肢が無い問題を拒否する', () => {
  const q = makeBitQuestion('bits_for', 5, 'q', 's');
  q.validation = { type: 'bits_for_patterns', patterns: 30 };
  assert.ok(validateQuestion(q).some((p) => p.includes('検算条件が不正')));
  const q2 = base();
  q2.validation = { type: 'bit_patterns', bits: 9 }; // 512の選択肢が無い
  assert.ok(validateQuestion(q2).some((p) => p.includes('一致する選択肢が0個')));
});

test('データとして: 長い解説・無回答用のオプション無し構造も検査を通る（意味問題は構造検査のみ）', () => {
  const q: Question = {
    id: 'long', concept: 'c', prompt: 'p',
    options: [
      { id: 'a', text: 'x', isCorrect: true },
      { id: 'b', text: 'y', isCorrect: false },
    ],
    explanation: '長い解説。'.repeat(2000), hint: 'h', sources: [],
  };
  assert.deepEqual(validateQuestion(q), []);
});
