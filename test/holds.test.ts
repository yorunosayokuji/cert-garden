import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CompositeContent, CoreError, DiagnosticEngine, describeSource, safeHttpsUrl, HoldFilteredContent, MemoryDiagStorage, MemoryHoldStorage, PackContent, QuestionHolds,
  codes, listPackThemes, type LearningPack, type QuestionRef, type StageView,
} from '../src/index.ts';
import { FakeClock, openCore, seqIds, toFirstQuestion } from './helpers.ts';

const pack = JSON.parse(readFileSync(new URL('../design-assets/app-completion-20261020/learning-pack.json', import.meta.url), 'utf8')) as LearningPack;
const inner = () => new CompositeContent(new PackContent(pack));
const themeOf = (q: string, i = 0) => listPackThemes(pack).filter((t) => t.qualificationId === q)[i]!;
const qsOf = (themeId: string) => pack.themes.find((t) => t.themeId === themeId)!.coreQuestions;
const versionOf = (themeId: string) => pack.themes.find((t) => t.themeId === themeId)!.version;
const isErr = (code: string) => (e: unknown) => e instanceof CoreError && e.code === code;

function setup(clock = new FakeClock(), storage = new MemoryHoldStorage()) {
  const holds = new QuestionHolds({ storage, clock, newId: seqIds('rep') });
  return { holds, storage, clock, content: new HoldFilteredContent(inner(), holds) };
}
const refOf = (qualificationId: string, themeId: string, i: number, version?: string): QuestionRef => {
  const q = qsOf(themeId)[i]!;
  return { questionId: q.id, qualificationId, themeId, contentVersion: version ?? versionOf(themeId), prompt: q.prompt };
};

test('保留の記録: 二重に押しても1件、元ID(#recheck除去)と版・資格・テーマ・時刻を保存し、再読込で復帰、解除できる', async () => {
  const { holds, storage } = setup();
  await holds.load();
  const t = themeOf('qc-3');
  const ref = refOf('qc-3', t.themeId, 0);
  const [a, b] = await Promise.all([holds.hold(ref), holds.hold({ ...ref, questionId: `${ref.questionId}#recheck` })]);
  assert.equal(a.at, b.at);
  assert.equal(holds.list().length, 1);
  const h = holds.list()[0]!;
  assert.deepEqual([h.questionId, h.qualificationId, h.themeId, h.contentVersion], [ref.questionId, 'qc-3', t.themeId, ref.contentVersion]);
  assert.ok(h.at > 0 && h.prompt.length > 0 && h.prompt.length <= 60);
  assert.equal(holds.isHeld(`${ref.questionId}#recheck`), true);
  const again = new QuestionHolds({ storage, clock: new FakeClock() });
  await again.load();
  assert.deepEqual(again.list(), holds.list());
  await again.release(ref.questionId);
  await again.release(ref.questionId); // 二重解除でも失敗しない
  assert.equal(again.list().length, 0);
  await holds.hold(ref); // 古い画面から再保留しても、最新の保存を読み直して書く
  assert.equal(holds.list().length, 1);
});

test('報告: 理由と任意メモをローカル保存。同じ内容は二重に残さず、同じ保存で保留もできる。保存内容に送信先はない', async () => {
  const { holds, storage } = setup();
  await holds.load();
  const ref = refOf('eco', themeOf('eco').themeId, 1);
  const r1 = await holds.report(ref, 'answer', '  正解が違うかも  ', false);
  const r2 = await holds.report(ref, 'answer', '正解が違うかも', false);
  assert.equal(r1.id, r2.id);
  assert.equal(holds.reports().length, 1);
  assert.equal(r1.memo, '正解が違うかも');
  assert.equal(holds.list().length, 0, '報告だけでは保留しない');
  const r3 = await holds.report(ref, 'wording', 'x'.repeat(500), true);
  assert.equal(r3.memo.length, 200);
  assert.equal(r3.held, true);
  assert.equal(holds.list().length, 1);
  await assert.rejects(holds.report(ref, 'bogus' as never, '', false), isErr(codes.notAllowed));
  assert.equal(holds.reports().length, 2);
  assert.deepEqual(Object.keys(storage.state!).sort(), ['holds', 'reports', 'version']);
});

