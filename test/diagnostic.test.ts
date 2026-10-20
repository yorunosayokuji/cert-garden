import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CompositeContent, CoreError, DiagnosticEngine, MemoryDiagStorage, PackContent, QUALIFICATIONS, StudyCore, MemoryStorage, DEMO_CONFIG, codes,
  listPackThemes, type ContentProvider, type DiagView, type LearningPack, type ThemeContent,
} from '../src/index.ts';
import { FakeClock, seqIds } from './helpers.ts';

const pack = JSON.parse(readFileSync(new URL('../design-assets/app-completion-20261020/learning-pack.json', import.meta.url), 'utf8')) as LearningPack;
const content = () => new CompositeContent(new PackContent(pack));
const themeIds = (q: string) => listPackThemes(pack).filter((t) => t.qualificationId === q).map((t) => t.themeId);
const open = async (storage = new MemoryDiagStorage(), c: ContentProvider = content()) => {
  const e = new DiagnosticEngine({ storage, content: c, clock: new FakeClock(), newId: seqIds('run') });
  await e.load();
  return { e, storage };
};
type Q = Extract<DiagView, { kind: 'question' }>;
const asQ = (v: DiagView) => {
  assert.equal(v.kind, 'question');
  return v as Q;
};

/** 現在の問題の正解IDを教材から得る（テスト専用） */
async function correctOf(v: Q): Promise<string> {
  const th = pack.themes.find((t) => t.qualificationId === v.qualificationId && t.title === v.themeTitle)!;
  return th.coreQuestions.find((q) => q.prompt === v.prompt)!.options.find((o) => o.isCorrect)!.id;
}
async function wrongOf(v: Q): Promise<string> {
  const th = pack.themes.find((t) => t.qualificationId === v.qualificationId && t.title === v.themeTitle)!;
  return th.coreQuestions.find((q) => q.prompt === v.prompt)!.options.find((o) => !o.isCorrect)!.id;
}

/** 1問答えて次へ。pick: correct / wrong / unknown */
async function step1(e: DiagnosticEngine, v: Q, pick: 'correct' | 'wrong' | 'unknown'): Promise<DiagView> {
  let cur: DiagView;
  if (pick === 'unknown') cur = await e.dontKnow(v.qualificationId, v.step);
  else {
    const s = await e.select(v.qualificationId, v.step, pick === 'correct' ? await correctOf(v) : await wrongOf(v));
    cur = await e.confirm(v.qualificationId, asQ(s).step);
  }
  return e.next(v.qualificationId, asQ(cur).step);
}

test('各資格: 基礎2テーマから3問ずつ6問。テーマが交互で、同じテーマの概念を散らし、回答前に正解・解説を漏らさない', async () => {
  for (const q of QUALIFICATIONS) {
    const { e } = await open();
    const ids = themeIds(q.id);
    assert.equal(ids.length, 2, q.id);
    const v = asQ(await e.start(q.id, ids));
    assert.equal(v.total, 6);
    const run = e.getQual(q.id).active!;
    assert.equal(run.items.length, 6);
    for (const id of ids) {
      const its = run.items.filter((i) => i.themeId === id);
      assert.equal(its.length, 3, `${q.id}/${id}`);
      const concepts = new Set(its.map((i) => i.concept));
      const all = new Set(pack.themes.find((t) => t.themeId === id)!.coreQuestions.map((x) => x.concept));
      assert.equal(concepts.size, Math.min(3, all.size), `${q.id}/${id} の概念が散っている`);
    }
    assert.deepEqual(run.items.map((i) => i.themeId), [ids[0], ids[1], ids[0], ids[1], ids[0], ids[1]]);
    const json = JSON.stringify(v);
    assert.ok(!/isCorrect|whyWrong|explanation|sources|hint/.test(json) && v.feedback === undefined, q.id);
    assert.ok(!json.includes('bit-patterns'));
  }
});

