import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JsonFileStorage, MemoryStorage, StudyCore } from '../src/index.ts';
import {
  FakeClock, FlakyStorage, StubContent, answerAndNext, correctIdOf, openCore, stubTheme, tempJsonPath, toFirstQuestion,
} from './helpers.ts';

const IT = 'it-passport';
const THEME = 'bit-patterns';

test('中断→別インスタンスで再開: 同じ問題・回答・実の消費が維持され二重消費しない（JSONファイル）', async () => {
  const path = await tempJsonPath();
  const clock = new FakeClock();
  const a = await openCore({ storage: new JsonFileStorage(path), clock });
  let v = await toFirstQuestion(a.core, await a.core.startStage(IT, THEME));
  for (let i = 0; i < 3; i++) v = (await answerAndNext(a.core, v, i === 1 ? 'wrong' : 'correct')).view;
  await a.core.requestHint(v.stageId, v.question!.id);
  await a.core.interrupt(v.stageId);
  const idBefore = v.stageId;
  const answersBefore = a.core.getState().stages[idBefore]!.answers;

  // ---- アプリ再起動相当: 別インスタンスを同じファイルから起動 ----
  clock.advance(7200);
  const b = await openCore({ storage: new JsonFileStorage(path), clock, idPrefix: 'other' });
  // 閉じている間の2時間は端末の時計で数える（7→9）。消費の分が戻ったり、二重に消えたりしない
  assert.equal(b.core.getGardenSnapshot().fruits, 9);
  const resumable = b.core.findResumable();
  assert.equal(resumable?.id, idBefore);
  assert.equal(resumable?.status, 'paused');
  const rv = await b.core.startStage(IT, THEME); // 二重開始 = 再開
  assert.equal(rv.stageId, idBefore);
  assert.equal(rv.progress.index, 4);
  assert.equal(rv.question?.hintShown, true, 'ヒント表示も維持');
  assert.equal(b.core.getGardenSnapshot().fruits, 9, '再開で二重消費しない');
  assert.deepEqual(b.core.getState().stages[idBefore]!.answers, answersBefore);
  assert.equal(b.events.filter((e) => e.type === 'fruit_consumed').length, 0);
  // 続きから最後まで進めて完了、さらに別インスタンスで再送しても報酬は1回
  let r = await answerAndNext(b.core, rv);
  while (!r.completion) r = await answerAndNext(b.core, r.view);
  assert.equal(r.completion.totalPoints, 10);
  const c = await openCore({ storage: new JsonFileStorage(path), clock });
  const again = await c.core.advance(idBefore, 0);
  assert.equal(again.completion?.duplicate, true);
  assert.equal(again.completion?.pointsAwarded, 0);
  assert.equal(c.core.getGardenSnapshot().points, 10);
  assert.equal(c.core.getGardenSnapshot().fruits, 9, '完了の再送でも実は増減しない（時計の回復は2時間分のまま）');
});

test('二重完了: 連打（並行）・再読込み・保存後の再送のどれでも報酬は1回', async () => {
  const path = await tempJsonPath();
  const a = await openCore({ storage: new JsonFileStorage(path) });
  let v = await toFirstQuestion(a.core, await a.core.startStage(IT, THEME));
  for (let i = 0; i < 7; i++) v = (await answerAndNext(a.core, v)).view;
  // 最後の問題: 回答 → 完了の「次へ」を同時に5回連打
  const qid = v.question!.id;
  await a.core.select(v.stageId, qid, correctIdOf(a.core, v.stageId));
  const fin = await a.core.confirm(v.stageId, qid);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => a.core.advance(fin.stageId, fin.step)));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const completedFresh = ok.filter((r) => r.status === 'fulfilled' && r.value.completion?.duplicate === false);
  assert.equal(completedFresh.length, 1, '新規完了は1回だけ');
  assert.equal(a.core.getGardenSnapshot().points, 10);
  assert.equal(a.events.filter((e) => e.type === 'stage_completed').length, 1);
  // 再読込み
  const b = await openCore({ storage: new JsonFileStorage(path) });
  const re = await b.core.advance(fin.stageId, fin.step);
  assert.equal(re.completion?.duplicate, true);
  assert.equal(b.core.getGardenSnapshot().points, 10);
  assert.equal(Object.keys(b.core.getState().completions).length, 1);
});