test('保存失敗は記録も保留も変えず、壊れた保存は上書きせず操作を拒否する', async () => {
  const { holds, storage } = setup();
  await holds.load();
  const ref = refOf('qc-3', themeOf('qc-3').themeId, 0);
  storage.failNextSaves = 1;
  await assert.rejects(holds.hold(ref), isErr(codes.storageWrite));
  assert.equal(holds.list().length, 0);
  assert.equal(storage.state, null);
  await holds.hold(ref);
  assert.equal(holds.list().length, 1);

  for (const bad of [{ version: 2 }, { version: 1, holds: { x: { questionId: 'y' } }, reports: [] }, { version: 1, holds: {}, reports: [{ id: 1 }] }, 'oops'] as unknown[]) {
    const s = new MemoryHoldStorage();
    s.state = bad as never;
    const before = JSON.stringify(s.state);
    const h = new QuestionHolds({ storage: s, clock: new FakeClock() });
    assert.equal((await h.load()).corrupt, true);
    await assert.rejects(h.hold(ref), isErr(codes.corruptStorage));
    await assert.rejects(h.release('x'), isErr(codes.corruptStorage));
    assert.equal(JSON.stringify(s.state), before);
    assert.equal(h.list().length, 0);
  }
});

test('保留した問題は次のステージから外れ、進行中は変わらない。再確認も保留を避け、解除で戻る', async () => {
  const { holds, content } = setup();
  await holds.load();
  const t = themeOf('it-passport', 1);
  const qs = qsOf(t.themeId);
  const rig = await openCore({ content, config: { initialFruits: 10 } });
  const running = await toFirstQuestion(rig.core, await rig.core.startStage('it-passport', t.themeId));
  const runningIds = rig.core.getState().stages[running.stageId]!.questions.map((q) => q.id);
  assert.equal(runningIds.length, 6);
  await holds.hold(refOf('it-passport', t.themeId, 0));
  assert.deepEqual(rig.core.getState().stages[running.stageId]!.questions.map((q) => q.id), runningIds, '進行中のステージは直ちにはすり替えない');
  await rig.core.interrupt(running.stageId);
  const resumed = await rig.core.resume(running.stageId);
  assert.equal(resumed.progress.total, 8);
  await rig.core.endStage(running.stageId);
  const next = await rig.core.startStage('it-passport', t.themeId);
  const ids = rig.core.getState().stages[next.stageId]!.questions.map((q) => q.id);
  assert.equal(ids.length, 5);
  assert.ok(!ids.includes(qs[0]!.id));
  const c = await content.loadTheme('it-passport', t.themeId);
  for (let i = 0; i < 20; i++) {
    const r = c.buildRecheck({ seed: `s${i}`, weak: [{ questionId: qs[0]!.id, misconception: 'x', correctPosition: 0 }], coreQuestions: qs as never });
    assert.ok(r.every((q) => q.derivedFromQuestionId !== qs[0]!.id), '保留した問題は再確認に出ない');
  }
  await holds.release(qs[0]!.id);
  assert.equal((await content.loadTheme('it-passport', t.themeId)).coreQuestions.length, 6);
});

test('出せる問題が足りないテーマは、実を使う前に理由つきで開始を拒否（診断も）。解除で始められる', async () => {
  const { holds, content } = setup();
  await holds.load();
  const t = themeOf('fp-3');
  const rig = await openCore({ content, config: { initialFruits: 10 } });
  const fruits = rig.core.getGardenSnapshot().fruits;
  for (let i = 0; i < 4; i++) await holds.hold(refOf('fp-3', t.themeId, i));
  await assert.rejects(rig.core.startStage('fp-3', t.themeId), (e: unknown) => e instanceof CoreError && e.code === codes.themeOnHold && /保留/.test(e.message));
  assert.equal(rig.core.getGardenSnapshot().fruits, fruits, '拒否では実を使わない');
  const d = new DiagnosticEngine({ storage: new MemoryDiagStorage(), content, rawContent: inner(), clock: new FakeClock(), newId: seqIds('d') });
  await d.load();
  await assert.rejects(d.start('fp-3', listPackThemes(pack).filter((x) => x.qualificationId === 'fp-3').map((x) => x.themeId)), isErr(codes.themeOnHold));
  await holds.release(qsOf(t.themeId)[0]!.id);
  const ok = await rig.core.startStage('fp-3', t.themeId);
  assert.equal(rig.core.getState().stages[ok.stageId]!.questions.length, 3);
  assert.equal(rig.core.getGardenSnapshot().fruits, fruits - 1);
});

