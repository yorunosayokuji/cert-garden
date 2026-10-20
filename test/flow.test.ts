import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StudyCore, MemoryStorage, BitPatternsContent } from '../src/index.ts';
import type { CoreEvent } from '../src/index.ts';
import { answerAndNext, correctIdOf, openCore, toFirstQuestion, wrongIdOf, FakeClock } from './helpers.ts';

const IT = 'it-passport';
const THEME = 'bit-patterns';

test('一巡: 導入→説明→中心6→再確認2→完了→箱庭成果（全問正解でも再確認は2問）', async () => {
  const { core, clock, events } = await openCore();
  let v = await core.startStage(IT, THEME);
  assert.equal(v.phase, 'intro');
  assert.equal(core.getGardenSnapshot().fruits, 7);
  const phases: string[] = [v.phase];
  v = (await core.advance(v.stageId, v.step)).view;
  phases.push(v.phase);
  v = (await core.advance(v.stageId, v.step)).view;
  const sequence: string[] = [];
  let completion;
  while (true) {
    assert.ok(v.question);
    sequence.push(`${v.phase}${v.progress.index}/${v.progress.total}`);
    clock.advance(30);
    const r = await answerAndNext(core, v);
    if (r.completion) {
      completion = r.completion;
      v = r.view;
      break;
    }
    v = r.view;
  }
  assert.deepEqual(phases, ['intro', 'explain']);
  assert.deepEqual(sequence, ['core1/8', 'core2/8', 'core3/8', 'core4/8', 'core5/8', 'core6/8', 'recheck7/8', 'recheck8/8']);
  assert.equal(v.phase, 'completed');
  assert.equal(completion.pointsAwarded, 10);
  assert.equal(completion.duplicate, false);
  assert.equal(completion.totalPoints, 10);
  assert.equal(completion.nextReview?.dueDate, '2026-10-13');
  assert.equal(completion.studySeconds, 240); // 8問×30秒
  const snap = core.getGardenSnapshot();
  assert.deepEqual(snap.completedThemes, ['it-passport/bit-patterns']);
  assert.equal(snap.fruits, 7, '完了・誤答で追加消費しない');
  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'fruit_consumed').length, 1);
  assert.ok(types.indexOf('stage_completed') < types.indexOf('review_scheduled'));
  assert.equal(types.filter((t) => t === 'stage_completed').length, 1);
});

test('選択と確定を分離し、確定前に正解・解説・正誤イベントを出さない', async () => {
  const { core, events } = await openCore();
  let v = await core.startStage(IT, THEME);
  v = await toFirstQuestion(core, v);
  const qid = v.question!.id;
  assert.equal(v.feedback, undefined);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('isCorrect') && !json.includes('explanation') && !json.includes('correctOptionId'), '確定前のビューに正解情報がない');
  await assert.rejects(core.confirm(v.stageId, qid), { code: 'NOT_ALLOWED' }, '未選択では確定できない');
  const wrong = wrongIdOf(core, v.stageId);
  const sel = await core.select(v.stageId, qid, wrong);
  assert.equal(sel.qState, 'choosing');
  assert.equal(sel.feedback, undefined);
  const selectEvent = events.find((e) => e.type === 'choice_selected') as Extract<CoreEvent, { type: 'choice_selected' }>;
  assert.deepEqual(Object.keys(selectEvent).sort(), ['cue', 'optionId', 'questionId', 'stageId', 'type']);
  assert.ok(!events.some((e) => e.type === 'answer_correct' || e.type === 'encouragement'), '確定前は正誤イベント無し');
  // 選び直せる
  await core.select(v.stageId, qid, correctIdOf(core, v.stageId));
  const done = await core.confirm(v.stageId, qid);
  assert.equal(done.feedback?.outcome, 'correct');
  assert.ok(events.some((e) => e.type === 'answer_correct'));
  await assert.rejects(core.confirm(v.stageId, qid), { code: 'NOT_ALLOWED' }, '確定後の再確定は不可');
});

