// 問題の「気になる」記録と、自分の学習からの保留。すべてこの端末だけに保存し、誰にも送らない。
// 人が確認・修正することは約束しない。保留した問題は次に作るステージ・診断・おさらいから外れる（進行中のステージは変えない）。
import { codes, CoreError } from './errors.ts';
import type { Clock, ContentProvider, Question, ThemeContent } from './types.ts';

export const REPORT_REASONS = ['answer', 'explanation', 'wording', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REASON_LABEL: Record<ReportReason, string> = { answer: '正解が気になる', explanation: '説明が気になる', wording: '表現が気になる', other: 'その他' };

/** 再確認で付く「#recheck」を除いた元の問題ID（選択肢を入れ替えても元IDは変わらない） */
export const baseQuestionId = (id: string) => id.replace(/#recheck$/, '');

export interface QuestionRef {
  questionId: string;
  qualificationId: string;
  themeId: string;
  /** 記録したときの教材版。版が変わると保留は自動では効かない（一覧には残り、解除できる） */
  contentVersion: string;
  /** 一覧で分かるよう、問題文の先頭だけ控える */
  prompt: string;
}
export interface Hold extends QuestionRef {
  at: number;
}
export interface Report extends QuestionRef {
  id: string;
  reason: ReportReason;
  memo: string;
  at: number;
  /** 同時に保留した */
  held: boolean;
}
export interface HoldState {
  version: 1;
  holds: Record<string, Hold>;
  reports: Report[];
}
export const emptyHoldState = (): HoldState => ({ version: 1, holds: {}, reports: [] });

export type HoldLoad = { kind: 'empty' } | { kind: 'ok'; state: HoldState } | { kind: 'corrupt' };
export interface HoldStorage {
  load(): Promise<HoldLoad>;
  save(state: HoldState): Promise<void>;
}
export class MemoryHoldStorage implements HoldStorage {
  state: HoldState | null = null;
  failNextSaves = 0;
  async load(): Promise<HoldLoad> {
    return this.state ? { kind: 'ok', state: JSON.parse(JSON.stringify(this.state)) as HoldState } : { kind: 'empty' };
  }
  async save(state: HoldState) {
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error('disk full (injected)');
    }
    this.state = JSON.parse(JSON.stringify(state)) as HoldState;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const validRef = (r: unknown): r is QuestionRef => {
  const o = r as Partial<QuestionRef> | null;
  return typeof o === 'object' && o !== null && isStr(o.questionId) && isStr(o.qualificationId) && isStr(o.themeId) && isStr(o.contentVersion) && isStr(o.prompt);
};
export function isValidHoldState(v: unknown): v is HoldState {
  const o = v as Partial<HoldState> | null;
  if (typeof o !== 'object' || o === null || o.version !== 1 || typeof o.holds !== 'object' || o.holds === null || !Array.isArray(o.reports)) return false;
  return (
    Object.entries(o.holds).every(([k, h]) => validRef(h) && k === (h as Hold).questionId && Number.isFinite((h as Hold).at)) &&
    o.reports.every((r) => validRef(r) && isStr((r as Report).id) && (REPORT_REASONS as readonly string[]).includes((r as Report).reason) && isStr((r as Report).memo) && Number.isFinite((r as Report).at) && typeof (r as Report).held === 'boolean')
  );
}

/** 最低限これだけ残らないと出題できない（中心の問題＋再確認2問に足りない） */
export const MIN_QUESTIONS = 3;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const err = (code: string, msg: string) => new CoreError(code, msg);

export class QuestionHolds {
  private state: HoldState = emptyHoldState();
  private corrupt = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly d: { storage: HoldStorage; clock: Clock; newId: () => string };

  constructor(deps: { storage: HoldStorage; clock: Clock; newId?: () => string }) {
    this.d = { newId: () => globalThis.crypto.randomUUID(), ...deps };
  }

  /** 保存を読む。壊れていても何も上書きしない（isCorrupt の間は記録・保留・解除を拒否し、保留は効かない） */
  async load(): Promise<{ corrupt: boolean }> {
    const r = await this.d.storage.load();
    if (r.kind === 'ok' && isValidHoldState(r.state)) {
      this.state = r.state;
      this.corrupt = false;
    } else if (r.kind === 'empty') {
      this.state = emptyHoldState();
      this.corrupt = false;
    } else {
      this.state = emptyHoldState();
      this.corrupt = true;
    }
    return { corrupt: this.corrupt };
  }
  isCorrupt() {
    return this.corrupt;
  }
  list(): Hold[] {
    return Object.values(this.state.holds).sort((a, b) => b.at - a.at).map((h) => clone(h));
  }
  reports(): Report[] {
    return this.state.reports.map((r) => clone(r));
  }
  isHeld(questionId: string): boolean {
    return baseQuestionId(questionId) in this.state.holds;
  }
  /** いま効いている保留の元ID（同じ教材版のものだけ） */
  active(qualificationId: string, themeId: string, contentVersion: string): Set<string> {
    return new Set(
      Object.values(this.state.holds)
        .filter((h) => h.qualificationId === qualificationId && h.themeId === themeId && h.contentVersion === contentVersion)
        .map((h) => h.questionId),
    );
  }

  private mutate<T>(fn: (d: HoldState) => T): Promise<T> {
    const p = this.queue.then(async () => {
      if (!this.corrupt) await this.load(); // 別の画面が先に書いていても上書きしない
      if (this.corrupt) throw err(codes.corruptStorage, '問題の記録の保存データを読めないため、操作できません。データはそのまま残してあります。');
      const draft = clone(this.state);
      const result = fn(draft);
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

  private ref(q: Pick<QuestionRef, 'questionId' | 'qualificationId' | 'themeId' | 'contentVersion' | 'prompt'>): QuestionRef {
    return { questionId: baseQuestionId(q.questionId), qualificationId: q.qualificationId, themeId: q.themeId, contentVersion: q.contentVersion, prompt: q.prompt.slice(0, 60) };
  }

  /** 保留する（二重に押しても1件）。以後の新しいステージ・診断・おさらいから外れる */
  hold(q: QuestionRef): Promise<Hold> {
    return this.mutate((d) => {
      const r = this.ref(q);
      return (d.holds[r.questionId] ??= { ...r, at: this.d.clock.now() });
    });
  }
  /** 解除（持っていなくても失敗しない） */
  release(questionId: string): Promise<void> {
    return this.mutate((d) => {
      delete d.holds[baseQuestionId(questionId)];
    });
  }
  /** この端末だけに記録する。同じ問題・版・理由・メモの二重記録は1件。hold:true なら同じ保存で保留も */
  report(q: QuestionRef, reason: ReportReason, memo: string, hold: boolean): Promise<Report> {
    if (!(REPORT_REASONS as readonly string[]).includes(reason)) return Promise.reject(err(codes.notAllowed, '理由が不正です'));
    const note = memo.normalize('NFKC').trim().slice(0, 200);
    return this.mutate((d) => {
      const r = this.ref(q);
      let rep = d.reports.find((x) => x.questionId === r.questionId && x.contentVersion === r.contentVersion && x.reason === reason && x.memo === note);
      if (!rep) {
        rep = { ...r, id: this.d.newId(), reason, memo: note, at: this.d.clock.now(), held: hold };
        d.reports.push(rep);
      } else if (hold && !rep.held) rep.held = true;
      if (hold) d.holds[r.questionId] ??= { ...r, at: this.d.clock.now() };
      return clone(rep);
    });
  }
}

/** 保留を尊重する教材。新しく作るステージ・診断・おさらいの問題から保留中を外す。残りが足りなければ blocked に理由を入れる */
export class HoldFilteredContent implements ContentProvider {
  private readonly inner: ContentProvider;
  private readonly holds: QuestionHolds;
  constructor(inner: ContentProvider, holds: QuestionHolds) {
    this.inner = inner;
    this.holds = holds;
  }
  async loadTheme(qualificationId: string, themeId: string): Promise<ThemeContent> {
    const c = await this.inner.loadTheme(qualificationId, themeId);
    const held = this.holds.active(qualificationId, themeId, c.version);
    if (held.size === 0) return c;
    const kept = c.coreQuestions.filter((x) => !held.has(baseQuestionId(x.id)));
    const live = (qs: Question[]) => {
      const now = this.holds.active(qualificationId, themeId, c.version);
      const rest = qs.filter((x) => !now.has(baseQuestionId(x.id)));
      return rest.length >= 2 ? rest : qs; // 進行中に足りなくなったときだけ、止めずに元の問題から選ぶ
    };
    if (kept.length < MIN_QUESTIONS) {
      return {
        ...c,
        blocked: `保留中の問題が多く、このテーマは新しく始められません（出せる問題 ${kept.length}問、必要 ${MIN_QUESTIONS}問）。保留の一覧から解除できます。`,
        buildRecheck: (ctx) => c.buildRecheck({ ...ctx, coreQuestions: live(ctx.coreQuestions) }),
      };
    }
    return { ...c, coreQuestions: kept, buildRecheck: (ctx) => c.buildRecheck({ ...ctx, coreQuestions: live(ctx.coreQuestions) }) };
  }
}
