import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CompositeContent, CoreError, MemoryStorage, PackContent, QUALIFICATIONS, codes, listPackThemes, pickRecheck,
  type LearningPack, type Question, type StageView,
} from '../src/index.ts';
import { FakeClock, answerAndNext, openCore, toFirstQuestion } from './helpers.ts';

const pack = JSON.parse(readFileSync(new URL('../design-assets/app-completion-20261020/learning-pack.json', import.meta.url), 'utf8')) as LearningPack;
const content = () => new CompositeContent(new PackContent(pack));
const themes = listPackThemes(pack);

/** 学習を最後まで進める（毎回 pick で答える）。完了結果を返す */
async function finish(core: Awaited<ReturnType<typeof openCore>>['core'], v: StageView, pick: 'correct' | 'wrong' = 'correct') {
  let cur = await toFirstQuestion(core, v);
  for (let i = 0; i < 20; i++) {
    const r = await answerAndNext(core, cur, pick);
    if (r.completion) return r.completion;
    cur = r.view;
  }
  throw new Error('完了しない');
}

test('原稿: 10資格×2テーマ・120問を読み、資格はカタログと一致。基礎コースで監修なしの状態を落とさない', () => {
  assert.equal(themes.length, 20);
  assert.deepEqual([...new Set(themes.map((t) => t.qualificationId))].sort(), QUALIFICATIONS.map((q) => q.id).sort());
  for (const q of QUALIFICATIONS) assert.equal(themes.filter((t) => t.qualificationId === q.id).length, 2, q.id);
  assert.equal(themes.reduce((n, t) => n + t.questionCount, 0), 120);
  assert.ok(themes.every((t) => t.coverage === 'foundation_only' && t.humanSubjectReview === false && t.publicationStatus === 'local_draft'));
  assert.equal(pack.humanSubjectReview, false);
});

test('教材を読むと出典の role/status と検証状態が残り、正解の根拠として偽装されない', async () => {
  const c = await content().loadTheme('it-passport', 'transfer-rate');
  const q = c.coreQuestions[0]!;
  assert.ok(q.sources.length > 0);
  assert.ok(q.sources.every((s) => typeof s.role === 'string' && typeof s.status === 'string'));
  assert.ok(q.verification && typeof q.verification.type === 'string');
  const semantic = themes.flatMap((t) => pack.themes.find((x) => x.themeId === t.themeId)!.coreQuestions).filter((x) => x.verification?.type !== 'explicit_arithmetic');
  assert.ok(semantic.length > 0 && semantic.every((x) => /not independent expert review|pending/.test(String(x.verification?.semanticStatus))), '意味問題は作者の再確認までで、専門家の独立確認ではないと明示されたまま');
});

test('最新の原稿: 改稿した3テーマは版 foundation.2、ほかは .1 のまま。出典の役割/確認状態は全問に残り、専門監修とは表示されない', () => {
  const v2 = pack.themes.filter((t) => t.version.endsWith('.foundation.2'));
  assert.equal(v2.length, 3, '改稿は3テーマ');
  assert.ok(pack.themes.filter((t) => !v2.includes(t)).every((t) => t.version.endsWith('.foundation.1')));
  const all = pack.themes.flatMap((t) => t.coreQuestions);
  assert.equal(all.length, 120);
  assert.ok(all.every((q) => q.sources.length > 0 && q.sources.every((s) => typeof s.role === 'string' && typeof s.status === 'string')));
  assert.equal(pack.humanSubjectReview, false);
  assert.ok(pack.themes.every((t) => t.humanSubjectReview === false));
});

test('壊れた原稿は黙って通さない（検算違い・正解2つ・出典なし・テーマ重複）', () => {
  const bad = (f: (p: LearningPack) => void) => {
    const p = JSON.parse(JSON.stringify(pack)) as LearningPack;
    f(p);
    return () => new PackContent(p);
  };
  const calc = (p: LearningPack) => p.themes.flatMap((t) => t.coreQuestions).find((q) => q.verification?.type === 'explicit_arithmetic')!;
  assert.throws(bad((p) => { calc(p).verification!.expected = 9999; }), /検算値/);
  assert.throws(bad((p) => { const q = p.themes[0]!.coreQuestions[0]!; q.options.forEach((o) => { o.isCorrect = true; }); }), /正解が複数/);
  assert.throws(bad((p) => { p.themes[0]!.coreQuestions[0]!.sources = []; }), /出典/);
  assert.throws(bad((p) => { p.themes.push(p.themes[0]!); }), /重複/);
});

test('確認前のビューに正解・解説・出典を載せない（全20テーマ）', async () => {
  const rig = await openCore({ content: content(), config: { initialFruits: 20, maxFruits: 20 } });
  for (const t of themes) {
    const v = await toFirstQuestion(rig.core, await rig.core.startStage(t.qualificationId, t.themeId));
    const json = JSON.stringify(v);
    assert.ok(!json.includes('isCorrect') && !json.includes('whyWrong') && !json.includes('"sources"') && v.feedback === undefined, t.themeId);
    await rig.core.endStage(v.stageId);
  }
});

