import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreError, MemoryStorage, StudyCore, DEMO_CONFIG, BitPatternsContent, codes, nextDayStart, treeStage, parseState, type CoreState } from '../src/index.ts';
import { FakeClock, FlakyStorage, answerAndNext, openCore, seqIds, toFirstQuestion } from './helpers.ts';

const IT = 'it-passport';
const TH = 'bit-patterns';
const HOUR = 3600;
const at = (iso: string) => Date.parse(iso);

async function finish(core: StudyCore, v: Awaited<ReturnType<StudyCore['startStage']>>) {
  let cur = await toFirstQuestion(core, v);
  for (let i = 0; i < 20; i++) {
    const r = await answerAndNext(core, cur, 'correct');
    if (r.completion) return r.completion;
    cur = r.view;
  }
  throw new Error('完了しない');
}
const fruits = (c: StudyCore) => c.getGardenSnapshot().fruits;

test('実の回復: 1時間に1個。59分59秒では増えず、ちょうど1時間で1個。同じ時刻に何度処理しても二重に回復しない', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ clock });
  const v = await core.startStage(IT, TH); // 8 → 7
  assert.equal(fruits(core), 7);
  await core.interrupt(v.stageId);
  clock.advance(HOUR - 1);
  await core.refreshClock();
  assert.equal(fruits(core), 7);
  clock.advance(1);
  await Promise.all([core.refreshClock(), core.refreshClock(), core.refreshClock()]);
  assert.equal(fruits(core), 8, 'ちょうど1時間で1個');
  await core.refreshClock();
  await core.refreshClock();
  assert.equal(fruits(core), 8, '同じ時刻の繰り返しで増えない');
  clock.advance(HOUR * 5);
  assert.equal(fruits(core), 10, '上限10で止まる（表示は書き込みなしで計算）');
  assert.equal(core.getState().wallet.fruits, 8, '表示の計算だけでは保存を書き換えない');
  await core.refreshClock();
  assert.equal(core.getState().wallet.fruits, 10);
});

test('満タンの間の時間は貯金しない: 満タンから1個消費した直後に回復せず、そこから1時間後に回復', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ clock, config: { initialFruits: 10 } });
  clock.advance(HOUR * 6); // 満タンのまま6時間
  const v = await core.startStage(IT, TH);
  assert.equal(fruits(core), 9);
  await core.interrupt(v.stageId);
  await core.refreshClock();
  assert.equal(fruits(core), 9, '消費直後に回復しない');
  clock.advance(HOUR - 1);
  assert.equal(fruits(core), 9);
  clock.advance(1);
  assert.equal(fruits(core), 10);
  const snap = core.getGardenSnapshot();
  assert.equal(snap.nextFruitAt, null, '満タンなら次の回復は無い');
});

test('JST日付: 23:59→00:00で満タン。長時間不在でも上限10、日付が同じ間は日次の再配布をしない', async () => {
  const clock = new FakeClock('2026-10-12T23:59:00+09:00');
  const { core } = await openCore({ clock, config: { initialFruits: 3 } });
  await core.refreshClock();
  assert.equal(fruits(core), 3);
  clock.advance(30);
  assert.equal(fruits(core), 3, '00:00の前は満タンにならない');
  clock.advance(31);
  assert.equal(fruits(core), 10, '00:00を過ぎたら満タン');
  await core.refreshClock();
  const v = await core.startStage(IT, TH); // 10 → 9（同じ日）
  await core.interrupt(v.stageId);
  await core.endStage(v.stageId);
  assert.equal(fruits(core), 9);
  clock.advance(60);
  await core.refreshClock();
  assert.equal(fruits(core), 9, '同じ日に再配布しない');
  clock.advanceDays(30);
  assert.equal(fruits(core), 10);
  const nd = nextDayStart(clock.now(), 540);
  assert.equal(new Date(nd + 540 * 60_000).toISOString().slice(11, 19), '00:00:00');
  assert.ok(nd > clock.now() && nd - clock.now() <= 86_400_000);
});

test('旧保存(時計なし): 現在の実を保ち、さかのぼって配らず、移行時から時計を始める', async () => {
  const st = new MemoryStorage();
  st.setRaw(JSON.stringify({ schemaVersion: 1, wallet: { fruits: 4, maxFruits: 10 }, points: 0, studySeconds: {}, completedThemes: {}, reviews: {}, mastery: {}, stages: {}, completions: {}, log: [] }));
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ storage: st, clock });
  assert.equal(fruits(core), 4);
  await core.refreshClock();
  assert.equal(fruits(core), 4, '開いただけでは増えない');
  assert.equal(core.getState().fruitClock?.maxSeen, clock.now());
  clock.advance(HOUR);
  assert.equal(fruits(core), 5);
  const re = await openCore({ storage: st, clock });
  assert.equal(fruits(re.core), 5, '保存して開き直しても同じ');
});

