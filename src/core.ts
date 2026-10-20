import { findQualification, themeKey } from './catalog.ts';
import { DEMO_CONFIG, type CoreConfig } from './config.ts';
import { codes, CoreError } from './errors.ts';
import { emptyState } from './storageBase.ts';
import type {
  AnswerMode, AnswerRecord, Clock, CompletionResult, ContentProvider, CoreEvent, CoreState, GardenSnapshot, Mastery,
  Question, QuestionPhase, Stage, StageView, StorageAdapter, ThemeContent, WeakSignal,
} from './types.ts';
import { describeReferences, validateQuestion } from './validate.ts';
import { parseNumberInput, sameNumber, shortAnswerOf } from './numberInput.ts';
import { applyClock, claimMission, jstDay, projectWallet, recordCompletion, treeStage, type ClaimResult, type MissionKind } from './growth.ts';

export interface StartOptions {
  /** 4択（初期）か、検算できる数値の問題で数字を入力するか。ステージと一緒に保存される */
  answerMode?: AnswerMode;
}

export const RECHECK_COUNT = 2;

export interface CoreDeps {
  storage: StorageAdapter;
  content: ContentProvider;
  clock: Clock;
  newId?: () => string;
  config?: CoreConfig;
}

type Listener = (event: CoreEvent) => void | Promise<void>;
type Draft = CoreState;