test('選択→確認が分かれ、確認後だけ正誤と解説が出る。二重押下・古い画面・未選択の確認は成績を増やさない', async () => {
  const { e } = await open();
  const v0 = asQ(await e.start('qc-3', themeIds('qc-3')));
  await assert.rejects(e.confirm('qc-3', v0.step), (x: unknown) => x instanceof CoreError && x.code === codes.notAllowed, '未選択で確認できない');
  await assert.rejects(e.next('qc-3', v0.step), (x: unknown) => x instanceof CoreError && x.code === codes.notAllowed, '回答前に次へ進めない');
  const sel = asQ(await e.select('qc-3', v0.step, await correctOf(v0)));
  assert.equal(sel.feedback, undefined);
  assert.equal(e.getQual('qc-3').active!.answers.length, 0, '選択だけでは回答にならない');
  const done = asQ(await e.confirm('qc-3', sel.step));
  assert.equal(done.feedback?.correct, true);
  assert.ok(done.feedback!.explanation.length > 0);
  // 同じ画面(step)からの二重確認・二重の次へ
  await assert.rejects(e.confirm('qc-3', sel.step), (x: unknown) => x instanceof CoreError && x.code === codes.staleStep);
  await assert.rejects(e.select('qc-3', sel.step, 'o1'), (x: unknown) => x instanceof CoreError && x.code === codes.staleStep);
  const n = asQ(await e.next('qc-3', done.step));
  await assert.rejects(e.next('qc-3', done.step), (x: unknown) => x instanceof CoreError && x.code === codes.staleStep);
  assert.equal(e.getQual('qc-3').active!.answers.length, 1);
  assert.equal(n.index, 2);
});

test('最後まで答えると結果が保存され、進行中は消える。テーマ別の正誤/要確認とおすすめテーマ。断定の語を持たない', async () => {
  const { e, storage } = await open();
  const ids = themeIds('fp-3');
  let v: DiagView = await e.start('fp-3', ids);
  // 1つ目のテーマは全問不正解、2つ目は全問正解
  const run = e.getQual('fp-3').active!;
  for (let i = 0; i < 6; i++) {
    const q = asQ(v);
    v = await step1(e, q, run.items[i]!.themeId === ids[0] ? 'wrong' : 'correct');
  }
  assert.equal(v.kind, 'result');
  const r = (v as Extract<DiagView, { kind: 'result' }>).result;
  assert.equal(e.getQual('fp-3').active, undefined);
  assert.deepEqual(e.getQual('fp-3').latest, r);
  const t0 = r.themes.find((t) => t.themeId === ids[0])!;
  const t1 = r.themes.find((t) => t.themeId === ids[1])!;
  assert.deepEqual([t0.correct, t0.wrong, t0.total, t0.level], [0, 3, 3, 'check']);
  assert.deepEqual([t1.correct, t1.wrong, t1.total, t1.level], [3, 0, 3, 'solid']);
  assert.equal(r.recommendedThemeId, ids[0]);
  assert.ok(t0.concepts.length === 3 && t0.concepts.every((c) => !c.correct));
  assert.ok(!/習得|合格|レベル|網羅/.test(JSON.stringify(r)));
  assert.ok(storage.state!.quals['fp-3']!.latest);
  assert.equal((await e.view('fp-3')).kind, 'result');
});

test('わからない=要確認としてwrongと別に数え、全部わからないでも完了できる。同点は先のテーマをすすめる', async () => {
  const { e } = await open();
  let v: DiagView = await e.start('eco', themeIds('eco'));
  for (let i = 0; i < 6; i++) v = await step1(e, asQ(v), 'unknown');
  const r = (v as Extract<DiagView, { kind: 'result' }>).result;
  assert.ok(r.themes.every((t) => t.unknown === 3 && t.wrong === 0 && t.correct === 0 && t.level === 'check'));
  assert.equal(r.recommendedThemeId, themeIds('eco')[0]);
});

test('途中で閉じて再読込（別のエンジン）しても同じ問題・同じ選択肢順・同じ状態から続き、成績は重複しない。資格ごとに別保存', async () => {
  const storage = new MemoryDiagStorage();
  const a = await open(storage);
  let v = asQ(await a.e.start('toukei-3', themeIds('toukei-3')));
  v = asQ(await step1(a.e, v, 'correct'));
  const sel = asQ(await a.e.select('toukei-3', v.step, await wrongOf(v)));
  await a.e.start('color-3', themeIds('color-3')); // 別の資格の進行中
  const b = await open(storage);
  const again = asQ(await b.e.view('toukei-3'));
  assert.deepEqual(again, sel);
  assert.equal(again.index, 2);
  assert.equal(again.selectedOptionId, sel.selectedOptionId);
  // 再開時の start は同じ進行中を返し、新しく作らない
  assert.deepEqual(asQ(await b.e.start('toukei-3', themeIds('toukei-3'))), sel);
  assert.equal(b.e.getQual('toukei-3').active!.answers.length, 1);
  assert.equal(asQ(await b.e.view('color-3')).index, 1, '別の資格の進捗は独立');
  const conf = await b.e.confirm('toukei-3', again.step);
  assert.equal(asQ(conf).feedback?.correct, false);
  await assert.rejects(a.e.confirm('toukei-3', again.step), CoreError, '古いエンジンの画面からの二重確認は弾く');
});

