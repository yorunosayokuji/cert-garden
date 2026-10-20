// 資格ごとの短い初回チェック（診断）。学習コア(StudyCore)とは別の状態・別の保存。
// 実・ポイントを使わず、学習テーマの完了にも数えない。結果は「今回のチェックでの正誤/要確認」と、
// 学習を始めるおすすめの基礎テーマだけ。資格全体のレベル・合格可能性・習得済みは断定しない。
import { codes, CoreError } from './errors.ts';
import { baseQuestionId, type QuestionRef } from './holds.ts';
import type { Clock, ContentProvider, Question, ReferenceView, ThemeContent } from './types.ts';
import { describeReferences } from './validate.ts';

export const DIAG_PER_THEME = 3;

export interface DiagItem {
  questionId: string;
  themeId: string;
  concept: string;
  /** 選択肢IDの表示順（run ごとに固定。再読込しても同じ） */
  order: string[];
}
export interface DiagAnswer {
  questionId: string;
  optionId: string | null; // null = わからない
  correct: boolean;
  answeredAt: number;
}
export interface DiagRun {
  runId: string;
  qualificationId: string;
  themeIds: string[];
  /** 開始時の教材版。変わったら続きを出さず、最初からやり直しにする */
  versions: Record<string, string>;
  startedAt: number;
  items: DiagItem[];
  answers: DiagAnswer[];
  index: number;
  qState: 'choosing' | 'feedback';
  selectedOptionId: string | null;
  /** 操作ごとに増える。二重押下・古い画面からの操作を弾く */
  step: number;
}
export interface DiagThemeResult {
  themeId: string;
  title: string;
  correct: number;
  unknown: number;
  wrong: number;
  total: number;
  /** solid=今回は正解が多かった / check=要確認。習得の判定ではない */
  level: 'solid' | 'check';
  concepts: { concept: string; correct: boolean }[];
}
export interface DiagResult {
  runId: string;
  qualificationId: string;
  completedAt: number;
  themes: DiagThemeResult[];
  recommendedThemeId: string;
}
export interface QualDiag {
  active?: DiagRun;
  latest?: DiagResult;
  /** 入口のすすめを「あとで」にした */
  dismissed?: boolean;
}
export interface DiagState {
  version: 1;
  quals: Record<string, QualDiag>;
}

export const emptyDiagState = (): DiagState => ({ version: 1, quals: {} });

export type DiagLoad = { kind: 'empty' } | { kind: 'ok'; state: DiagState } | { kind: 'corrupt' };
export interface DiagStorage {
  load(): Promise<DiagLoad>;
  save(state: DiagState): Promise<void>;
}

export class MemoryDiagStorage implements DiagStorage {
  state: DiagState | null = null;
  failNextSaves = 0;
  async load(): Promise<DiagLoad> {
    return this.state ? { kind: 'ok', state: JSON.parse(JSON.stringify(this.state)) as DiagState } : { kind: 'empty' };
  }
  async save(state: DiagState) {
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error('disk full (injected)');
    }
    this.state = JSON.parse(JSON.stringify(state)) as DiagState;
  }
}

// ---- 検査 ----
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validRun(r: unknown): r is DiagRun {
  const o = r as Partial<DiagRun> | null;
  if (typeof o !== 'object' || o === null) return false;
  return (
    isStr(o.runId) && isStr(o.qualificationId) && Array.isArray(o.themeIds) && o.themeIds.every(isStr) &&
    typeof o.versions === 'object' && o.versions !== null && isNum(o.startedAt) &&
    Array.isArray(o.items) && o.items.length > 0 &&
    o.items.every((i) => isStr(i?.questionId) && isStr(i?.themeId) && isStr(i?.concept) && Array.isArray(i?.order) && i.order.every(isStr)) &&
    Array.isArray(o.answers) && o.answers.every((a) => isStr(a?.questionId) && (a.optionId === null || isStr(a.optionId)) && typeof a.correct === 'boolean' && isNum(a.answeredAt)) &&
    isNum(o.index) && o.index >= 0 && o.index < o.items.length &&
    o.answers.length <= o.items.length && (o.qState === 'choosing' || o.qState === 'feedback') &&
    (o.selectedOptionId === null || isStr(o.selectedOptionId)) && isNum(o.step) &&
    // 回答済みの数と位置・状態が食い違う保存は壊れているとみなす
    o.answers.length === o.index + (o.qState === 'feedback' ? 1 : 0)
  );
}
function validResult(r: unknown): r is DiagResult {
  const o = r as Partial<DiagResult> | null;
  return (
    typeof o === 'object' && o !== null && isStr(o.runId) && isStr(o.qualificationId) && isNum(o.completedAt) && isStr(o.recommendedThemeId) &&
    Array.isArray(o.themes) && o.themes.length > 0 &&
    o.themes.every((t) => isStr(t?.themeId) && isStr(t?.title) && isNum(t?.correct) && isNum(t?.unknown) && isNum(t?.wrong) && isNum(t?.total) && (t.level === 'solid' || t.level === 'check') && Array.isArray(t.concepts))
  );
}
export function isValidDiagState(v: unknown): v is DiagState {
  const o = v as Partial<DiagState> | null;
  if (typeof o !== 'object' || o === null || o.version !== 1 || typeof o.quals !== 'object' || o.quals === null) return false;
  return Object.values(o.quals).every((q) => {
    const x = q as QualDiag | null;
    return typeof x === 'object' && x !== null && (x.active === undefined || validRun(x.active)) && (x.latest === undefined || validResult(x.latest)) && (x.dismissed === undefined || typeof x.dismissed === 'boolean');
  });
}