test('進行中のステージは、保留で足りなくなっても再開できる（新しく始める時だけ拒否）', async () => {
  const { holds, content } = setup();
  await holds.load();
  const t = themeOf('sekaken-3');
  const rig = await openCore({ content, config: { initialFruits: 10 } });
  const running = await rig.core.startStage('sekaken-3', t.themeId);
  await rig.core.interrupt(running.stageId);
  for (let i = 0; i < 5; i++) await holds.hold(refOf('sekaken-3', t.themeId, i));
  const back = await rig.core.resume(running.stageId);
  assert.equal(back.stageId, running.stageId);
  assert.equal(rig.core.getState().stages[running.stageId]!.questions.length, 6);
});

test('進行中の初回チェックは保留しても続けられ、次回の作成から外れる。教材版が違う保留は効かない', async () => {
  const { holds, content } = setup();
  await holds.load();
  const d = new DiagnosticEngine({ storage: new MemoryDiagStorage(), content, rawContent: inner(), clock: new FakeClock(), newId: seqIds('d') });
  await d.load();
  const ids = listPackThemes(pack).filter((x) => x.qualificationId === 'eco').map((x) => x.themeId);
  assert.equal((await d.start('eco', ids)).kind, 'question');
  const firstId = d.getQual('eco').active!.items[0]!.questionId;
  const theme = ids.find((id) => qsOf(id).some((q) => q.id === firstId))!;
  const idx = qsOf(theme).findIndex((q) => q.id === firstId);
  await holds.hold(refOf('eco', theme, idx));
  assert.equal((await d.view('eco')).kind, 'question', '進行中は壊れない');
  await d.abandon('eco');
  assert.equal((await d.start('eco', ids)).kind, 'question');
  assert.ok(!d.getQual('eco').active!.items.some((i) => i.questionId === firstId));
  const other = (idx + 1) % 6;
  const stale = await holds.hold(refOf('eco', theme, other, 'old.version'));
  assert.equal(holds.active('eco', theme, stale.contentVersion).size, 1);
  assert.equal(holds.active('eco', theme, versionOf(theme)).has(qsOf(theme)[other]!.id), false);
});

// ---- 解説の参考（確定後のみ）と、初回チェックからの記録 ----
test('解説の参考: 確定前のビューには載せず、確定後だけ日本語で出す。資料の範囲と正解の根拠を分け、内部の状態文字列/英語コードを出さない', async () => {
  const rig = await openCore({ content: inner(), config: { initialFruits: 30, maxFruits: 30 } });
  for (const t of pack.themes) {
    const v = await toFirstQuestion(rig.core, await rig.core.startStage(t.qualificationId, t.themeId));
    assert.equal(v.feedback, undefined);
    assert.ok(!JSON.stringify(v).match(/references|sources|syllabus|search_result_only|checked/), `${t.themeId}: 確定前に参考を漏らさない`);
    const q = t.coreQuestions.find((x) => x.prompt === v.question!.prompt)!;
    await rig.core.select(v.stageId, v.question!.id, q.options.find((o) => o.isCorrect)!.id);
    const after = await rig.core.confirm(v.stageId, v.question!.id);
    const refs = after.feedback!.references!;
    assert.equal(refs.contentVersion, t.version);
    assert.equal(refs.sources.length, q.sources.length);
    assert.ok(refs.sources.every((s) => s.title && s.roleLabel && s.scopeNote && s.checked));
    assert.ok(refs.sources.every((s) => !s.url || s.url.startsWith('https://')));
    assert.ok(/専門家の監修ではありません/.test(refs.checkNote));
    // 出典URL自体（例: .../syllabus_ip_ver6_5.pdf）は利用者が開くリンクなので、表示文字列の検査からは除く
    const shown = JSON.stringify({ ...refs, sources: refs.sources.map((s) => ({ ...s, url: null })) });
    assert.ok(!/search_result_only|direct page|not independent|syllabus|qualification_scope|concept_reference|explicit_arithmetic|definition_or_scenario/.test(shown), `${t.themeId}: 内部の文字列を出さない`);
    assert.ok(refs.sources.every((s) => !/正解を検証済/.test(s.scopeNote)), '範囲の確認元を正解検証済みと表示しない');
    await rig.core.endStage(v.stageId);
  }
});

