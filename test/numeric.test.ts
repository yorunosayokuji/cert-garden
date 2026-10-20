import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CompositeContent, CoreError, MemoryStorage, PackContent, codes, listPackThemes, parseNumberInput, shortAnswerOf,
  type LearningPack, type StageView,
} from '../src/index.ts';
import { FakeClock, openCore, toFirstQuestion } from './helpers.ts';

const pack = JSON.parse(readFileSync(new URL('../design-assets/app-completion-20261020/learning-pack.json', import.meta.url), 'utf8')) as LearningPack;
const content = () => new CompositeContent(new PackContent(pack));
const numericThemes = listPackThemes(pack).filter((t) => t.numericCount > 0);
const T = numericThemes.find((t) => t.themeId === 'transfer-rate')!;
const allQ = pack.themes.flatMap((t) => t.coreQuestions);
const keyOf = (prompt: string) => allQ.find((q) => q.prompt === prompt)!;
const clone = <X>(v: X) => JSON.parse(JSON.stringify(v)) as X;
const isErr = (code: string) => (e: unknown) => e instanceof CoreError && e.code === code;

test('入力の解析: 全角・空白・Unicodeの負号・正しい3桁区切り・同じ明示単位だけ許す', () => {
  const ok: [string, string, number][] = [
    ['8', '', 8], [' 8 ', '', 8], ['８', '', 8], ['1,000', '', 1000], ['１，０００', '', 1000], ['−5', '', -5], ['－5', '', -5], ['+3', '', 3], ['37.5', '', 37.5],
    ['0.5', '', 0.5], ['1,234,567.25', '', 1234567.25], ['8秒', '秒', 8], ['8 秒', '秒', 8], ['８秒', '秒', 8], ['37.5%', '%', 37.5], ['37.5％', '%', 37.5], ['30万円', '万円', 30], ['24Mビット', 'Mビット', 24],
  ];
  for (const [raw, unit, v] of ok) {
    const p = parseNumberInput(raw, unit);
    assert.ok(p.ok && p.value === v, `${raw} → ${v}`);
  }
  const bad: [string, string][] = [
    ['', ''], ['   ', ''], ['abc', ''], ['NaN', ''], ['Infinity', ''], ['-Infinity', ''], ['1e3', ''], ['1E3', ''], ['0x10', ''], ['1/2', ''], ['１／２', ''], ['1 000', ''], ['1 0', ''],
    ['1,00', ''], ['1,0000', ''], [',100', ''], ['1,,000', ''], ['1.', ''], ['.5', ''], ['--1', ''], ['1-', ''], ['007', ''], ['八', ''], ['約8', ''], ['8秒', ''], ['8分', '秒'], ['8Mビット/秒', 'Mビット'],
    ['8Mビット', 'Mビット/秒'], ['8円', '万円'], ['秒', '秒'], ['9'.repeat(14), ''], ['1,0', ''],
  ];
  for (const [raw, unit] of bad) assert.equal(parseNumberInput(raw, unit).ok, false, `${raw} (${unit}) は入力エラー`);
});

test('原稿の数値60問: 解答キー(正解選択肢のvalue・誤選択肢・shortAnswerの値と単位)が検算値と一致する', () => {
  assert.equal(numericThemes.reduce((n, t) => n + t.numericCount, 0), 60);
  const numeric = allQ.filter((q) => shortAnswerOf(q));
  assert.equal(numeric.length, 60);
  for (const q of numeric) {
    const v = q.verification as { expected: number; unit: string };
    const sa = shortAnswerOf(q)!;
    assert.equal(q.options.find((o) => o.isCorrect)!.value, v.expected, q.id);
    assert.ok(q.options.filter((o) => !o.isCorrect).every((o) => o.value !== v.expected), q.id);
    assert.equal(sa.accepted[0], v.expected);
    assert.equal(sa.unit, v.unit);
  }
});

test('解答キーの誤りは原稿の入口で拒否（検算のexpectedだけ正しくても通さない）', () => {
  const bad = (f: (p: LearningPack) => void) => () => {
    const p = clone(pack);
    f(p);
    return new PackContent(p);
  };
  const firstNum = (p: LearningPack) => p.themes.flatMap((t) => t.coreQuestions).find((q) => q.shortAnswer)!;
  assert.throws(bad((p) => { const q = firstNum(p); q.options.find((o) => o.isCorrect)!.value = 999; }), /正解の選択肢の値/);
  assert.throws(bad((p) => { const q = firstNum(p); delete q.options.find((o) => o.isCorrect)!.value; }), /value/);
  assert.throws(bad((p) => { const q = firstNum(p); q.options.find((o) => !o.isCorrect)!.value = (q.verification as { expected: number }).expected; }), /同じ値|重複/);
  assert.throws(bad((p) => { (firstNum(p).shortAnswer as { accepted: string[] }).accepted = ['9999']; }), /shortAnswer/);
  assert.throws(bad((p) => { (firstNum(p).shortAnswer as { unit: string }).unit = '個'; }), /単位/);
  assert.throws(bad((p) => { (firstNum(p).shortAnswer as { accepted: unknown }).accepted = [8]; }), /shortAnswer/);
});