test('保存失敗は状態を変えず、再試行で1回だけ記録される', async () => {
  const { e, storage } = await open();
  const v = asQ(await e.start('sekaken-3', themeIds('sekaken-3')));
  storage.failNextSaves = 1;
  await assert.rejects(e.select('sekaken-3', v.step, await correctOf(v)), (x: unknown) => x instanceof CoreError && x.code === codes.storageWrite);
  assert.equal(e.getQual('sekaken-3').active!.selectedOptionId, null);
  assert.equal(e.getQual('sekaken-3').active!.step, v.step);
  const ok = asQ(await e.select('sekaken-3', v.step, await correctOf(v)));
  const c = asQ(await e.confirm('sekaken-3', ok.step));
  assert.equal(e.getQual('sekaken-3').active!.answers.length, 1);
  assert.equal(c.qState, 'feedback');
});

test('壊れた保存は上書きせず、操作は拒否される（表示は空で、学習は別に使える）', async () => {
  for (const bad of [{ version: 2, quals: {} }, { version: 1, quals: { eco: { active: { runId: 1 } } } }, { version: 1 }] as unknown[]) {
    const storage = new MemoryDiagStorage();
    storage.state = bad as never;
    const before = JSON.stringify(storage.state);
    const { e } = await open(storage);
    assert.equal(e.isCorrupt(), true);
    await assert.rejects(e.start('eco', themeIds('eco')), (x: unknown) => x instanceof CoreError && x.code === codes.corruptStorage);
    await assert.rejects(e.dismiss('eco'), CoreError);
    assert.equal(JSON.stringify(storage.state), before);
    assert.equal((await e.view('eco')).kind, 'none');
  }
  // 回答数と位置が食い違う進行中も壊れとして扱う
  const s = new MemoryDiagStorage();
  const { e } = await open(s);
  await e.start('eco', themeIds('eco'));
  s.state!.quals['eco']!.active!.index = 3;
  const { e: e2 } = await open(s);
  assert.equal(e2.isCorrupt(), true);
});

test('再チェックと入口: 結果から新しく受け直せる／途中でやめても最新の結果は残る／「あとで」は保存され学習を止めない', async () => {
  const { e } = await open();
  let v: DiagView = await e.start('qc-3', themeIds('qc-3'));
  for (let i = 0; i < 6; i++) v = await step1(e, asQ(v), 'correct');
  const first = e.getQual('qc-3').latest!;
  const re = asQ(await e.start('qc-3', themeIds('qc-3')));
  assert.equal(re.index, 1);
  assert.notEqual(e.getQual('qc-3').active!.runId, first.runId);
  assert.deepEqual(e.getQual('qc-3').latest, first, '受け直している間も前の結果は残る');
  await e.abandon('qc-3');
  assert.equal(e.getQual('qc-3').active, undefined);
  assert.deepEqual(e.getQual('qc-3').latest, first);
  await e.dismiss('business-accounting-3');
  assert.equal(e.getQual('business-accounting-3').dismissed, true);
  assert.equal((await e.view('business-accounting-3')).kind, 'none');
  assert.equal(asQ(await e.start('business-accounting-3', themeIds('business-accounting-3'))).index, 1, 'スキップしても受けられる');
});

test('教材版が変わった進行中のチェックは続けず、最初からやり直せる（原本の結果は消さない）', async () => {
  const storage = new MemoryDiagStorage();
  const a = await open(storage);
  await a.e.start('info-sec-mgmt', themeIds('info-sec-mgmt'));
  const bump: ContentProvider = {
    async loadTheme(q, t): Promise<ThemeContent> {
      const c = await content().loadTheme(q, t);
      return { ...c, version: `${c.version}.next` };
    },
  };
  const b = await open(storage, bump);
  const view = await b.e.view('info-sec-mgmt');
  assert.equal(view.kind, 'stale');
  const fresh = asQ(await b.e.start('info-sec-mgmt', themeIds('info-sec-mgmt')));
  assert.equal(fresh.index, 1);
});

test('学習コアとは独立: 実・ポイント・完了テーマを動かさず、既存のビット列教材も学習できる', async () => {
  const kv = new MemoryStorage();
  const core = await StudyCore.open({ storage: kv, content: content(), clock: new FakeClock(), config: DEMO_CONFIG, newId: seqIds('s') });
  const before = JSON.stringify(core.getGardenSnapshot());
  const { e } = await open();
  let v: DiagView = await e.start('it-passport', themeIds('it-passport'));
  assert.ok(!themeIds('it-passport').includes('bit-patterns'), '診断の対象は用意した基礎2テーマ');
  for (let i = 0; i < 6; i++) v = await step1(e, asQ(v), 'correct');
  assert.equal(JSON.stringify(core.getGardenSnapshot()), before);
  const s = await core.startStage('it-passport', 'bit-patterns');
  assert.equal(s.progress.total, 8);
});