test('誤答・わからないは追加消費せず、再確認は誤答した誤解を優先し数値と正解位置を変える', async () => {
  const { core } = await openCore();
  let v = await toFirstQuestion(core, await core.startStage(IT, THEME));
  const state0 = core.getState().stages[v.stageId]!;
  const coreBits = state0.questions.map((q) => q.validation && 'bits' in q.validation ? q.validation.bits : -1);
  // 1問目: 2n の誤解で誤答、2問目: わからない、残り正解
  const q1 = v.question!.id;
  await core.select(v.stageId, q1, wrongIdOf(core, v.stageId, 'multiply_not_power'));
  let r = await core.advance(v.stageId, (await core.confirm(v.stageId, q1)).step);
  v = r.view;
  const missedPosition = state0.questions[0]!.options.findIndex((o) => o.isCorrect);
  r = await answerAndNext(core, v, 'unknown');
  v = r.view;
  for (let i = 0; i < 4; i++) {
    r = await answerAndNext(core, v);
    v = r.view;
  }
  assert.equal(v.phase, 'recheck');
  assert.equal(core.getGardenSnapshot().fruits, 7);
  const st = core.getState().stages[v.stageId]!;
  assert.equal(st.questions.length, 8);
  const rechecks = st.questions.slice(6);
  for (const q of rechecks) {
    assert.equal(q.derivedFromQuestionId !== undefined, true);
    const bits = q.validation && 'bits' in q.validation ? q.validation.bits : undefined;
    if (bits !== undefined) assert.ok(!coreBits.includes(bits), '数値を変える');
    assert.equal(q.options.filter((o) => o.isCorrect).length, 1);
  }
  assert.equal(rechecks[0]!.derivedFromQuestionId, st.questions[0]!.id, '最も多く誤った誤解（2nと勘違い）の問題由来');
  assert.notEqual(rechecks[0]!.options.findIndex((o) => o.isCorrect), missedPosition, '誤答した問題と正解位置を変える');
  assert.ok(rechecks[0]!.options.some((o) => o.misconception === 'multiply_not_power'), '誤解を拾う選択肢を含む');
});

test('同じ資格のステージに他資格・統計問題を混ぜず、8問固定', async () => {
  const { core } = await openCore();
  const v = await core.startStage(IT, THEME);
  const st = core.getState().stages[v.stageId]!;
  assert.ok(st.questions.every((q) => q.id.startsWith('it-passport/bit-patterns@')));
  assert.equal(st.questions.length, 6);
});

test('ヒント前・ヒント後・同日再確認・後日の正解を区別し、同日だけで定着扱いにしない', async () => {
  const { core, clock } = await openCore();
  let v = await toFirstQuestion(core, await core.startStage(IT, THEME));
  // 1問目はヒントを見て正解、残りは正解
  await core.requestHint(v.stageId, v.question!.id);
  let r = await answerAndNext(core, v);
  v = r.view;
  const firstOutcome = core.getState().stages[v.stageId]!.answers[0]!.outcome;
  assert.equal(firstOutcome, 'hint_correct');
  while (!r.completion) {
    r = await answerAndNext(core, v);
    v = r.view;
  }
  let m = core.getState().mastery['it-passport/bit-patterns']!;
  assert.equal(m.hintCorrect, 1);
  assert.equal(m.firstCorrect, 5);
  assert.equal(m.sameDayRecheckCorrect, 2);
  assert.equal(m.laterCorrect, 0);
  assert.equal(m.level, 'same_day_only', '同日再確認だけでは「後日思い出せた」にならない');

  // 同じ日の復習は同日扱い
  let rv = await core.startReview(IT);
  while (rv.phase !== 'completed') {
    const x = await answerAndNext(core, rv);
    rv = x.view;
  }
  m = core.getState().mastery['it-passport/bit-patterns']!;
  assert.equal(m.laterCorrect, 0);
  assert.equal(m.level, 'same_day_only');

  // 翌日の復習で初めて後日の正解
  clock.advanceDays(1);
  rv = await core.startReview(IT);
  while (rv.phase !== 'completed') rv = (await answerAndNext(core, rv)).view;
  m = core.getState().mastery['it-passport/bit-patterns']!;
  assert.equal(m.laterCorrect, 2);
  assert.equal(m.level, 'recalled_later');
});