/** 現在の問題が数字入力なら、その正解の数値を原稿から得る（テスト専用） */
const numericKey = (v: StageView) => {
  const q = keyOf(v.question!.prompt);
  return Number(shortAnswerOf(q)!.accepted[0]);
};

test('数字入力ステージ: 選択肢と解答キーを出さず、形式エラーは記録を進めず、誤った値は入力値を残してwrong、正解は先出ししない', async () => {
  const rig = await openCore({ content: content() });
  const { core } = rig;
  let v = await toFirstQuestion(core, await core.startStage('it-passport', 'transfer-rate', { answerMode: 'number' }));
  assert.equal(v.answerMode, 'number');
  assert.ok(v.question!.input, '最初の問題は数字入力');
  assert.deepEqual(v.question!.options, []);
  const json = JSON.stringify(v);
  assert.ok(!/accepted|expected|isCorrect|shortAnswer|"value"|whyWrong/.test(json) && v.feedback === undefined);
  assert.equal(v.question!.input!.unit, '秒');

  const qid = v.question!.id;
  const before = core.getState().stages[v.stageId]!;
  const answersBefore = before.answers.length;
  for (const badText of ['', 'abc', '1e3', '8分', '1 000', 'NaN', '１／２']) {
    await assert.rejects(core.submitNumber(v.stageId, qid, badText), isErr(codes.invalidInput), badText);
  }
  const after = core.getState().stages[v.stageId]!;
  assert.equal(after.answers.length, answersBefore, '入力エラーは回答を記録しない');
  assert.equal(after.step, before.step, '入力エラーでstepも進まない');
  assert.equal(core.getGardenSnapshot().fruits, 7);
  // 選択肢の経路は閉じている
  await assert.rejects(core.select(v.stageId, qid, 'o1'), isErr(codes.notAllowed));
  await assert.rejects(core.confirm(v.stageId, qid), isErr(codes.notAllowed));

  const key = numericKey(v);
  const wrong = await core.submitNumber(v.stageId, qid, `${key + 7}秒`);
  assert.equal(wrong.feedback?.outcome, 'wrong');
  assert.equal(wrong.feedback?.input?.entered, `${key + 7}`);
  assert.equal(wrong.feedback?.input?.correctAnswer, `${key}秒`);
  const rec = core.getState().stages[v.stageId]!.answers.at(-1)!;
  assert.deepEqual(rec.input, { raw: `${key + 7}`, value: key + 7 });
  assert.equal(rec.optionId, null);
  assert.equal(rec.misconception, undefined, '第1誤選択肢を選んだことにしない');
  assert.equal(rec.correct, false);
  // 二重確認(連打)は回答を増やさない
  await assert.rejects(core.submitNumber(v.stageId, qid, `${key}`), isErr(codes.notAllowed));
  assert.equal(core.getState().stages[v.stageId]!.answers.length, answersBefore + 1);
});

test('正解・ヒント後正解・わからない・同時送信: 数字入力でも outcome が正しく、二重に数えない', async () => {
  const rig = await openCore({ content: content(), config: { initialFruits: 10 } });
  const { core } = rig;
  let v = await toFirstQuestion(core, await core.startStage('it-passport', 'transfer-rate', { answerMode: 'number' }));
  // 1問目: 正解（全角の数字＋単位）
  const key = numericKey(v);
  const [a, b] = await Promise.allSettled([core.submitNumber(v.stageId, v.question!.id, `${String(key).replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)))}秒`), core.submitNumber(v.stageId, v.question!.id, `${key}`)]);
  assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected']);
  const st = () => core.getState().stages[v.stageId]!;
  assert.equal(st().answers.length, 1);
  assert.equal(st().answers[0]!.outcome, 'correct');
  v = (await core.advance(v.stageId, core.getStageView(v.stageId).step)).view;
  // 次の問題: ヒント→正解
  while (!v.question!.input) {
    // 4択の問題は正解して進める
    const q = keyOf(v.question!.prompt);
    await core.select(v.stageId, v.question!.id, q.options.find((o) => o.isCorrect)!.id);
    const c = await core.confirm(v.stageId, v.question!.id);
    v = (await core.advance(c.stageId, c.step)).view;
  }
  await core.requestHint(v.stageId, v.question!.id);
  const hc = await core.submitNumber(v.stageId, v.question!.id, `${numericKey(core.getStageView(v.stageId))}`);
  assert.equal(hc.feedback?.outcome, 'hint_correct');
  v = (await core.advance(hc.stageId, hc.step)).view;
  while (!v.question!.input) {
    const q = keyOf(v.question!.prompt);
    await core.select(v.stageId, v.question!.id, q.options.find((o) => o.isCorrect)!.id);
    const c = await core.confirm(v.stageId, v.question!.id);
    v = (await core.advance(c.stageId, c.step)).view;
  }
  const unk = await core.dontKnow(v.stageId, v.question!.id);
  assert.equal(unk.feedback?.outcome, 'unknown');
  assert.equal(st().answers.at(-1)!.input, undefined);
  assert.equal(unk.feedback?.input?.entered, '');
});