test('時計が戻ったら、既知の最大時刻に追いつくまで新しい回復も日次の再配布もしない', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ clock, config: { initialFruits: 3 } });
  await core.refreshClock();
  clock.advanceDays(1); // 翌日: 満タン
  await core.refreshClock();
  assert.equal(fruits(core), 10);
  const v = await core.startStage(IT, TH);
  await core.interrupt(v.stageId);
  await core.endStage(v.stageId);
  assert.equal(fruits(core), 9);
  const known = clock.now();
  clock.t = at('2026-10-12T12:00:00+09:00'); // 前日へ戻す
  await core.refreshClock();
  assert.equal(fruits(core), 9, '戻した時計で満タンにしない');
  clock.t = known - 1000;
  assert.equal(fruits(core), 9);
  clock.t = known + HOUR * 1000 - 1000;
  assert.equal(fruits(core), 9, '追いついても、起点(最大時刻)から1時間たつまで回復しない');
  clock.t = known + HOUR * 1000;
  assert.equal(fruits(core), 10);
  assert.equal(core.getState().fruitClock!.maxSeen, known, '戻した間に記録した最大時刻は更新されない');
});

test('保存失敗: 時計の更新も受取も、残高を片側だけ進めない', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const flaky = new FlakyStorage(new MemoryStorage());
  const { core } = await openCore({ clock, storage: flaky });
  const v = await core.startStage(IT, TH);
  await core.interrupt(v.stageId);
  clock.advance(HOUR * 2);
  flaky.failNextSaves = 1;
  await assert.rejects(core.refreshClock(), (e: unknown) => e instanceof CoreError && e.code === codes.storageWrite);
  assert.equal(core.getState().wallet.fruits, 7, '保存に失敗したら保存済みの状態のまま');
  assert.equal(fruits(core), 9, '表示は時計から計算した値');
  await core.refreshClock();
  assert.equal(core.getState().wallet.fruits, 9);
  await core.refreshClock();
  assert.equal(fruits(core), 9, '再試行で二重に回復しない');
});

test('今日のミッション: 新しい学習1ステージ/無料のおさらい1回で実を各1個。完了IDを根拠に二重受取せず、診断・中断・終了は完了にしない', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ clock });
  assert.deepEqual(core.getGardenSnapshot().missions.learn, { done: false, claimed: false });
  assert.deepEqual(await core.claimMission('learn'), { status: 'not_done' });
  const s1 = await core.startStage(IT, TH);
  await core.interrupt(s1.stageId);
  assert.equal(core.getGardenSnapshot().missions.learn.done, false, '中断は完了にしない');
  await core.resume(s1.stageId);
  await core.endStage(s1.stageId);
  assert.equal(core.getGardenSnapshot().missions.learn.done, false, '終了は完了にしない');
  assert.equal(fruits(core), 7);
  const s2 = await core.startStage(IT, TH); // 7 → 6
  await finish(core, s2);
  assert.deepEqual(core.getGardenSnapshot().missions.learn, { done: true, claimed: false });
  const [a, b] = await Promise.all([core.claimMission('learn'), core.claimMission('learn')]);
  assert.deepEqual([a.status, b.status].sort(), ['already', 'claimed']);
  assert.equal(fruits(core), 7, '実は1個だけ増える');
  assert.deepEqual(await core.claimMission('learn'), { status: 'already' });
  assert.equal(fruits(core), 7);
  assert.deepEqual(await core.claimMission('review'), { status: 'not_done' });
  // 翌日のおさらい
  clock.advanceDays(1);
  await core.refreshClock();
  assert.deepEqual(core.getGardenSnapshot().missions.learn, { done: false, claimed: false }, '日が替わればミッションも新しい日');
  const rv = await core.startReview(IT);
  let cur = rv;
  for (let i = 0; i < 2; i++) {
    const r = await answerAndNext(core, cur, 'correct');
    if (r.completion) break;
    cur = r.view;
  }
  assert.deepEqual(core.getGardenSnapshot().missions.review, { done: true, claimed: false });
  const before = fruits(core);
  assert.equal(before, 10, '日が替わって満タン');
  assert.deepEqual(await core.claimMission('review'), { status: 'pending_full' }, '満タンなら受取を保留');
  assert.equal(fruits(core), 10);
  assert.deepEqual(core.getGardenSnapshot().missions.review, { done: true, claimed: false }, '保留は受取済みにしない');
  const s3 = await core.startStage(IT, TH);
  await core.interrupt(s3.stageId);
  assert.equal(fruits(core), 9);
  assert.deepEqual(await core.claimMission('review'), { status: 'claimed', fruits: 10 }, '空きができてから受け取れる');
  assert.deepEqual(await core.claimMission('review'), { status: 'already' });
  assert.equal(fruits(core), 10, '上限10を超えない');
});