test('復習: 全問正解で間隔が広がり、誤答で翌日に戻る', async () => {
  const { core, clock } = await openCore();
  let v = await toFirstQuestion(core, await core.startStage(IT, THEME));
  let r = await answerAndNext(core, v);
  while (!r.completion) r = await answerAndNext(core, r.view);
  const due = () => core.getGardenSnapshot().nextReviews[0]!;
  assert.deepEqual([due().dueDate, due().step], ['2026-10-13', 0]);
  clock.advanceDays(1); // 10-13
  let rv = await core.startReview(IT);
  while (rv.phase !== 'completed') rv = (await answerAndNext(core, rv)).view;
  assert.deepEqual([due().dueDate, due().step], ['2026-10-16', 1]);
  clock.advanceDays(3); // 10-16
  rv = await core.startReview(IT);
  rv = (await answerAndNext(core, rv, 'wrong')).view;
  rv = (await answerAndNext(core, rv)).view;
  assert.equal(rv.phase, 'completed');
  assert.deepEqual([due().dueDate, due().step], ['2026-10-17', 0]);
  void v;
});

test('学習時間: 回答の合間は数えるが、放置は上限で切り、中断中は数えない', async () => {
  const { core, clock } = await openCore();
  let v = await core.startStage(IT, THEME);
  clock.advance(20);
  v = (await core.advance(v.stageId, v.step)).view; // +20
  clock.advance(600); // 放置
  v = (await core.advance(v.stageId, v.step)).view; // +120（上限）
  await core.interrupt(v.stageId);
  clock.advance(3600); // 中断中
  await core.resume(v.stageId);
  assert.equal(core.getGardenSnapshot().studySeconds[IT], 140);
});

test('購読側が遅い・例外でも回答処理を待たせない', async () => {
  const { core } = await openCore();
  core.subscribe(() => new Promise<void>(() => undefined)); // 永久に終わらない演出
  core.subscribe(() => {
    throw new Error('animation crashed');
  });
  let v = await toFirstQuestion(core, await core.startStage(IT, THEME));
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('blocked')), 1000));
  await Promise.race([answerAndNext(core, v), timeout]);
});

test('open: 空の保存から始められる（初期値は仮の8/10）', async () => {
  const core = await StudyCore.open({ storage: new MemoryStorage(), clock: new FakeClock(), content: new BitPatternsContent() });
  assert.equal(core.getGardenSnapshot().fruits, 8);
  assert.equal(core.getGardenSnapshot().maxFruits, 10);
});

test('復習予定: 予定日前の無料復習は間隔を延ばさず、予定日以降のヒントなし全問正解でだけ進む', async () => {
  const { core, clock } = await openCore();
  let r = await answerAndNext(core, await toFirstQuestion(core, await core.startStage(IT, THEME)));
  while (!r.completion) r = await answerAndNext(core, r.view);
  const due = () => core.getGardenSnapshot().nextReviews[0]!;
  const review = async (pick: 'correct' | 'wrong' | 'unknown' | 'hint' = 'correct') => {
    let rv = await core.startReview(IT);
    if (pick === 'hint') {
      await core.requestHint(rv.stageId, rv.question!.id);
      rv = (await answerAndNext(core, rv)).view;
    }
    while (rv.phase !== 'completed') rv = (await answerAndNext(core, rv, pick === 'hint' ? 'correct' : pick)).view;
  };
  const points = core.getGardenSnapshot().points;
  assert.deepEqual([due().dueDate, due().step], ['2026-10-13', 0]);
  // 10/12 当日に2回続けて正解しても予定は動かない・ポイントも増えない
  await review();
  await review();
  assert.deepEqual([due().dueDate, due().step], ['2026-10-13', 0]);
  assert.equal(core.getGardenSnapshot().points, points);
  // 予定日前のヒント利用・誤答は step0 のままで、既存より早い期日を遅らせない
  await review('hint');
  assert.deepEqual([due().dueDate, due().step], ['2026-10-13', 0]);
  await review('wrong');
  assert.deepEqual([due().dueDate, due().step], ['2026-10-13', 0]);
  // 予定日 10/13: ヒントなし全問正解で初めて進む
  clock.advanceDays(1);
  await review();
  assert.deepEqual([due().dueDate, due().step], ['2026-10-16', 1]);
  // 同日の繰り返しでは延びない
  await review();
  await review();
  assert.deepEqual([due().dueDate, due().step], ['2026-10-16', 1]);
  // 予定日 10/16: ヒント利用は進めず step0・翌日
  clock.advanceDays(3);
  await review('hint');
  assert.deepEqual([due().dueDate, due().step], ['2026-10-17', 0]);
  // 翌日（予定日）に誤答 → step0・翌日。不明も同様
  clock.advanceDays(1);
  await review('unknown');
  assert.deepEqual([due().dueDate, due().step], ['2026-10-18', 0]);
});
