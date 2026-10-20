// 開発者向けの操作用デモ（採用UIの代替ではない）。
//   npm run demo        … 一巡→中断→別インスタンスで再開→完了→二重完了→翌日の復習を自動実行して出力
//   npm run demo:play   … 端末で実際に操作。q で中断して終了すると、次回起動時に続きから再開する
// 保存先: data/demo-state.json（.gitignore済み）。--reset で消去。
import { createInterface } from 'node:readline/promises';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BitPatternsContent, JsonFileStorage, StudyCore, type Clock, type CoreEvent, type StageView } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const statePath = join(here, '..', 'data', 'demo-state.json');
const IT = 'it-passport';
const THEME = 'bit-patterns';

class OffsetClock implements Clock {
  offsetMs = 0;
  now() {
    return Date.now() + this.offsetMs;
  }
}

async function open(clock: Clock, label: string) {
  const core = await StudyCore.open({ storage: new JsonFileStorage(statePath), content: new BitPatternsContent(), clock });
  core.subscribe((e: CoreEvent) => {
    const brief = e.type === 'garden_outcome' ? JSON.stringify(e.snapshot) : JSON.stringify(e);
    console.log(`   [event/${label}] ${brief}`);
  });
  return core;
}

function show(v: StageView) {
  if (v.question) {
    console.log(`   ${v.phase} ${v.progress.index}/${v.progress.total}  ${v.question.prompt}`);
    v.question.options.forEach((o) => console.log(`      ${o.id}) ${o.text}`));
  } else console.log(`   phase=${v.phase} status=${v.status}`);
  if (v.feedback) console.log(`   → ${v.feedback.outcome} / 正解 ${v.feedback.correctOptionId} / ${v.feedback.explanation}${v.feedback.whyWrong ? ' / ' + v.feedback.whyWrong : ''}`);
}

function correctOf(core: StudyCore, v: StageView) {
  const s = core.getState().stages[v.stageId]!;
  return s.questions[s.currentIndex]!.options.find((o) => o.isCorrect)!.id;
}
function wrongOf(core: StudyCore, v: StageView) {
  const s = core.getState().stages[v.stageId]!;
  return s.questions[s.currentIndex]!.options.find((o) => !o.isCorrect)!.id;
}

async function scripted() {
  await rm(statePath, { force: true });
  const clock = new OffsetClock();
  console.log('== 1. 開始（知恵の実を1個消費）');
  let core = await open(clock, 'A');
  let v = await core.startStage(IT, THEME);
  v = (await core.advance(v.stageId, v.step)).view; // intro → explain
  v = (await core.advance(v.stageId, v.step)).view; // explain → core1
  console.log('== 2. 中心問題を3問（2問目は誤答、3問目はヒント後に正解）');
  for (let i = 0; i < 3; i++) {
    show(v);
    if (i === 2) console.log(`   ヒント: ${await core.requestHint(v.stageId, v.question!.id)}`);
    await core.select(v.stageId, v.question!.id, i === 1 ? wrongOf(core, v) : correctOf(core, v));
    const done = await core.confirm(v.stageId, v.question!.id);
    show(done);
    v = (await core.advance(done.stageId, done.step)).view;
  }
  console.log('== 3. 中断 → 別のコアインスタンスを起動して再開');
  await core.interrupt(v.stageId);
  core = await open(clock, 'B');
  console.log(`   再起動後の実=${core.getGardenSnapshot().fruits} 再開候補=${core.findResumable()?.id}`);
  v = await core.startStage(IT, THEME); // 二重開始 = 同じステージの再開
  console.log(`   再開位置: ${v.progress.index}/${v.progress.total}（実=${core.getGardenSnapshot().fruits}、二重消費なし）`);
  console.log('== 4. 残りを最後まで（中心6問→再確認2問）');
  let completion;
  while (!completion) {
    show(v);
    const q = v.question!.id;
    await core.select(v.stageId, q, correctOf(core, v));
    const done = await core.confirm(v.stageId, q);
    const r = await core.advance(done.stageId, done.step);
    v = r.view;
    completion = r.completion;
  }
  console.log(`== 5. 完了: ${JSON.stringify(completion)}`);
  console.log('== 6. 完了の再送（再読込み後でも報酬は重複しない）');
  core = await open(clock, 'C');
  const again = await core.advance(v.stageId, 0);
  console.log(`   ${JSON.stringify(again.completion)} 合計ポイント=${core.getGardenSnapshot().points}`);
  console.log('== 7. 無料復習（実は消費しない。翌日の想定で時計を+1日。実0でも開始できることはテストで確認）');
  clock.offsetMs += 86_400_000;
  let rv = await core.startReview(IT);
  while (rv.phase !== 'completed') {
    show(rv);
    await core.select(rv.stageId, rv.question!.id, correctOf(core, rv));
    const done = await core.confirm(rv.stageId, rv.question!.id);
    rv = (await core.advance(done.stageId, done.step)).view;
  }
  const st = core.getState();
  console.log(`   習熟: ${JSON.stringify(st.mastery[`${IT}/${THEME}`])}`);
  console.log(`   最終スナップショット: ${JSON.stringify(core.getGardenSnapshot())}`);
}

async function interactive() {
  const clock = new OffsetClock();
  const core = await open(clock, 'play');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const resumable = core.findResumable();
  let v: StageView;
  try {
    v = resumable ? await core.startStage(resumable.qualificationId, resumable.themeId) : await core.startStage(IT, THEME);
  } catch (e) {
    console.log(`開始できません: ${(e as Error).message}`);
    rl.close();
    return;
  }
  console.log(resumable ? '前回の続きから再開します。' : '新しいステージを開始しました。');
  while (true) {
    show(v);
    if (v.phase === 'completed') break;
    const prompt = v.phase === 'intro' || v.phase === 'explain' ? '[Enter]次へ / q 中断 > ' : v.qState === 'feedback' ? '[Enter]次へ / q 中断 > ' : '選択肢(a-d) / h ヒント / ? わからない / q 中断 > ';
    let input: string;
    try {
      input = (await rl.question(prompt)).trim();
    } catch {
      input = 'q'; // 入力が閉じられた（Ctrl+D・パイプ終端）場合は中断扱い
    }
    try {
      if (input === 'q') {
        await core.interrupt(v.stageId);
        console.log('中断しました。もう一度 npm run demo:play で続きから再開できます。');
        break;
      }
      if (v.phase === 'intro' || v.phase === 'explain' || v.qState === 'feedback') {
        const r = await core.advance(v.stageId, v.step);
        v = r.view;
        if (r.completion) console.log(`完了! ${JSON.stringify(r.completion)}`);
      } else if (input === 'h') console.log(`ヒント: ${await core.requestHint(v.stageId, v.question!.id)}`);
      else if (input === '?') v = await core.dontKnow(v.stageId, v.question!.id);
      else if (/^[a-d]$/.test(input)) {
        await core.select(v.stageId, v.question!.id, input);
        v = await core.confirm(v.stageId, v.question!.id);
      }
    } catch (e) {
      console.log(`! ${(e as Error).message}`);
    }
  }
  console.log(JSON.stringify(core.getGardenSnapshot()));
  rl.close();
}

if (process.argv.includes('--reset')) {
  await rm(statePath, { force: true });
  console.log('保存を消去しました');
} else if (process.argv.includes('--interactive')) await interactive();
else await scripted();