export function localDate(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 状態はJSONのみで構成。Hermes等でstructuredCloneが無くても動くようJSONで複製 */
const cloneState = (s: CoreState): CoreState => JSON.parse(JSON.stringify(s)) as CoreState;

const err = (code: string, msg: string) => new CoreError(code, msg);

export class StudyCore {
  private state: CoreState;
  private readonly d: Required<CoreDeps>;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<Listener>();

  private constructor(state: CoreState, deps: CoreDeps) {
    this.state = state;
    this.d = { newId: () => globalThis.crypto.randomUUID(), config: DEMO_CONFIG, ...deps };
  }

  /** 保存データを読んで開く。壊れていれば CORRUPT_STORAGE で失敗し、何も上書きしない */
  static async open(deps: CoreDeps): Promise<StudyCore> {
    const cfg = deps.config ?? DEMO_CONFIG;
    const loaded = await deps.storage.load();
    const state = loaded.kind === 'ok' ? loaded.state : emptyState(cfg.initialFruits, cfg.maxFruits);
    return new StudyCore(state, deps);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------- 読み取り ----------
  getGardenSnapshot(): GardenSnapshot {
    return snapshotOf(this.state, this.d.clock.now(), this.d.config);
  }

  /**
   * 実の時計を進めて保存する（アプリに戻ったとき・次の回復の時刻になったとき）。変化が無ければ書かない。
   * 同じ時刻に何度呼んでも二重に回復しない。
   */
  async refreshClock(): Promise<GardenSnapshot> {
    const now = this.d.clock.now();
    const probe = cloneState(this.state);
    if (!applyClock(probe, now, this.d.config)) return this.getGardenSnapshot();
    await this.run(() => undefined);
    return this.getGardenSnapshot();
  }

  /**
   * 今日のミッションの実を受け取る（学習/おさらいを今日完了していれば実1個）。
   * 実の加算と受取の記録は同じ1回の保存。満タンなら受取を保留し（pending_full）、何も変えない。同じ完了IDは二重に受け取れない。
   */
  async claimMission(kind: MissionKind): Promise<ClaimResult> {
    return this.run((draft, ev) => {
      const r = claimMission(draft, kind);
      if (r.status === 'claimed') {
        draft.log.push({ type: 'mission', at: this.d.clock.now() });
        ev.push({ type: 'garden_outcome', snapshot: snapshotOf(draft, this.d.clock.now(), this.d.config) });
      }
      return r;
    });
  }

  getState(): Readonly<CoreState> {
    return cloneState(this.state);
  }

  /** 中断中・進行中の最新ステージ */
  findResumable(): Stage | undefined {
    return Object.values(this.state.stages)
      .filter((s) => s.status === 'active' || s.status === 'paused')
      .sort((a, b) => b.lastActionAt - a.lastActionAt)[0];
  }

  getStageView(stageId: string): StageView {
    const s = this.requireStage(this.state, stageId);
    const view: StageView = {
      stageId: s.id,
      status: s.status,
      phase: s.phase,
      step: s.step,
      progress: { index: 0, total: s.kind === 'learn' ? s.coreCount + RECHECK_COUNT : s.questions.length },
      answerMode: s.answerMode ?? 'choice',
    };
    if (s.phase === 'recheck') {
      const today = localDate(this.d.clock.now(), this.d.config.tzOffsetMinutes);
      view.recall = s.kind === 'review' && today > s.learnedDate ? 'later' : 'same_day';
    }
    if (s.phase === 'intro' || s.phase === 'explain') {
      view.progress.index = 0;
    }
    if (s.phase === 'core' || s.phase === 'recheck') {
      const q = s.questions[s.currentIndex] as Question;
      view.progress.index = s.currentIndex + 1;
      view.qState = s.qState;
      const num = this.numericOf(s, q);
      view.question = {
        id: q.id,
        prompt: q.prompt,
        // 数字入力の問題では選択肢（答えを含む）を出さない
        options: num ? [] : q.options.map((o) => ({ id: o.id, text: o.text })),
        selectedOptionId: s.selectedOptionId,
        hintShown: s.hintUsedFor.includes(q.id),
        ...(num ? { input: { kind: 'number' as const, unit: num.unit } } : {}),
      };
      if (s.qState === 'feedback') {
        const a = s.answers.find((x) => x.questionId === q.id) as AnswerRecord;
        const chosen = q.options.find((o) => o.id === a.optionId);
        view.feedback = {
          outcome: a.outcome,
          correctOptionId: (q.options.find((o) => o.isCorrect) as { id: string }).id,
          explanation: q.explanation,
          ...(chosen?.whyWrong && !chosen.isCorrect ? { whyWrong: chosen.whyWrong } : {}),
          ...(num ? { input: { entered: a.input ? a.input.raw : '', correctAnswer: num.acceptedText } } : {}),
          references: describeReferences(q, s.contentVersion),
        };
      }
    }
    if (s.phase === 'completed') view.progress.index = view.progress.total;
    return view;
  }

  /** 導入・説明の本文は教材から取得（ビューに載せたい時だけ呼ぶ） */
  async getStageIntro(stageId: string): Promise<{ title: string; intro: string; explanation: string[] }> {
    const s = this.requireStage(this.state, stageId);
    const c = await this.loadContent(s.qualificationId, s.themeId);
    return { title: c.title, intro: c.intro, explanation: c.explanation };
  }

  // ---------- 開始・再開・中断・終了 ----------
  async startStage(qualificationId: string, themeId: string, opts: StartOptions = {}): Promise<StageView> {
    return this.run(async (draft, ev) => {
      if (!findQualification(qualificationId)) throw err(codes.notAllowed, `未登録の資格: ${qualificationId}`);
      const now = this.d.clock.now();
      const existing = Object.values(draft.stages).find(
        (s) => s.kind === 'learn' && (s.status === 'active' || s.status === 'paused') && s.qualificationId === qualificationId && s.themeId === themeId,
      );
      if (!existing) this.assertNoOtherActive(draft);
      const content = await this.loadContent(qualificationId, themeId);
      if (existing) {
        // 二重開始: 同じステージを再開する。実は消費しない
        this.assertVersion(existing, content);
        this.resumeIn(draft, existing, now, ev);
        return this.getViewFrom(draft, existing.id);
      }
      // 保留で出せる問題が足りないテーマは、実を使う前に断る（理由は content.blocked）
      if (content.blocked) throw err(codes.themeOnHold, content.blocked);
      const mode: AnswerMode = opts.answerMode ?? 'choice';
      if (mode !== 'choice' && mode !== 'number') throw err(codes.notAllowed, '入力方式が不正です');
      if (mode === 'number' && !content.coreQuestions.some((q) => shortAnswerOf(q))) throw err(codes.notAllowed, 'このテーマには数字で入力する問題がありません');
      if (draft.wallet.fruits < 1) throw err(codes.noFruits, '知恵の実がありません。無料の復習は実なしで始められます');
      const id = this.d.newId();
      const stage: Stage = {
        id, kind: 'learn', qualificationId, themeId, contentVersion: content.version,
        status: 'active', phase: 'intro', step: 0,
        questions: content.coreQuestions, coreCount: content.coreQuestions.length,
        currentIndex: 0, qState: 'choosing', selectedOptionId: null, hintUsedFor: [], answerMode: mode, answers: [],
        fruitConsumed: true, startedAt: now, lastActionAt: now, activeSeconds: 0,
        learnedDate: localDate(now, this.d.config.tzOffsetMinutes), completionId: `completion:${id}`,
      };
      draft.stages[id] = stage;
      draft.wallet.fruits -= 1; // 最初の問題が利用可能（読込み・検証済み）になった時点で1個
      draft.log.push({ type: 'start', stageId: id, at: now });
      ev.push({ type: 'stage_started', stageId: id, qualificationId, themeId });
      ev.push({ type: 'fruit_consumed', stageId: id, remaining: draft.wallet.fruits });
      ev.push({ type: 'garden_outcome', snapshot: snapshotOf(draft, now, this.d.config) });
      return this.getViewFrom(draft, id);
    });
  }

  /** 無料復習。知恵の実は消費せず、0でも開始できる */
  async startReview(qualificationId: string, opts: StartOptions = {}): Promise<StageView> {
    return this.run(async (draft, ev) => {
      const now = this.d.clock.now();
      const today = localDate(now, this.d.config.tzOffsetMinutes);
      const items = Object.values(draft.reviews)
        .filter((r) => r.qualificationId === qualificationId)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      // 期日が来ているテーマのうち、間違えた/わからなかった/ヒントで正解した問題が残るテーマを先に（同数なら期日の早い順）
      const due = items.filter((r) => r.dueDate <= today);
      const item = due.length > 0
        ? due.map((r, i) => ({ r, i, n: this.weakFor(draft, qualificationId, r.themeId).length })).sort((a, b) => b.n - a.n || a.i - b.i)[0]!.r
        : items[0];
      if (!item) throw err(codes.nothingToReview, '復習できる完了済みテーマがありません');
      const existing = Object.values(draft.stages).find(
        (s) => s.kind === 'review' && (s.status === 'active' || s.status === 'paused') && s.themeId === item.themeId && s.qualificationId === qualificationId,
      );
      const content = await this.loadContent(qualificationId, item.themeId);
      if (existing) {
        this.assertVersion(existing, content);
        this.resumeIn(draft, existing, now, ev);
        return this.getViewFrom(draft, existing.id);
      }
      if (content.blocked) throw err(codes.themeOnHold, content.blocked);
      this.assertNoOtherActive(draft);
      const id = this.d.newId();
      const weak: WeakSignal[] = this.weakFor(draft, qualificationId, item.themeId);
      let questions = content.buildRecheck({ seed: id, weak, coreQuestions: content.coreQuestions });
      // 数字入力を選んだ復習では、数字で答える問題が入るよう、種を変えて組み直す（決まった手順。同じ種なら同じ結果）
      for (let t = 1; opts.answerMode === 'number' && !questions.some((q) => shortAnswerOf(q)) && t <= 12; t++) {
        questions = content.buildRecheck({ seed: `${id}:${t}`, weak, coreQuestions: content.coreQuestions });
      }
      this.assertQuestions(questions, RECHECK_COUNT);
      const mode: AnswerMode = opts.answerMode ?? 'choice';
      if (mode !== 'choice' && mode !== 'number') throw err(codes.notAllowed, '入力方式が不正です');
      if (mode === 'number' && !questions.some((q) => shortAnswerOf(q))) throw err(codes.notAllowed, 'この復習には数字で入力する問題がありません');
      const stage: Stage = {
        id, kind: 'review', qualificationId, themeId: item.themeId, contentVersion: content.version,
        status: 'active', phase: 'recheck', step: 0, questions, coreCount: 0,
        currentIndex: 0, qState: 'choosing', selectedOptionId: null, hintUsedFor: [], answerMode: mode, answers: [],
        fruitConsumed: false, startedAt: now, lastActionAt: now, activeSeconds: 0,
        learnedDate: item.learnedDate, completionId: `completion:${id}`,
      };
      draft.stages[id] = stage;
      draft.log.push({ type: 'start_review', stageId: id, at: now });
      ev.push({ type: 'stage_started', stageId: id, qualificationId, themeId: item.themeId });
      return this.getViewFrom(draft, id);
    });
  }

  async interrupt(stageId: string): Promise<void> {
    await this.run((draft, ev) => {
      const s = this.requireStage(draft, stageId);
      if (s.status === 'paused') return; // 二重中断は何もしない
      if (s.status !== 'active') throw err(codes.notAllowed, '進行中ではありません');
      const now = this.d.clock.now();
      this.touch(draft, s, now);
      s.status = 'paused';
      draft.log.push({ type: 'interrupt', stageId, at: now });
      ev.push({ type: 'stage_interrupted', stageId });
    });
  }

  async resume(stageId: string): Promise<StageView> {
    return this.run(async (draft, ev) => {
      const s = this.requireStage(draft, stageId);
      if (s.status === 'completed' || s.status === 'ended') throw err(codes.notAllowed, '終了したステージは再開できません');
      const content = await this.loadContent(s.qualificationId, s.themeId);
      this.assertVersion(s, content);
      this.resumeIn(draft, s, this.d.clock.now(), ev);
      return this.getViewFrom(draft, stageId);
    });
  }

  /** 終了（やめる）。消費済みの実は戻さない */
  async endStage(stageId: string): Promise<void> {
    await this.run((draft, ev) => {
      const s = this.requireStage(draft, stageId);
      if (s.status === 'ended' || s.status === 'completed') return;
      const now = this.d.clock.now();
      if (s.status === 'active') this.touch(draft, s, now);
      s.status = 'ended';
      draft.log.push({ type: 'end', stageId, at: now });
      ev.push({ type: 'stage_ended', stageId });
    });
  }

  // ---------- 回答 ----------
  /** 選択（確定前）。相棒へは正誤を含まない choice_selected だけを出す */
  async select(stageId: string, questionId: string, optionId: string): Promise<StageView> {
    return this.run((draft, ev) => {
      const { s, q } = this.requireQuestionState(draft, stageId, questionId);
      if (this.numericOf(s, q)) throw err(codes.notAllowed, 'この問題は数字で入力します');
      if (!q.options.some((o) => o.id === optionId)) throw err(codes.questionNotFound, `存在しない選択肢: ${optionId}`);
      this.touch(draft, s, this.d.clock.now());
      s.selectedOptionId = optionId;
      ev.push({ type: 'choice_selected', stageId, questionId, optionId, cue: 'idle' });
      return this.getViewFrom(draft, stageId);
    });
  }

  /** ヒントを見る。以後この問題の正解は「ヒント後正解」として区別する */
  async requestHint(stageId: string, questionId: string): Promise<string> {
    return this.run((draft) => {
      const { s, q } = this.requireQuestionState(draft, stageId, questionId);
      this.touch(draft, s, this.d.clock.now());
      if (!s.hintUsedFor.includes(q.id)) s.hintUsedFor.push(q.id);
      return q.hint;
    });
  }

  async confirm(stageId: string, questionId: string): Promise<StageView> {
    return this.run((draft, ev) => {
      const { s, q } = this.requireQuestionState(draft, stageId, questionId);
      if (this.numericOf(s, q)) throw err(codes.notAllowed, 'この問題は数字を入力して答えます');
      if (s.selectedOptionId === null) throw err(codes.notAllowed, '選択肢を選んでから確定してください');
      this.answerIn(draft, s, s.selectedOptionId, ev);
      return this.getViewFrom(draft, stageId);
    });
  }

  /**
   * 数字を入力して答える。形式が不正・違う単位は INVALID_INPUT で、回答も学習記録も進めない（保存もしない）。
   * 形式が正しい数値は、違っていても実際の入力値を残して不正解にする（選択肢には対応させない）。
   * 解答キーは教材の accepted（値の比較のみ。近いだけでは正解にしない）。
   */
  async submitNumber(stageId: string, questionId: string, text: string): Promise<StageView> {
    return this.run((draft, ev) => {
      const { s, q } = this.requireQuestionState(draft, stageId, questionId);
      const num = this.numericOf(s, q);
      if (!num) throw err(codes.notAllowed, 'この問題は選択肢で答えます');
      if (typeof text !== 'string') throw err(codes.invalidInput, '数字を入力してください。');
      const p = parseNumberInput(text, num.unit);
      if (!p.ok) throw err(codes.invalidInput, p.reason);
      const correct = num.accepted.some((a) => sameNumber(a, p.value));
      this.answerIn(draft, s, null, ev, { raw: p.display, value: p.value, correct });
      return this.getViewFrom(draft, stageId);
    });
  }

  /** 「わからない」。誤答扱いにせず、追加の実も消費しない。解説は見られる */
  async dontKnow(stageId: string, questionId: string): Promise<StageView> {
    return this.run((draft, ev) => {
      const { s } = this.requireQuestionState(draft, stageId, questionId);
      this.answerIn(draft, s, null, ev);
      return this.getViewFrom(draft, stageId);
    });
  }

  // ---------- 進行・完了 ----------
  /** 次へ。fromStep は画面が持つ view.step。古い・重複した操作は STALE_STEP で弾く。
   * 完了済みステージへの再送は報酬を再付与せず duplicate:true の結果を返す */
  async advance(stageId: string, fromStep: number): Promise<{ view: StageView; completion?: CompletionResult }> {
    return this.run(async (draft, ev) => {
      const s = this.requireStage(draft, stageId);
      if (s.status === 'completed') {
        return { view: this.getViewFrom(draft, stageId), completion: this.resultOf(draft, s, true) };
      }
      if (s.status !== 'active') throw err(codes.notAllowed, '進行中ではありません（再開してください）');
      if (s.step !== fromStep) throw err(codes.staleStep, '古い画面からの操作です');
      const now = this.d.clock.now();
      this.touch(draft, s, now);
      if (s.phase === 'intro') {
        s.phase = 'explain';
      } else if (s.phase === 'explain') {
        s.phase = 'core';
        s.currentIndex = 0;
        s.qState = 'choosing';
      } else if (s.phase === 'core' || s.phase === 'recheck') {
        if (s.qState !== 'feedback') throw err(codes.notAllowed, '回答してから次へ進めます');
        const last = s.currentIndex === s.questions.length - 1;
        const coreDone = s.kind === 'learn' && s.currentIndex === s.coreCount - 1 && s.questions.length === s.coreCount;
        if (coreDone) {
          const content = await this.loadContent(s.qualificationId, s.themeId);
          this.assertVersion(s, content);
          const weak: WeakSignal[] = s.answers
            .filter((a) => a.outcome === 'wrong' || a.outcome === 'unknown')
            .map((a) => {
              const q = s.questions.find((x) => x.id === a.questionId) as Question;
              return {
                questionId: q.id,
                misconception: a.outcome === 'unknown' ? 'unknown' : (a.misconception ?? 'unknown'),
                correctPosition: q.options.findIndex((o) => o.isCorrect),
              };
            });
          const recheck = content.buildRecheck({ seed: s.id, weak, coreQuestions: s.questions.slice(0, s.coreCount) });
          this.assertQuestions(recheck, RECHECK_COUNT);
          s.questions = [...s.questions, ...recheck];
          s.phase = 'recheck';
          s.currentIndex += 1;
        } else if (last) {
          this.completeIn(draft, s, now, ev);
          s.step += 1;
          return { view: this.getViewFrom(draft, stageId), completion: this.resultOf(draft, s, false) };
        } else {
          s.currentIndex += 1;
          if (s.kind === 'learn' && s.currentIndex >= s.coreCount) s.phase = 'recheck';
        }
        s.qState = 'choosing';
        s.selectedOptionId = null;
      }
      s.step += 1;
      return { view: this.getViewFrom(draft, stageId) };
    });
  }

  // ---------- 家具の入手（仮ポイント） ----------
  /**
   * 家具を仮ポイントで入手する。ポイントの減算と所持の追加は同じ1回の保存で行い、
   * 保存に失敗すれば残高も所持も変わらない。すでに持っていれば何も引かない（二重購入しない）。
   * ポイントはゲーム内の仮値で、金銭の価格・課金ではない。
   */
  async purchaseFurniture(furnitureId: string, cost: number): Promise<{ duplicate: boolean; points: number }> {
    return this.run((draft, ev) => {
      if (!furnitureId || !Number.isInteger(cost) || cost < 0) throw err(codes.notAllowed, '家具の指定が不正です');
      const f = (draft.furniture ??= { owned: [] });
      if (f.owned.includes(furnitureId)) return { duplicate: true, points: draft.points };
      if (draft.points < cost) throw err(codes.insufficientPoints, `ポイントが足りません（必要${cost}、いま${draft.points}）`);
      draft.points -= cost;
      f.owned.push(furnitureId);
      draft.log.push({ type: 'furniture', at: this.d.clock.now() });
      ev.push({ type: 'garden_outcome', snapshot: snapshotOf(draft, this.d.clock.now(), this.d.config) });
      return { duplicate: false, points: draft.points };
    });
  }

  // ---------- 内部 ----------
  /**
   * このテーマで今も残っている弱点（新しい順）。問題ごとに最新の回答だけを見て、
   * 間違い・わからない・ヒントを使って正解、のものを集める。後でヒントなしで正解していれば外れる。
   */
  private weakFor(state: CoreState, qualificationId: string, themeId: string): WeakSignal[] {
    const stages = Object.values(state.stages)
      .filter((s) => s.qualificationId === qualificationId && s.themeId === themeId)
      .sort((a, b) => b.startedAt - a.startedAt);
    const seen = new Set<string>();
    const out: WeakSignal[] = [];
    for (const s of stages) {
      for (const a of [...s.answers].reverse()) {
        const base = a.questionId.replace(/#recheck$/, '');
        if (seen.has(base)) continue;
        seen.add(base);
        if (a.outcome === 'wrong' || a.outcome === 'unknown' || a.outcome === 'hint_correct') {
          out.push({ questionId: base, misconception: a.outcome === 'wrong' ? (a.misconception ?? 'unknown') : 'unknown', correctPosition: -1 });
        }
      }
    }
    return out;
  }

  /** このステージ・この問題が数字入力か（入力方式が number で、検算できる shortAnswer がある問題だけ。旧保存は4択） */
  private numericOf(s: Stage, q: Question) {
    return s.answerMode === 'number' ? shortAnswerOf(q) : null;
  }

  private answerIn(draft: Draft, s: Stage, optionId: string | null, ev: CoreEvent[], typed?: { raw: string; value: number; correct: boolean }) {
    const now = this.d.clock.now();
    const q = s.questions[s.currentIndex] as Question;
    const option = optionId === null ? undefined : q.options.find((o) => o.id === optionId);
    const hintUsed = s.hintUsedFor.includes(q.id);
    const correct = typed ? typed.correct : option?.isCorrect === true;
    const outcome: AnswerRecord['outcome'] = typed
      ? (correct ? (hintUsed ? 'hint_correct' : 'correct') : 'wrong')
      : optionId === null ? 'unknown' : correct ? (hintUsed ? 'hint_correct' : 'correct') : 'wrong';
    const today = localDate(now, this.d.config.tzOffsetMinutes);
    const relation: AnswerRecord['relation'] =
      s.phase === 'core' ? 'first' : s.kind === 'review' && today > s.learnedDate ? 'later_review' : 'same_day_recheck';
    const phase: QuestionPhase = s.kind === 'review' ? 'review' : s.phase === 'core' ? 'core' : 'recheck';
    this.touch(draft, s, now);
    s.answers.push({
      questionId: q.id, phase, optionId, outcome, correct, hintUsed, relation,
      ...(typed ? { input: { raw: typed.raw, value: typed.value } } : {}),
      ...(option && !correct && option.misconception ? { misconception: option.misconception } : {}),
      answeredAt: now, localDate: today,
    });
    this.updateMastery(draft, s, outcome, relation);
    s.qState = 'feedback';
    s.step += 1;
    draft.log.push({ type: 'answer', stageId: s.id, at: now });
    if (correct) ev.push({ type: 'answer_correct', stageId: s.id, questionId: q.id, hintUsed, cue: 'cheer' });
    else ev.push({ type: 'encouragement', stageId: s.id, questionId: q.id, reason: optionId === null && !typed ? 'unknown' : 'wrong', cue: 'encourage' });
  }

  private updateMastery(draft: Draft, s: Stage, outcome: AnswerRecord['outcome'], relation: AnswerRecord['relation']) {
    const key = themeKey(s.qualificationId, s.themeId);
    const m: Mastery = draft.mastery[key] ?? { firstCorrect: 0, hintCorrect: 0, sameDayRecheckCorrect: 0, laterCorrect: 0, wrong: 0, unknown: 0, level: 'seen' };
    if (outcome === 'wrong') m.wrong += 1;
    else if (outcome === 'unknown') m.unknown += 1;
    else if (outcome === 'hint_correct') m.hintCorrect += 1;
    else if (relation === 'first') m.firstCorrect += 1;
    else if (relation === 'same_day_recheck') m.sameDayRecheckCorrect += 1;
    else m.laterCorrect += 1;
    // 後日の正解（ヒントなし）が1度でもあって初めて「後日思い出せた」。同日再確認だけでは定着と呼ばない
    m.level = m.laterCorrect > 0 ? 'recalled_later' : m.sameDayRecheckCorrect > 0 ? 'same_day_only' : 'seen';
    draft.mastery[key] = m;
  }

  private completeIn(draft: Draft, s: Stage, now: number, ev: CoreEvent[]) {
    const cid = s.completionId as string;
    if (draft.completions[cid]) return; // 既に付与済み
    const cfg = this.d.config;
    const today = localDate(now, cfg.tzOffsetMinutes);
    const key = themeKey(s.qualificationId, s.themeId);
    s.status = 'completed';
    s.phase = 'completed';
    const points = s.kind === 'learn' ? cfg.completionPoints : 0;
    draft.points += points;
    draft.completions[cid] = {
      completionId: cid, stageId: s.id, kind: s.kind, qualificationId: s.qualificationId, themeId: s.themeId,
      pointsAwarded: points, completedAt: now,
    };
    let dueDate: string;
    if (s.kind === 'learn') {
      draft.completedThemes[key] = { completedAt: now, contentVersion: s.contentVersion };
      dueDate = addDays(today, cfg.reviewIntervalsDays[0] as number);
      draft.reviews[key] = { qualificationId: s.qualificationId, themeId: s.themeId, contentVersion: s.contentVersion, step: 0, dueDate, learnedDate: s.learnedDate };
    } else {
      const item = draft.reviews[key];
      const clean = s.answers.length > 0 && s.answers.every((a) => a.outcome === 'correct'); // ヒントなし全問正解
      const early = item !== undefined && today < item.dueDate; // 予定日前の任意復習
      let step: number;
      if (clean && early) {
        step = item.step; // 予定日前の正解では間隔を進めない
        dueDate = item.dueDate;
      } else if (clean) {
        step = Math.min((item?.step ?? 0) + 1, cfg.reviewIntervalsDays.length - 1);
        dueDate = addDays(today, cfg.reviewIntervalsDays[step] as number);
      } else {
        step = 0;
        const next = addDays(today, cfg.reviewIntervalsDays[0] as number);
        dueDate = early && item.dueDate < next ? item.dueDate : next; // 既存のより早い期日は遅らせない
      }
      draft.reviews[key] = { qualificationId: s.qualificationId, themeId: s.themeId, contentVersion: s.contentVersion, step, dueDate, learnedDate: item?.learnedDate ?? s.learnedDate };
    }
    draft.log.push({ type: 'complete', stageId: s.id, at: now });
    // 今日のミッションと木の世話へ（同じ保存）。完了IDとJST日が根拠で、診断・中断・終了は入らない
    recordCompletion(draft, s.kind, cid, today);
    ev.push({ type: 'stage_completed', stageId: s.id, completionId: cid, pointsAwarded: points, cue: 'celebrate' });
    ev.push({ type: 'review_scheduled', qualificationId: s.qualificationId, themeId: s.themeId, dueDate });
    ev.push({ type: 'garden_outcome', snapshot: snapshotOf(draft, now, this.d.config) });
  }

  private resultOf(draft: Draft, s: Stage, duplicate: boolean): CompletionResult {
    const c = draft.completions[s.completionId as string] as { completionId: string; pointsAwarded: number };
    const r = draft.reviews[themeKey(s.qualificationId, s.themeId)];
    return {
      completionId: c.completionId,
      duplicate,
      pointsAwarded: duplicate ? 0 : c.pointsAwarded,
      totalPoints: draft.points,
      studySeconds: draft.studySeconds[s.qualificationId] ?? 0,
      nextReview: r ? { dueDate: r.dueDate, step: r.step } : null,
    };
  }

  private resumeIn(draft: Draft, s: Stage, now: number, ev: CoreEvent[]) {
    if (s.status === 'paused') {
      s.status = 'active';
      s.lastActionAt = now; // 中断中の時間は学習時間に数えない
      draft.log.push({ type: 'resume', stageId: s.id, at: now });
      ev.push({ type: 'stage_resumed', stageId: s.id });
    }
  }

  private touch(draft: Draft, s: Stage, now: number) {
    const gap = Math.max(0, (now - s.lastActionAt) / 1000);
    const counted = Math.min(gap, this.d.config.maxCountedGapSeconds);
    s.activeSeconds += counted;
    draft.studySeconds[s.qualificationId] = (draft.studySeconds[s.qualificationId] ?? 0) + counted;
    s.lastActionAt = now;
  }

  private requireStage(state: CoreState, id: string): Stage {
    const s = state.stages[id];
    if (!s) throw err(codes.stageNotFound, `ステージが見つかりません: ${id}`);
    return s;
  }

  private requireQuestionState(draft: Draft, stageId: string, questionId: string) {
    const s = this.requireStage(draft, stageId);
    if (s.status !== 'active') throw err(codes.notAllowed, '進行中ではありません（再開してください）');
    if (s.phase !== 'core' && s.phase !== 'recheck') throw err(codes.notAllowed, '問題の段階ではありません');
    const q = s.questions[s.currentIndex];
    if (!q || q.id !== questionId) throw err(codes.questionNotFound, `現在の問題ではありません: ${questionId}`);
    if (s.qState !== 'choosing') throw err(codes.notAllowed, 'この問題は回答済みです');
    return { s, q };
  }

  private assertNoOtherActive(draft: Draft) {
    const other = Object.values(draft.stages).find((s) => s.status === 'active' || s.status === 'paused');
    if (other) throw err(codes.activeStageExists, `別のステージが進行・中断中です: ${other.id}`);
  }

  private assertVersion(s: Stage, content: ThemeContent) {
    if (s.contentVersion !== content.version) {
      throw err(codes.staleContent, `教材版が変わりました（保存:${s.contentVersion} / 現在:${content.version}）。このステージは再開できません`);
    }
  }

  private assertQuestions(qs: Question[], expected?: number) {
    if (qs.length === 0 || (expected !== undefined && qs.length !== expected)) throw err(codes.contentInvalid, `問題数が不正: ${qs.length}`);
    const ids = new Set<string>();
    for (const q of qs) {
      const p = validateQuestion(q);
      if (p.length) throw err(codes.contentInvalid, `問題${q.id}: ${p.join(' / ')}`);
      if (ids.has(q.id)) throw err(codes.contentInvalid, `問題IDの重複: ${q.id}`);
      ids.add(q.id);
    }
  }

  private async loadContent(qualificationId: string, themeId: string): Promise<ThemeContent> {
    let c: ThemeContent;
    try {
      c = await this.d.content.loadTheme(qualificationId, themeId);
    } catch (e) {
      throw err(codes.contentLoad, `教材を読み込めません: ${(e as Error).message}`);
    }
    this.assertQuestions(c.coreQuestions);
    return c;
  }

  private getViewFrom(draft: Draft, id: string): StageView {
    const prev = this.state;
    this.state = draft; // ビュー生成だけ下書きを参照（commit前に外へ出さない）
    try {
      return this.getStageView(id);
    } finally {
      this.state = prev;
    }
  }

  /** 全操作を直列化。保存に成功した時だけメモリへ反映し、イベントを出す（失敗時は何も変えない） */
  private run<T>(fn: (draft: Draft, ev: CoreEvent[]) => Promise<T> | T): Promise<T> {
    const p = this.queue.then(async () => {
      const draft = cloneState(this.state);
      const events: CoreEvent[] = [];
      applyClock(draft, this.d.clock.now(), this.d.config); // 操作のたびに実の時計を進める（同じ時刻なら二重回復しない）
      const result = await fn(draft, events);
      try {
        await this.d.storage.save(draft);
      } catch (e) {
        throw err(codes.storageWrite, `保存に失敗しました。もう一度試せます: ${(e as Error).message}`);
      }
      this.state = draft;
      for (const event of events) this.emit(event);
      return result;
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  private emit(event: CoreEvent) {
    for (const l of this.listeners) {
      try {
        // 待たない。相棒の演出が遅くても回答処理を止めない
        void Promise.resolve(l(event)).catch(() => undefined);
      } catch {
        /* 購読側の例外はコアへ波及させない */
      }
    }
  }
}

function snapshotOf(s: CoreState, now: number, cfg: CoreConfig): GardenSnapshot {
  const w = projectWallet(s, now, cfg); // 書き込まずに、いまの見かけの実
  const known = s.fruitClock?.lastDay;
  const d = s.daily && s.daily.day === known ? s.daily : undefined;
  const todayKey = jstDay(Math.max(now, s.fruitClock?.maxSeen ?? now), cfg.tzOffsetMinutes);
  const missions = d && d.day === todayKey
    ? { day: d.day, learn: { done: d.learn.completionId !== null, claimed: d.learn.claimed }, review: { done: d.review.completionId !== null, claimed: d.review.claimed } }
    : { day: todayKey, learn: { done: false, claimed: false }, review: { done: false, claimed: false } };
  const total = s.tree?.total ?? 0;
  return {
    fruits: w.fruits,
    nextFruitAt: w.nextFruitAt,
    nextDayAt: w.nextDayAt,
    missions,
    tree: { total, stage: treeStage(total), caredToday: s.tree?.lastDay === todayKey },
    maxFruits: s.wallet.maxFruits,
    points: s.points,
    studySeconds: { ...s.studySeconds },
    completedThemes: Object.keys(s.completedThemes),
    ownedFurniture: [...(s.furniture?.owned ?? [])],
    masteryLevels: Object.fromEntries(Object.entries(s.mastery).map(([k, m]) => [k, m.level])),
    nextReviews: Object.values(s.reviews).map((r) => ({ qualificationId: r.qualificationId, themeId: r.themeId, dueDate: r.dueDate, step: r.step })),
  };
}