test('入力方式はステージと一緒に保存: 中断→再起動でも数字入力のまま。旧ステージ(answerModeなし)は4択として読む', async () => {
  const storage = new MemoryStorage();
  const a = await openCore({ storage, content: content() });
  const v = await toFirstQuestion(a.core, await a.core.startStage('it-passport', 'transfer-rate', { answerMode: 'number' }));
  await a.core.interrupt(v.stageId);
  const b = await openCore({ storage, content: content() });
  const resumed = await b.core.resume(v.stageId);
  assert.equal(resumed.answerMode, 'number');
  assert.ok(resumed.question?.input);
  // 再度「4択で」開始を要求しても、進行中のステージは入力方式を変えず再開する
  const again = await b.core.startStage('it-passport', 'transfer-rate', { answerMode: 'choice' });
  assert.equal(again.stageId, v.stageId);
  assert.equal(again.answerMode, 'number');

  // 旧保存: answerMode を取り除く
  const old = JSON.parse(JSON.stringify(b.core.getState())) as { stages: Record<string, { answerMode?: string }> };
  delete old.stages[v.stageId]!.answerMode;
  const st2 = new MemoryStorage();
  st2.setRaw(JSON.stringify(old));
  const c = await openCore({ storage: st2, content: content() });
  const legacy = await c.core.resume(v.stageId);
  assert.equal(legacy.answerMode, 'choice');
  assert.ok(legacy.question!.options.length >= 2 && !legacy.question!.input);
  await assert.rejects(c.core.submitNumber(v.stageId, legacy.question!.id, '8'), isErr(codes.notAllowed));
});

test('初期は4択。数字入力にできない教材(数値なし)は開始せず実も使わない。数字入力でも4択の問題は選択肢で答える', async () => {
  const rig = await openCore({ content: content() });
  const four = await rig.core.startStage('eco', themeIdsOf('eco')[0]!);
  assert.equal(four.answerMode, 'choice');
  await rig.core.endStage(four.stageId);
  const fruits = rig.core.getGardenSnapshot().fruits;
  await assert.rejects(rig.core.startStage('it-passport', 'bit-patterns', { answerMode: 'number' }), isErr(codes.notAllowed));
  assert.equal(rig.core.getGardenSnapshot().fruits, fruits);
  // 数字入力ステージにも4択の問題が混ざる（意味問題はそのまま4択）
  // 原稿には数値と意味が混ざるテーマが無いので、原稿の問題を組み合わせた試験用テーマで確かめる
  const base = clone(pack);
  const numQs = clone(pack.themes.find((t) => t.themeId === 'transfer-rate')!.coreQuestions.filter((q) => q.shortAnswer).slice(0, 2));
  const choiceQs = clone(pack.themes.find((t) => t.themeId !== 'transfer-rate' && t.coreQuestions.every((q) => !q.shortAnswer))!.coreQuestions.slice(0, 2));
  const mixed = { ...clone(base.themes[0]!), qualificationId: 'it-passport', themeId: 'mixed-test', version: 'mixed.1', coreQuestions: [numQs[0]!, choiceQs[0]!, numQs[1]!, choiceQs[1]!].map((q, i) => ({ ...q, id: `mixed:${i}` })) };
  base.themes.push(mixed);
  const rig2 = await openCore({ content: new CompositeContent(new PackContent(base)) });
  {
    const s = await toFirstQuestion(rig2.core, await rig2.core.startStage(mixed.qualificationId, mixed.themeId, { answerMode: 'number' }));
    const seen = { numeric: 0, choice: 0 };
    let cur = s;
    for (let i = 0; i < mixed.coreQuestions.length; i++) {
      const q = keyOf(cur.question!.prompt);
      if (cur.question!.input) {
        seen.numeric++;
        const r = await rig2.core.submitNumber(cur.stageId, cur.question!.id, String(shortAnswerOf(q)!.accepted[0]));
        cur = (await rig2.core.advance(r.stageId, r.step)).view;
      } else {
        seen.choice++;
        assert.ok(cur.question!.options.length >= 2, '意味の問題は4択のまま');
        await rig2.core.select(cur.stageId, cur.question!.id, q.options.find((o) => o.isCorrect)!.id);
        const c = await rig2.core.confirm(cur.stageId, cur.question!.id);
        cur = (await rig2.core.advance(c.stageId, c.step)).view;
      }
    }
    assert.deepEqual(seen, { numeric: 2, choice: 2 });
  }
});
const themeIdsOf = (q: string) => listPackThemes(pack).filter((t) => t.qualificationId === q).map((t) => t.themeId);