test('出典の言い換え: 直接開けなかった確認は「部分的に確認」、title無しはホスト名、http/不正URLは押せない', () => {
  const a = describeSource({ url: 'https://www3.jitec.ipa.go.jp/JitesCbt/html/about/range.html', role: 'syllabus', checked: '2026-10-20', status: 'search_result_only; direct page returned invalid request; version not confirmed' });
  assert.equal(a.title, 'jitec.ipa.go.jp');
  assert.match(a.scopeNote, /正解を確かめたものではありません/);
  assert.match(a.scopeNote, /部分的に確認/);
  assert.match(a.scopeNote, /版や最新/);
  assert.equal(a.roleLabel, '出題範囲の確認元');
  const b = describeSource({ url: 'http://example.com/x', role: 'concept_reference', checked: '2026-10-20', title: '資料A', section: 'Articles 1-2' });
  assert.equal(b.url, null);
  assert.equal(b.title, '資料A');
  assert.equal(b.section, 'Articles 1-2');
  assert.equal(describeSource({ url: 'https://example.com', checked: 'x', section: '4級の手引き Ver.3.2 p35 *11 PDCA; concept reference, not 3級 syllabus proof' }).section, '4級の手引き Ver.3.2 p35 *11 PDCA');
  assert.match(b.scopeNote, /専門家が確認したものではありません/);
  assert.equal(describeSource({ url: 'javascript:alert(1)', checked: 'x' }).url, null);
  assert.equal(describeSource({ url: 'not a url', checked: 'x' }).title, '参考資料');
  assert.equal(safeHttpsUrl('https://example.com/a')?.startsWith('https://'), true);
});

test('初回チェック: 確定後だけ参考が付き、問題の記録用の識別(元ID/版/資格/テーマ/問題文)が正しい。保留は進行中を壊さず次回から効く。実は動かない', async () => {
  const h = setup();
  await h.holds.load();
  const d = new DiagnosticEngine({ storage: new MemoryDiagStorage(), content: h.content, rawContent: inner(), clock: new FakeClock(), newId: seqIds('d') });
  await d.load();
  const ids = listPackThemes(pack).filter((x) => x.qualificationId === 'qc-3').map((x) => x.themeId);
  const rig = await openCore({ content: h.content, config: { initialFruits: 10 } });
  const fruits = rig.core.getGardenSnapshot().fruits;
  let v = await d.start('qc-3', ids);
  assert.equal(v.kind, 'question');
  const q1 = v as Extract<typeof v, { kind: 'question' }>;
  assert.equal(q1.feedback, undefined);
  assert.ok(!JSON.stringify(q1).match(/references|syllabus|isCorrect/));
  const th = pack.themes.find((t) => t.themeId === q1.questionRef.themeId)!;
  const src = th.coreQuestions.find((x) => x.prompt === q1.prompt)!;
  assert.deepEqual(q1.questionRef, { questionId: src.id, qualificationId: 'qc-3', themeId: th.themeId, contentVersion: th.version, prompt: src.prompt.slice(0, 60) === src.prompt ? src.prompt : q1.questionRef.prompt });
  const sel = await d.select('qc-3', q1.step, q1.options[0]!.id);
  const done = await d.confirm('qc-3', (sel as typeof q1).step) as typeof q1;
  assert.ok(done.feedback!.references!.sources.length > 0);
  // 記録と保留（二重でも1件）。進行中のチェックは続けられる
  const ref = done.questionRef;
  await Promise.all([h.holds.report(ref, 'wording', 'メモ', true), h.holds.report(ref, 'wording', 'メモ', true)]);
  assert.equal(h.holds.list().length, 1);
  assert.equal(h.holds.reports().length, 1);
  assert.equal(h.holds.list()[0]!.questionId, src.id);
  assert.equal((await d.view('qc-3')).kind, 'question');
  const next = await d.next('qc-3', done.step);
  assert.equal(next.kind, 'question');
  // 次の作成からは外れ、解除で戻る。実は動かない
  await d.abandon('qc-3');
  await d.start('qc-3', ids);
  assert.ok(!d.getQual('qc-3').active!.items.some((i) => i.questionId === src.id));
  await h.holds.release(src.id);
  assert.equal(rig.core.getGardenSnapshot().fruits, fruits);
  // 保存失敗は何も記録しない
  h.storage.failNextSaves = 1;
  await assert.rejects(h.holds.hold(ref), isErr(codes.storageWrite));
  assert.equal(h.holds.list().length, 0);
  void v;
});