// ---- 出題の組み立て（決まった入力から決まった結果。乱数はrunIdの種だけ） ----
function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** テーマから概念が重ならないよう3問。足りなければ残りを順に */
export function pickConcepts(questions: Question[], n = DIAG_PER_THEME): Question[] {
  const picked: Question[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    if (picked.length >= n) break;
    if (!seen.has(q.concept)) {
      seen.add(q.concept);
      picked.push(q);
    }
  }
  for (const q of questions) {
    if (picked.length >= n) break;
    if (!picked.includes(q)) picked.push(q);
  }
  return picked;
}

export function buildItems(themes: ThemeContent[], runId: string): DiagItem[] {
  const rand = rng(seedFrom(runId));
  const perTheme = themes.map((t) =>
    pickConcepts(t.coreQuestions).map((q): DiagItem => {
      const order = q.options.map((o) => o.id);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      return { questionId: q.id, themeId: t.themeId, concept: q.concept, order };
    }),
  );
  // テーマを交互に並べ、同じテーマ・同じ概念が続かないようにする
  const items: DiagItem[] = [];
  for (let k = 0; k < DIAG_PER_THEME; k++) for (const list of perTheme) if (list[k]) items.push(list[k]!);
  return items;
}

export function summarize(run: DiagRun, titles: Record<string, string>, completedAt: number): DiagResult {
  const themes: DiagThemeResult[] = run.themeIds.map((themeId) => {
    const its = run.items.filter((i) => i.themeId === themeId);
    const ans = its.map((i) => run.answers.find((a) => a.questionId === i.questionId));
    const correct = ans.filter((a) => a?.correct).length;
    const unknown = ans.filter((a) => a && a.optionId === null).length;
    return {
      themeId,
      title: titles[themeId] ?? themeId,
      correct,
      unknown,
      wrong: ans.filter((a) => a && a.optionId !== null && !a.correct).length,
      total: its.length,
      level: correct >= 2 ? 'solid' : 'check',
      concepts: its.map((i, k) => ({ concept: i.concept, correct: ans[k]?.correct === true })),
    };
  });
  // 正解が最も少ないテーマ（同数なら先のテーマ）を、始める目安にする
  let rec = themes[0]!;
  for (const t of themes) if (t.correct < rec.correct) rec = t;
  return { runId: run.runId, qualificationId: run.qualificationId, completedAt, themes, recommendedThemeId: rec.themeId };
}

// ---- 画面向けビュー（回答前は正解・解説を含まない） ----
export type DiagView =
  | { kind: 'none' }
  | { kind: 'stale'; reason: string }
  | {
      kind: 'question';
      qualificationId: string;
      step: number;
      index: number;
      total: number;
      themeTitle: string;
      prompt: string;
      options: { id: string; text: string }[];
      selectedOptionId: string | null;
      qState: 'choosing' | 'feedback';
      questionRef: QuestionRef;
      feedback?: { correct: boolean; unknown: boolean; correctOptionId: string; explanation: string; whyWrong?: string; references?: ReferenceView };
    }
  | { kind: 'result'; result: DiagResult };