test('ミッションの保存失敗: 実の加算と受取の記録は片側だけ進まない。時計を戻しても過去日の再作成/再受取をしない', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const flaky = new FlakyStorage(new MemoryStorage());
  const { core } = await openCore({ clock, storage: flaky });
  const s = await core.startStage(IT, TH);
  await finish(core, s);
  const fr = fruits(core);
  flaky.failNextSaves = 1;
  await assert.rejects(core.claimMission('learn'), (e: unknown) => e instanceof CoreError && e.code === codes.storageWrite);
  assert.equal(fruits(core), fr);
  assert.equal(core.getGardenSnapshot().missions.learn.claimed, false);
  assert.deepEqual(await core.claimMission('learn'), { status: 'claimed', fruits: fr + 1 });
  // 時計を前日へ戻す: 新しい完了はミッションにも木にも数えない
  const treeBefore = core.getGardenSnapshot().tree.total;
  clock.t = at('2026-10-11T10:00:00+09:00');
  const s2 = await core.startStage(IT, TH);
  await finish(core, s2);
  assert.equal(core.getGardenSnapshot().tree.total, treeBefore, '戻した日の完了は世話に数えない');
  assert.deepEqual(await core.claimMission('learn'), { status: 'already' });
  assert.equal(core.getGardenSnapshot().missions.day, '2026-10-12', '過去日のミッションを作らない');
});

test('木の世話: 学習とおさらいを合わせて日ごとに1回、累計と段階を記録。誤答や休みで下がらない', async () => {
  assert.deepEqual([0, 1, 2, 3, 6, 7, 30].map(treeStage), ['seed', 'sprout', 'sprout', 'leaf', 'leaf', 'fruit', 'fruit']);
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ clock, config: { initialFruits: 10 } });
  assert.deepEqual(core.getGardenSnapshot().tree, { total: 0, stage: 'seed', caredToday: false });
  const a = await core.startStage(IT, TH);
  await finish(core, a);
  assert.deepEqual(core.getGardenSnapshot().tree, { total: 1, stage: 'sprout', caredToday: true });
  const b = await core.startStage(IT, TH);
  await finish(core, b);
  assert.equal(core.getGardenSnapshot().tree.total, 1, '同じ日の2回目は数えない');
  clock.advanceDays(3); // 休み
  assert.equal(core.getGardenSnapshot().tree.total, 1, '休んでも減らない');
  assert.equal(core.getGardenSnapshot().tree.caredToday, false);
  let wrongStage = await core.startStage(IT, TH);
  let cur = await toFirstQuestion(core, wrongStage);
  for (let i = 0; i < 20; i++) {
    const r = await answerAndNext(core, cur, 'wrong');
    if (r.completion) break;
    cur = r.view;
  }
  assert.equal(core.getGardenSnapshot().tree.total, 2, '誤答だけでも世話はできて、枯れない');
  clock.advanceDays(1);
  await core.refreshClock();
  const rv = await core.startReview(IT);
  cur = rv;
  for (let i = 0; i < 2; i++) {
    const r = await answerAndNext(core, cur, 'correct');
    if (r.completion) break;
    cur = r.view;
  }
  assert.deepEqual(core.getGardenSnapshot().tree, { total: 3, stage: 'leaf', caredToday: true });
});