test('保存失敗: 完了時に失敗しても報酬は付与されず、再試行で1回だけ付与される', async () => {
  const flaky = new FlakyStorage(new MemoryStorage());
  const a = await openCore({ storage: flaky });
  let v = await toFirstQuestion(a.core, await a.core.startStage(IT, THEME));
  for (let i = 0; i < 7; i++) v = (await answerAndNext(a.core, v)).view;
  const qid = v.question!.id;
  await a.core.select(v.stageId, qid, correctIdOf(a.core, v.stageId));
  const fin = await a.core.confirm(v.stageId, qid);
  flaky.failNextSaves = 1;
  await assert.rejects(a.core.advance(fin.stageId, fin.step), { code: 'STORAGE_WRITE_FAILED' });
  assert.equal(a.core.getGardenSnapshot().points, 0, '失敗時は報酬なし');
  assert.ok(!a.events.some((e) => e.type === 'stage_completed'), '失敗時はイベントも出さない');
  const retry = await a.core.advance(fin.stageId, fin.step);
  assert.equal(retry.completion?.duplicate, false);
  assert.equal(retry.completion?.totalPoints, 10);
  // 保存済みの内容も1回分
  const re = await openCore({ storage: flaky.inner });
  assert.equal(re.core.getGardenSnapshot().points, 10);
});

test('保存失敗: 開始時に失敗しても実は消費されず、再試行できる', async () => {
  const flaky = new FlakyStorage(new MemoryStorage());
  const a = await openCore({ storage: flaky });
  flaky.failNextSaves = 1;
  await assert.rejects(a.core.startStage(IT, THEME), { code: 'STORAGE_WRITE_FAILED' });
  assert.equal(a.core.getGardenSnapshot().fruits, 8);
  assert.equal(a.core.findResumable(), undefined);
  assert.equal(a.events.length, 0);
  await a.core.startStage(IT, THEME);
  assert.equal(a.core.getGardenSnapshot().fruits, 7);
});

test('教材の読込み失敗・不正教材では実を消費しない', async () => {
  const content = new StubContent(new Error('network down'));
  const a = await openCore({ content });
  await assert.rejects(a.core.startStage(IT, THEME), { code: 'CONTENT_LOAD_FAILED' });
  assert.equal(a.core.getGardenSnapshot().fruits, 8);

  const bad = stubTheme();
  bad.coreQuestions[0]!.options[1]!.isCorrect = true; // 正解が2つ
  content.theme = bad;
  await assert.rejects(a.core.startStage(IT, THEME), { code: 'CONTENT_INVALID' });
  const dup = stubTheme();
  dup.coreQuestions[1]!.options[1]!.text = dup.coreQuestions[1]!.options[0]!.text; // 選択肢重複
  content.theme = dup;
  await assert.rejects(a.core.startStage(IT, THEME), { code: 'CONTENT_INVALID' });
  assert.equal(a.core.getGardenSnapshot().fruits, 8);
  assert.equal(Object.keys(a.core.getState().stages).length, 0);
});

test('実0: 新規ステージは開始できず状態も作らないが、無料復習は開始でき消費しない', async () => {
  const a = await openCore({ config: { initialFruits: 1 } });
  let v = await toFirstQuestion(a.core, await a.core.startStage(IT, THEME));
  let r = await answerAndNext(a.core, v);
  while (!r.completion) r = await answerAndNext(a.core, r.view);
  assert.equal(a.core.getGardenSnapshot().fruits, 0);
  const stagesBefore = Object.keys(a.core.getState().stages).length;
  await assert.rejects(a.core.startStage(IT, THEME), { code: 'NO_FRUITS' });
  assert.equal(Object.keys(a.core.getState().stages).length, stagesBefore);
  const rv = await a.core.startReview(IT);
  assert.equal(rv.phase, 'recheck');
  assert.equal(rv.progress.total, 2);
  assert.equal(a.core.getGardenSnapshot().fruits, 0);
  // 復習中の誤答でも追加消費・マイナスにならない
  await answerAndNext(a.core, rv, 'wrong');
  assert.equal(a.core.getGardenSnapshot().fruits, 0);
  await assert.rejects(a.core.startReview('fp-3'), { code: 'NOTHING_TO_REVIEW' });
});