const err = (code: string, msg: string) => new CoreError(code, msg);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class DiagnosticEngine {
  private state: DiagState = emptyDiagState();
  private corrupt = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly d: { storage: DiagStorage; content: ContentProvider; rawContent?: ContentProvider; clock: Clock; newId: () => string };

  /** content: 新しく出題を作るとき（保留を除く）。rawContent: 進行中のチェックを表示・採点するとき（保留しても直ちにすり替えない） */
  constructor(deps: { storage: DiagStorage; content: ContentProvider; rawContent?: ContentProvider; clock: Clock; newId?: () => string }) {
    this.d = { newId: () => globalThis.crypto.randomUUID(), ...deps };
  }

  /** 保存を読む。壊れていても何も上書きしない（isCorrupt が true の間は保存系の操作を拒否） */
  async load(): Promise<{ corrupt: boolean }> {
    const r = await this.d.storage.load();
    if (r.kind === 'ok' && isValidDiagState(r.state)) {
      this.state = r.state;
      this.corrupt = false;
    } else if (r.kind === 'corrupt' || r.kind === 'ok') {
      this.state = emptyDiagState();
      this.corrupt = true;
    } else {
      this.state = emptyDiagState();
      this.corrupt = false;
    }
    return { corrupt: this.corrupt };
  }

  isCorrupt(): boolean {
    return this.corrupt;
  }
  getQual(qualificationId: string): Readonly<QualDiag> {
    return clone(this.state.quals[qualificationId] ?? {});
  }
  /** 全資格の最新結果（テーマの目印表示用） */
  latestResults(): Record<string, DiagResult> {
    const out: Record<string, DiagResult> = {};
    for (const [q, v] of Object.entries(this.state.quals)) if (v.latest) out[q] = clone(v.latest);
    return out;
  }

  private mutate<T>(fn: (draft: DiagState) => Promise<T> | T): Promise<T> {
    const p = this.queue.then(async () => {
      // 別の画面（タブ）が先に進めていても上書きしないよう、操作のたびに保存の最新を読み直す
      if (!this.corrupt) await this.load();
      if (this.corrupt) throw err(codes.corruptStorage, '初回チェックの保存データを読めないため、操作できません。データはそのまま残してあります。');
      const draft = clone(this.state);
      const result = await fn(draft);
      try {
        await this.d.storage.save(draft);
      } catch (e) {
        throw err(codes.storageWrite, `保存に失敗しました。もう一度試せます: ${(e as Error).message}`);
      }
      this.state = draft;
      return result;
    });
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async themesOf(run: { themeIds: string[]; qualificationId: string }, build = false): Promise<ThemeContent[]> {
    const out: ThemeContent[] = [];
    const provider = build ? this.d.content : (this.d.rawContent ?? this.d.content);
    for (const id of run.themeIds) {
      try {
        out.push(await provider.loadTheme(run.qualificationId, id));
      } catch (e) {
        throw err(codes.contentLoad, `教材を読み込めません: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** 入口を「あとで」にする（学習はそのまま始められる） */
  dismiss(qualificationId: string): Promise<void> {
    return this.mutate((d) => {
      (d.quals[qualificationId] ??= {}).dismissed = true;
    });
  }

  /** 開始。進行中があれば同じものを返し、二重に作らない。教材版が変わっていれば作り直す */
  start(qualificationId: string, themeIds: string[]): Promise<DiagView> {
    return this.mutate(async (d) => {
      const q = (d.quals[qualificationId] ??= {});
      const themes = await this.themesOf({ qualificationId, themeIds }, true);
      const versions = Object.fromEntries(themes.map((t) => [t.themeId, t.version]));
      if (q.active && sameVersions(q.active.versions, versions) && sameList(q.active.themeIds, themeIds)) {
        return this.viewOf(q.active, await this.themesOf(q.active), q); // 進行中は保留してもそのまま続ける
      }
      const blocked = themes.find((t) => t.blocked);
      if (blocked) throw err(codes.themeOnHold, blocked.blocked!);
      if (themes.some((t) => t.coreQuestions.length < 1)) throw err(codes.contentInvalid, '教材に問題がありません');
      const runId = this.d.newId();
      q.active = {
        runId, qualificationId, themeIds: themeIds.slice(), versions, startedAt: this.d.clock.now(),
        items: buildItems(themes, runId), answers: [], index: 0, qState: 'choosing', selectedOptionId: null, step: 0,
      };
      return this.viewOf(q.active, themes, q);
    });
  }

  /** 画面表示用。保存は変えない */
  async view(qualificationId: string): Promise<DiagView> {
    const q = this.state.quals[qualificationId];
    if (!q?.active) return q?.latest ? { kind: 'result', result: clone(q.latest) } : { kind: 'none' };
    const themes = await this.themesOf(q.active);
    return this.viewOf(clone(q.active), themes, q);
  }

  private viewOf(run: DiagRun, themes: ThemeContent[], q: QualDiag): DiagView {
    if (!sameVersions(run.versions, Object.fromEntries(themes.map((t) => [t.themeId, t.version])))) {
      return { kind: 'stale', reason: '教材が新しくなったため、途中のチェックは続けられません。最初からやり直せます。' };
    }
    void q;
    const item = run.items[run.index]!;
    const theme = themes.find((t) => t.themeId === item.themeId)!;
    const question = theme.coreQuestions.find((x) => x.id === item.questionId);
    if (!question) return { kind: 'stale', reason: '問題を読み込めませんでした。最初からやり直せます。' };
    const options = item.order.map((id) => question.options.find((o) => o.id === id)).filter((o): o is NonNullable<typeof o> => !!o);
    const view: DiagView = {
      kind: 'question', qualificationId: run.qualificationId, step: run.step, index: run.index + 1, total: run.items.length,
      themeTitle: theme.title, prompt: question.prompt, options: options.map((o) => ({ id: o.id, text: o.text })),
      selectedOptionId: run.selectedOptionId, qState: run.qState,
      // 「問題が気になる」の記録用。いま表示している問題そのもの（学習中の別ステージではない）を指す
      questionRef: { questionId: baseQuestionId(question.id), qualificationId: run.qualificationId, themeId: theme.themeId, contentVersion: run.versions[theme.themeId] ?? theme.version, prompt: question.prompt },
    };
    if (run.qState === 'feedback') {
      const a = run.answers[run.answers.length - 1]!;
      const chosen = question.options.find((o) => o.id === a.optionId);
      view.feedback = {
        correct: a.correct, unknown: a.optionId === null,
        correctOptionId: question.options.find((o) => o.isCorrect)!.id,
        explanation: question.explanation,
        ...(chosen && !chosen.isCorrect && chosen.whyWrong ? { whyWrong: chosen.whyWrong } : {}),
        references: describeReferences(question, run.versions[theme.themeId] ?? theme.version),
      };
    }
    return view;
  }

  private active(d: DiagState, qualificationId: string, step: number): DiagRun {
    const run = d.quals[qualificationId]?.active;
    if (!run) throw err(codes.notAllowed, '進行中の初回チェックがありません');
    if (run.step !== step) throw err(codes.staleStep, '古い画面からの操作です');
    return run;
  }

  /** 選ぶ（確定前）。正誤は出さない */
  select(qualificationId: string, step: number, optionId: string): Promise<DiagView> {
    return this.mutate(async (d) => {
      const run = this.active(d, qualificationId, step);
      if (run.qState !== 'choosing') throw err(codes.notAllowed, 'この問題は回答済みです');
      if (!run.items[run.index]!.order.includes(optionId)) throw err(codes.questionNotFound, `存在しない選択肢: ${optionId}`);
      run.selectedOptionId = optionId;
      run.step += 1;
      return this.viewOf(run, await this.themesOf(run), d.quals[qualificationId]!);
    });
  }

  private answer(qualificationId: string, step: number, unknown: boolean): Promise<DiagView> {
    return this.mutate(async (d) => {
      const run = this.active(d, qualificationId, step);
      if (run.qState !== 'choosing') throw err(codes.notAllowed, 'この問題は回答済みです');
      if (!unknown && run.selectedOptionId === null) throw err(codes.notAllowed, '選択肢を選んでから確定してください');
      const themes = await this.themesOf(run);
      const item = run.items[run.index]!;
      const question = themes.find((t) => t.themeId === item.themeId)!.coreQuestions.find((x) => x.id === item.questionId)!;
      const optionId = unknown ? null : run.selectedOptionId;
      run.answers.push({
        questionId: item.questionId, optionId,
        correct: optionId !== null && question.options.find((o) => o.id === optionId)?.isCorrect === true,
        answeredAt: this.d.clock.now(),
      });
      run.qState = 'feedback';
      run.step += 1;
      return this.viewOf(run, themes, d.quals[qualificationId]!);
    });
  }
  confirm(qualificationId: string, step: number): Promise<DiagView> {
    return this.answer(qualificationId, step, false);
  }
  dontKnow(qualificationId: string, step: number): Promise<DiagView> {
    return this.answer(qualificationId, step, true);
  }

  /** 次へ。最後なら結果を作り、進行中を消して最新結果にする（同じ保存で）。 */
  next(qualificationId: string, step: number): Promise<DiagView> {
    return this.mutate(async (d) => {
      const run = this.active(d, qualificationId, step);
      if (run.qState !== 'feedback') throw err(codes.notAllowed, '回答してから次へ進めます');
      const themes = await this.themesOf(run);
      const q = d.quals[qualificationId]!;
      if (run.index === run.items.length - 1) {
        const titles = Object.fromEntries(themes.map((t) => [t.themeId, t.title]));
        q.latest = summarize(run, titles, this.d.clock.now());
        delete q.active;
        return { kind: 'result', result: clone(q.latest) } as DiagView;
      }
      run.index += 1;
      run.qState = 'choosing';
      run.selectedOptionId = null;
      run.step += 1;
      return this.viewOf(run, themes, q);
    });
  }

  /** 進行中のチェックをやめる（最新の結果は残す） */
  abandon(qualificationId: string): Promise<void> {
    return this.mutate((d) => {
      const q = d.quals[qualificationId];
      if (q) delete q.active;
    });
  }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameVersions = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return sameList(ka, kb) && ka.every((k) => a[k] === b[k]);
};