test('保存の検査: 実の時計・ミッション・受取台帳・木の壊れた形は黙って初期化せず拒否する', () => {
  const base = { schemaVersion: 1, wallet: { fruits: 4, maxFruits: 10 }, points: 0, studySeconds: {}, completedThemes: {}, reviews: {}, mastery: {}, stages: {}, completions: {}, log: [] };
  const ok = { ...base, fruitClock: { lastDay: '2026-10-12', anchor: 1, maxSeen: 2 }, daily: { day: '2026-10-12', learn: { completionId: null, claimed: false }, review: { completionId: 'c', claimed: true } }, claimed: { c: '2026-10-12' }, tree: { total: 2, lastDay: '2026-10-12' } };
  assert.doesNotThrow(() => parseState(ok));
  for (const bad of [
    { ...ok, fruitClock: { lastDay: 5, anchor: 1, maxSeen: 2 } }, { ...ok, fruitClock: 'x' }, { ...ok, daily: { day: 'd', learn: {}, review: {} } },
    { ...ok, claimed: { c: 1 } }, { ...ok, tree: { total: -1, lastDay: '' } }, { ...ok, tree: 'x' },
  ]) assert.throws(() => parseState(bad as unknown as CoreState), (e: unknown) => e instanceof CoreError && e.code === codes.corruptStorage);
});

// ---- 導入前の完了記録の引き継ぎ ----
const JST = (iso: string) => Date.parse(`${iso}+09:00`);
function legacy(over: Record<string, unknown> = {}, completions: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, wallet: { fruits: 8, maxFruits: 10 }, points: 10, studySeconds: { [IT]: 300 }, completedThemes: {}, reviews: {}, mastery: {}, stages: {}, log: [],
    completions: {
      'completion:old': { completionId: 'completion:old', stageId: 'old', kind: 'learn', qualificationId: IT, themeId: TH, pointsAwarded: 10, completedAt: JST('2026-10-10T10:00:00') },
      'completion:L': { completionId: 'completion:L', stageId: 'L', kind: 'learn', qualificationId: 'fp-3', themeId: 't', pointsAwarded: 10, completedAt: JST('2026-10-20T10:00:00') },
      'completion:R': { completionId: 'completion:R', stageId: 'R', kind: 'review', qualificationId: 'fp-3', themeId: 't', pointsAwarded: 0, completedAt: JST('2026-10-20T11:00:00') },
      ...completions,
    },
    ...over,
  };
}
const openWith = async (raw: unknown, iso: string, storage = new MemoryStorage()) => {
  storage.setRaw(JSON.stringify(raw));
  const clock = new FakeClock(iso);
  const rig = await openCore({ storage, clock });
  return { ...rig, storage, clock };
};

test('引き継ぎ(時計導入前の旧保存): 今日の学習/おさらいが達成、世話は有効な完了日のユニーク日数。過去日へ実を配らず、実・ポイント・学習秒は変えない', async () => {
  const { core, storage } = await openWith(legacy(), '2026-10-20T15:00:00+09:00');
  await core.refreshClock();
  const s = core.getGardenSnapshot();
  assert.deepEqual(s.missions.learn, { done: true, claimed: false }, '今日の学習は達成・未受取');
  assert.deepEqual(s.missions.review, { done: true, claimed: false });
  assert.equal(s.tree.total, 2, '10/10 と 10/20 の2日');
  assert.equal(s.tree.caredToday, true);
  assert.equal(s.fruits, 8);
  assert.equal(s.points, 10);
  assert.equal(core.getState().studySeconds[IT], 300);
  assert.equal(core.getState().growthMigrated, true);
  // 受け取りは今日の分だけ・各1個。過去日の分は無い
  assert.deepEqual(await core.claimMission('learn'), { status: 'claimed', fruits: 9 });
  assert.deepEqual(await core.claimMission('review'), { status: 'claimed', fruits: 10 });
  // 再起動しても二重に配らない・引き継ぎ直さない
  const again = await openCore({ storage, clock: new FakeClock('2026-10-20T16:00:00+09:00') });
  await again.core.refreshClock();
  assert.equal(again.core.getGardenSnapshot().fruits, 10);
  assert.equal(again.core.getGardenSnapshot().tree.total, 2);
  assert.deepEqual(await again.core.claimMission('learn'), { status: 'already' });
});