test('再確認・無料復習も数字入力のまま続く（実・ポイントは動かさず、元の問題IDを保持）', async () => {
  const clock = new FakeClock();
  const rig = await openCore({ content: content(), clock });
  const { core } = rig;
  let v = await toFirstQuestion(core, await core.startStage('it-passport', 'transfer-rate', { answerMode: 'number' }));
  let sawRecheckNumeric = false;
  for (let i = 0; i < 20; i++) {
    const baseId = v.question!.id.replace('#recheck', '');
    const q = allQ.find((x) => x.id === baseId)!;
    let r;
    if (v.question!.input) {
      if (v.phase === 'recheck') sawRecheckNumeric = true;
      const s = await core.submitNumber(v.stageId, v.question!.id, String(shortAnswerOf(q)!.accepted[0]));
      r = await core.advance(s.stageId, s.step);
    } else {
      await core.select(v.stageId, v.question!.id, q.options.find((o) => o.isCorrect)!.id);
      const c = await core.confirm(v.stageId, v.question!.id);
      r = await core.advance(c.stageId, c.step);
    }
    if (r.completion) {
      assert.equal(r.completion.pointsAwarded, 10);
      break;
    }
    v = r.view;
  }
  assert.ok(sawRecheckNumeric || core.getState().stages[v.stageId]!.questions.slice(-2).every((q) => !shortAnswerOf(q)), '再確認でも数字入力の問題は数字入力のまま');
  const points = core.getGardenSnapshot().points;
  clock.advanceDays(1);
  const fruits = core.getGardenSnapshot().fruits; // 日付が進んだ分の満タン後。復習で変わらないことを確かめる
  let rv = await core.startReview('it-passport', { answerMode: 'number' });
  assert.equal(rv.answerMode, 'number');
  assert.ok(core.getState().stages[rv.stageId]!.questions.some((q) => shortAnswerOf(q)), '復習に数字入力の問題が入る');
  for (let i = 0; i < 2; i++) {
    const baseId = rv.question!.id.replace('#recheck', '');
    const q = allQ.find((x) => x.id === baseId)!;
    let r;
    if (rv.question!.input) {
      const s = await core.submitNumber(rv.stageId, rv.question!.id, `${shortAnswerOf(q)!.accepted[0]}${shortAnswerOf(q)!.unit}`);
      r = await core.advance(s.stageId, s.step);
    } else {
      await core.select(rv.stageId, rv.question!.id, q.options.find((o) => o.isCorrect)!.id);
      const c = await core.confirm(rv.stageId, rv.question!.id);
      r = await core.advance(c.stageId, c.step);
    }
    if (r.completion) {
      assert.equal(r.completion.pointsAwarded, 0);
      break;
    }
    rv = r.view;
  }
  assert.equal(core.getGardenSnapshot().points, points);
  assert.equal(core.getGardenSnapshot().fruits, fruits);
  const later = Object.values(core.getState().stages).find((s) => s.kind === 'review')!;
  assert.ok(later.answers.every((a) => a.relation === 'later_review'));
  assert.ok(later.questions.every((q) => q.derivedFromQuestionId));
});

test('数字を入れる欄のある問題は全資格で開始できる（数値のあるテーマ）', async () => {
  const rig = await openCore({ content: content(), config: { initialFruits: 20, maxFruits: 20 } });
  for (const t of numericThemes) {
    const v = await rig.core.startStage(t.qualificationId, t.themeId, { answerMode: 'number' });
    assert.equal(v.answerMode, 'number', t.themeId);
    await rig.core.endStage(v.stageId);
  }
  assert.ok(numericThemes.length >= 10);
});