test('10資格それぞれ: テーマ選択→学習→結果→翌日の無料復習→再開が独立して動く', async () => {
  const storage = new MemoryStorage();
  const clock = new FakeClock();
  const rig = await openCore({ storage, clock, content: content(), config: { initialFruits: 10 } });
  for (const q of QUALIFICATIONS) {
    const t = themes.find((x) => x.qualificationId === q.id)!;
    const v = await rig.core.startStage(q.id, t.themeId);
    const done = await finish(rig.core, v);
    assert.equal(done.duplicate, false, q.id);
    assert.equal(done.pointsAwarded, 10, q.id);
    assert.ok(done.nextReview, q.id);
  }
  const snap = rig.core.getGardenSnapshot();
  assert.equal(snap.fruits, 0, '10資格×1ステージで実10個');
  assert.equal(snap.points, 100);
  assert.equal(snap.completedThemes.length, 10);
  assert.equal(snap.nextReviews.length, 10);

  assert.equal(rig.core.getGardenSnapshot().fruits, 0);
  clock.advanceDays(1);
  // 日付が進むと満タン（仮ルール）。復習は報酬・実を動かさず、2問。実0のままでも復習は別の試験で確認
  assert.equal(rig.core.getGardenSnapshot().fruits, 10);
  for (const q of QUALIFICATIONS) {
    const v = await rig.core.startReview(q.id);
    assert.equal(v.progress.total, 2);
    const done = await finish(rig.core, v);
    assert.equal(done.pointsAwarded, 0, q.id);
  }
  assert.equal(rig.core.getGardenSnapshot().fruits, 10, '復習で実は減らない');
  assert.equal(rig.core.getGardenSnapshot().points, 100);
  const m = Object.values(rig.core.getState().mastery);
  assert.ok(m.some((x) => x.laterCorrect > 0), '後日の正解は同日再確認と区別して数える');
});

test('途中再開: 再起動相当（別のコア）で同じ問題から続き、実は二重に減らない。同じ資格の別テーマも選べる', async () => {
  const storage = new MemoryStorage();
  const a = await openCore({ storage, content: content() });
  const v = await toFirstQuestion(a.core, await a.core.startStage('fp-3', themes.find((t) => t.qualificationId === 'fp-3')!.themeId));
  await answerAndNext(a.core, v, 'correct');
  await a.core.interrupt(v.stageId);
  const fruitsBefore = a.core.getGardenSnapshot().fruits;

  const b = await openCore({ storage, content: content() });
  assert.equal(b.core.findResumable()?.id, v.stageId);
  const resumed = await b.core.resume(v.stageId);
  assert.equal(resumed.progress.index, 2);
  assert.equal(b.core.getGardenSnapshot().fruits, fruitsBefore);
  // 別の資格を始めようとすると、途中の学習を先に続けるよう案内（二重消費しない）
  await assert.rejects(b.core.startStage('eco', themes.find((t) => t.qualificationId === 'eco')!.themeId), (e: unknown) => e instanceof CoreError && e.code === codes.activeStageExists);
  assert.equal(b.core.getGardenSnapshot().fruits, fruitsBefore);
});

test('再確認2問: 間違えた概念を優先し、別問があればそれを使い、選択肢順を変えて元IDを保持する。直前の問題を連続させない', async () => {
  const c = await content().loadTheme('it-passport', 'transfer-rate');
  const core = c.coreQuestions as Question[];
  const concepts = new Set(core.map((q) => q.concept));
  assert.ok(concepts.size < core.length, 'テーマに同じ概念の問題が複数ある');
  const wrong = core[0]!;
  const weak = [{ questionId: wrong.id, misconception: 'x', correctPosition: wrong.options.findIndex((o) => o.isCorrect) }];
  const r = pickRecheck({ seed: 'seed-1', weak, coreQuestions: core });
  assert.equal(r.length, 2);
  assert.equal(r[0]!.concept, wrong.concept, '間違えた概念を先に');
  assert.notEqual(r[0]!.derivedFromQuestionId, wrong.id, '同じ概念の別の問題を使う');
  assert.ok(r.every((q) => q.id.endsWith('#recheck') && core.some((o) => o.id === q.derivedFromQuestionId)));
  assert.equal(new Set(r.map((q) => q.id)).size, 2);
  for (const q of r) {
    const orig = core.find((o) => o.id === q.derivedFromQuestionId)!;
    assert.deepEqual(q.options.map((o) => o.id).sort(), orig.options.map((o) => o.id).sort());
    assert.notEqual(q.options.findIndex((o) => o.isCorrect), orig.options.findIndex((o) => o.isCorrect), '正解位置が前と同じにならない');
    assert.equal(q.options.filter((o) => o.isCorrect).length, 1);
  }
  assert.notEqual(r[0]!.derivedFromQuestionId, core[core.length - 1]!.id);
  // 同じ種で再現し、別の種では変わりうる
  assert.deepEqual(pickRecheck({ seed: 'seed-1', weak, coreQuestions: core }), r);
});

test('全問誤答でも学習は完了でき、実は戻らず、結果は誤答を数え、復習は短い間隔に戻る', async () => {
  const rig = await openCore({ content: content() });
  const t = themes.find((x) => x.qualificationId === 'qc-3')!;
  const done = await finish(rig.core, await rig.core.startStage('qc-3', t.themeId), 'wrong');
  assert.equal(done.pointsAwarded, 10);
  const s = Object.values(rig.core.getState().stages)[0]!;
  assert.equal(s.answers.length, 8);
  assert.ok(s.answers.every((a) => !a.correct));
  assert.equal(rig.core.getGardenSnapshot().fruits, 7);
  assert.equal(done.nextReview?.step, 0);
});

test('既存のビット列教材は保持され、未登録のテーマは読み込みエラーになる', async () => {
  const rig = await openCore({ content: content() });
  const v = await rig.core.startStage('it-passport', 'bit-patterns');
  assert.equal(v.progress.total, 8);
  await rig.core.endStage(v.stageId);
  await assert.rejects(rig.core.startStage('eco', 'no-such-theme'), (e: unknown) => e instanceof CoreError && e.code === codes.contentLoad);
  assert.equal(rig.core.getGardenSnapshot().fruits, 7, '失敗した開始では実を使わない');
});