test('引き継ぎ(親の実際の状態): 復習の報酬だけ受取済み・実8・ポイント10・世話1。学習ミッションだけ未受取に戻り、世話は重複加算されない', async () => {
  const raw = legacy({
    fruitClock: { lastDay: '2026-10-20', anchor: JST('2026-10-20T12:00:00'), maxSeen: JST('2026-10-20T12:00:00') },
    daily: { day: '2026-10-20', learn: { completionId: null, claimed: false }, review: { completionId: 'completion:R', claimed: true } },
    claimed: { 'completion:R': '2026-10-20' },
    tree: { total: 1, lastDay: '2026-10-20' },
  }, { 'completion:old': undefined });
  delete (raw.completions as Record<string, unknown>)['completion:old'];
  const { core } = await openWith(raw, '2026-10-20T12:30:00+09:00'); // 回復の起点から1時間未満
  await core.refreshClock();
  const s = core.getGardenSnapshot();
  assert.deepEqual(s.missions.learn, { done: true, claimed: false });
  assert.deepEqual(s.missions.review, { done: true, claimed: true }, '受取済みの復習は受取済みのまま');
  assert.equal(s.tree.total, 1, '同じ日の既存の世話と二重に足さない');
  assert.equal(s.fruits, 8);
  assert.deepEqual(await core.claimMission('review'), { status: 'already' });
  assert.deepEqual(await core.claimMission('learn'), { status: 'claimed', fruits: 9 });
});

test('引き継ぎ: 未来の完了・時計戻し・書込み失敗・壊れた印', async () => {
  // 未来(既知の最大時刻より後)の完了は数えない。今日より後の日は世話にも入れない
  const fut = legacy({}, { 'completion:F': { completionId: 'completion:F', stageId: 'F', kind: 'learn', qualificationId: IT, themeId: TH, pointsAwarded: 10, completedAt: JST('2026-10-25T10:00:00') } });
  delete (fut.completions as Record<string, unknown>)['completion:L'];
  const a = await openWith(fut, '2026-10-20T15:00:00+09:00');
  await a.core.refreshClock();
  assert.equal(a.core.getGardenSnapshot().tree.total, 2, '10/10 と 10/20(復習) のみ。10/25 は未来で数えない');
  assert.equal(a.core.getGardenSnapshot().missions.learn.done, false, '未来の学習は今日の達成にしない');
  // 時計が戻っている起動: 戻した時刻より後の完了は数えず、実も配らない
  const b = await openWith(legacy(), '2026-10-12T09:00:00+09:00');
  await b.core.refreshClock();
  assert.equal(b.core.getGardenSnapshot().tree.total, 1, '10/10 だけ');
  assert.equal(b.core.getGardenSnapshot().fruits, 8);
  assert.equal(b.core.getGardenSnapshot().missions.learn.done, false);
  // 書込み失敗: 印も世話も進まず、再試行で1回だけ
  const flaky = new FlakyStorage(new MemoryStorage());
  (flaky.inner as MemoryStorage).setRaw(JSON.stringify(legacy()));
  const core = (await openCore({ storage: flaky, clock: new FakeClock('2026-10-20T15:00:00+09:00') })).core;
  flaky.failNextSaves = 1;
  await assert.rejects(core.refreshClock(), (e: unknown) => e instanceof CoreError && e.code === codes.storageWrite);
  assert.equal(core.getState().growthMigrated, undefined);
  assert.equal(core.getState().tree, undefined);
  await core.refreshClock();
  await core.refreshClock();
  assert.equal(core.getGardenSnapshot().tree.total, 2);
  // 壊れた印は拒否
  assert.throws(() => parseState({ ...legacy(), growthMigrated: 'yes' } as unknown as CoreState), (e: unknown) => e instanceof CoreError && e.code === codes.corruptStorage);
});

test('表示の計算(スナップショット)は、保存済みの状態を書き換えない（引き継ぎも保存するまで反映しない）', async () => {
  const { core } = await openWith(legacy(), '2026-10-20T15:00:00+09:00');
  const before = JSON.stringify(core.getState());
  core.getGardenSnapshot();
  assert.equal(JSON.stringify(core.getState()), before);
});

test('実0でも無料のおさらいは使える。復習は実を使わない', async () => {
  const clock = new FakeClock('2026-10-12T09:00:00+09:00');
  const { core } = await openCore({ clock, config: { initialFruits: 1 } });
  await finish(core, await core.startStage(IT, TH));
  assert.equal(fruits(core), 0);
  await assert.rejects(core.startStage(IT, TH), (e: unknown) => e instanceof CoreError && e.code === codes.noFruits);
  clock.advance(HOUR * 24 - 3600 * 9 - 60 + 120); // 翌0時を少し過ぎるが、復習の期日(翌日)になる
  const rv = await core.startReview(IT);
  assert.equal(rv.progress.total, 2);
  void StudyCore;
  void DEMO_CONFIG;
  void BitPatternsContent;
  void seqIds;
  void MemoryStorage;
});