// ---- おさらいの優先付けと同日/後日の区別 ----
async function answer(core: Awaited<ReturnType<typeof openCore>>['core'], v: StageView, how: 'correct' | 'wrong') {
  const q = pack.themes.flatMap((t) => t.coreQuestions).find((x) => x.prompt === v.question!.prompt)!;
  const opt = how === 'correct' ? q.options.find((o) => o.isCorrect)! : q.options.find((o) => !o.isCorrect)!;
  await core.select(v.stageId, v.question!.id, opt.id);
  const c = await core.confirm(v.stageId, v.question!.id);
  return core.advance(c.stageId, c.step);
}

test('おさらい: 間違えた概念を優先し、同じ概念の別問を先に。同日の再確認と後日の思い出しを区別する', async () => {
  const clock = new FakeClock();
  const rig = await openCore({ content: inner(), clock, config: { initialFruits: 10 } });
  const { core } = rig;
  const t = themeOf('it-passport');
  const qs = qsOf(t.themeId);
  let v = await toFirstQuestion(core, await core.startStage('it-passport', t.themeId));
  let sawSame = false;
  for (let i = 0; i < 12; i++) {
    if (v.phase === 'recheck') sawSame = sawSame || core.getStageView(v.stageId).recall === 'same_day';
    const r = await answer(core, v, v.question!.id === qs[0]!.id ? 'wrong' : 'correct');
    if (r.completion) break;
    v = r.view;
  }
  assert.ok(sawSame, '学習直後の再確認は同日の確認');
  const key = `it-passport/${t.themeId}`;
  assert.equal(core.getGardenSnapshot().masteryLevels[key], 'same_day_only', '同日の確認だけでは定着と呼ばない');
  clock.advanceDays(1);
  const rv = await core.startReview('it-passport');
  assert.equal(rv.recall, 'later');
  const stage = core.getState().stages[rv.stageId]!;
  assert.equal(stage.questions.length, 2);
  assert.equal(stage.questions[0]!.concept, qs[0]!.concept, '間違えた概念を先に');
  assert.notEqual(stage.questions[0]!.derivedFromQuestionId, qs[0]!.id, '同じ概念の別問を先に出す');
  assert.ok(stage.questions.every((q) => q.derivedFromQuestionId));
  let cur = rv;
  for (let i = 0; i < 2; i++) {
    const r = await answer(core, cur, 'correct');
    if (r.completion) break;
    cur = r.view;
  }
  assert.equal(core.getGardenSnapshot().masteryLevels[key], 'recalled_later');
});

test('おさらいのテーマ選び: 期日が同じなら弱点が残るテーマを先に。保留・報告の操作で実もポイントも動かない', async () => {
  const clock = new FakeClock();
  const h = setup(clock);
  await h.holds.load();
  const rig = await openCore({ content: h.content, clock, config: { initialFruits: 10 } });
  const { core } = rig;
  const [t0, t1] = [themeOf('qc-3', 0), themeOf('qc-3', 1)];
  for (const [t, how] of [[t0, 'correct'], [t1, 'wrong']] as const) {
    let v = await toFirstQuestion(core, await core.startStage('qc-3', t.themeId));
    for (let i = 0; i < 12; i++) {
      const r = await answer(core, v, v.phase === 'core' ? how : 'correct');
      if (r.completion) break;
      v = r.view;
    }
  }
  const before = core.getGardenSnapshot();
  await h.holds.hold(refOf('qc-3', t0.themeId, 0));
  await h.holds.report(refOf('qc-3', t0.themeId, 1), 'other', '', false);
  assert.equal(core.getGardenSnapshot().fruits, before.fruits);
  assert.equal(core.getGardenSnapshot().points, before.points);
  await h.holds.release(qsOf(t0.themeId)[0]!.id);
  clock.advanceDays(1);
  const rv = await core.startReview('qc-3');
  assert.equal(core.getState().stages[rv.stageId]!.themeId, t1.themeId, '弱点の残るテーマを先に');
  assert.equal(rv.recall, 'later');
});