test('古い教材版・存在しない問題・古い画面の操作を拒否し、状態を壊さない', async () => {
  const content = new StubContent(stubTheme({ version: 'v1' }));
  const a = await openCore({ content });
  let v = await toFirstQuestion(a.core, await a.core.startStage(IT, THEME));
  const before = JSON.stringify(a.core.getState());
  await assert.rejects(a.core.select(v.stageId, 'no-such-question', 'a'), { code: 'QUESTION_NOT_FOUND' });
  await assert.rejects(a.core.select(v.stageId, v.question!.id, 'z'), { code: 'QUESTION_NOT_FOUND' });
  await assert.rejects(a.core.confirm('no-stage', 'c1'), { code: 'STAGE_NOT_FOUND' });
  await assert.rejects(a.core.advance(v.stageId, v.step), { code: 'NOT_ALLOWED' }, '回答前に次へは進めない');
  assert.equal(JSON.stringify(a.core.getState()), before);
  const stale = (await answerAndNext(a.core, v)).view;
  await assert.rejects(a.core.advance(v.stageId, v.step), { code: 'STALE_STEP' }, '古いstepの重複操作');
  assert.equal(stale.progress.index, 2);

  // 教材版が上がったあとの再開は拒否（黙って新教材へ差し替えない）
  await a.core.interrupt(v.stageId);
  content.theme = stubTheme({ version: 'v2' });
  const snapshot = JSON.stringify(a.core.getState());
  await assert.rejects(a.core.resume(v.stageId), { code: 'STALE_CONTENT' });
  await assert.rejects(a.core.startStage(IT, THEME), { code: 'STALE_CONTENT' });
  assert.equal(JSON.stringify(a.core.getState()), snapshot);
  assert.equal(a.core.getGardenSnapshot().fruits, 7);
});

test('別のステージが進行中のとき別ステージを開始しない（実も消費しない）', async () => {
  const a = await openCore();
  await a.core.startStage(IT, THEME);
  await assert.rejects(a.core.startStage('fp-3', 'x'), { code: 'ACTIVE_STAGE_EXISTS' });
  assert.equal(a.core.getGardenSnapshot().fruits, 7);
});

test('終了したステージは再開できず、同テーマの新規開始は新たに実を使う', async () => {
  const a = await openCore();
  const v = await a.core.startStage(IT, THEME);
  await a.core.endStage(v.stageId);
  await assert.rejects(a.core.resume(v.stageId), { code: 'NOT_ALLOWED' });
  const v2 = await a.core.startStage(IT, THEME);
  assert.notEqual(v2.stageId, v.stageId);
  assert.equal(a.core.getGardenSnapshot().fruits, 6);
});

test('壊れた保存ファイル: 開くのを拒否し、中身を初期化も上書きもしない', async () => {
  const path = await tempJsonPath();
  await writeFile(path, '{"schemaVersion":1,"wallet":', 'utf8'); // 書込み途中で切れた想定
  await assert.rejects(StudyCore.open({ storage: new JsonFileStorage(path), clock: new FakeClock(), content: new StubContent() }), { code: 'CORRUPT_STORAGE' });
  assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":1,"wallet":');
  await writeFile(path, JSON.stringify({ schemaVersion: 99 }), 'utf8');
  await assert.rejects(StudyCore.open({ storage: new JsonFileStorage(path), clock: new FakeClock(), content: new StubContent() }), { code: 'CORRUPT_STORAGE' });
  assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":99}');
});

test('保存ファイルは保存のたびに完全なJSONで、一時ファイルを残さない', async () => {
  const path = await tempJsonPath();
  const a = await openCore({ storage: new JsonFileStorage(path) });
  await a.core.startStage(IT, THEME);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(parsed.wallet.fruits, 7);
  await assert.rejects(readFile(`${path}.tmp`), { code: 'ENOENT' });
});

test('長い解説・わからない・無回答（未選択）をデータとして扱える', async () => {
  const long = '長い解説。'.repeat(3000);
  const path = await tempJsonPath();
  const content = new StubContent(stubTheme({ longExplanation: long }));
  const a = await openCore({ content, storage: new JsonFileStorage(path) });
  let v = await toFirstQuestion(a.core, await a.core.startStage(IT, THEME));
  const dk = await a.core.dontKnow(v.stageId, v.question!.id);
  assert.equal(dk.feedback?.outcome, 'unknown');
  assert.equal(dk.feedback?.explanation.length, long.length);
  assert.equal(a.core.getState().mastery['it-passport/bit-patterns']!.unknown, 1);
  assert.equal(a.core.getGardenSnapshot().fruits, 7);
  const b = await openCore({ content, storage: new JsonFileStorage(path) });
  assert.equal(b.core.getStageView(v.stageId).feedback?.explanation.length, long.length, '再読込み後も長い解説が保たれる');
  // 未選択のまま確定は不可（無回答は「わからない」で表す）
  v = (await b.core.advance(v.stageId, dk.step)).view;
  await assert.rejects(b.core.confirm(v.stageId, v.question!.id), { code: 'NOT_ALLOWED' });
});
