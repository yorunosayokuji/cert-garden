// 複数資格の教材原稿（learning-pack.json）を読む ContentProvider。
// 原稿は「基礎コース」であり、試験範囲の全体ではない。人の専門監修は無く、意味問題の独立確認は未了。
// このファイルは状態（監修済み/最新版など）を作らない。原稿の coverage / publicationStatus / humanSubjectReview をそのまま渡す。
import type { ContentProvider, Option, Question, Source, ThemeContent, WeakSignal } from '../types.ts';
import { validateQuestion } from '../validate.ts';
import { BitPatternsContent } from './bitPatterns.ts';
import { sameNumber, shortAnswerOf } from '../numberInput.ts';

export interface PackQuestion {
  id: string;
  concept: string;
  prompt: string;
  options: Option[];
  explanation: string;
  hint: string;
  sources: Source[];
  sourceNote?: string;
  verification?: Record<string, unknown>;
  shortAnswer?: Record<string, unknown>;
}

export interface PackTheme {
  qualificationId: string;
  themeId: string;
  domainId?: string;
  version: string;
  title: string;
  intro: string;
  explanation: string[];
  coreQuestions: PackQuestion[];
  coverage?: string;
  estimatedMinutes?: number;
  publicationStatus?: string;
  humanSubjectReview?: boolean;
}

export interface LearningPack {
  version: number;
  status?: string;
  coverage?: string;
  humanSubjectReview?: boolean;
  sourcePolicy?: string;
  themes: PackTheme[];
}

/** 一覧表示用。正解・解説・出典は含めない */
export interface ThemeSummary {
  qualificationId: string;
  themeId: string;
  title: string;
  estimatedMinutes: number;
  coverage: string;
  publicationStatus: string;
  humanSubjectReview: boolean;
  questionCount: number;
  /** 数字を入力して答えられる問題の数（検算できる数値の問題のみ。0なら4択だけ） */
  numericCount: number;
}

export function listPackThemes(pack: LearningPack): ThemeSummary[] {
  return pack.themes.map((t) => ({
    qualificationId: t.qualificationId,
    themeId: t.themeId,
    title: t.title,
    estimatedMinutes: t.estimatedMinutes ?? 5,
    coverage: t.coverage ?? pack.coverage ?? 'foundation_only',
    publicationStatus: t.publicationStatus ?? pack.status ?? 'local_draft',
    humanSubjectReview: t.humanSubjectReview === true,
    questionCount: t.coreQuestions.length,
    numericCount: t.coreQuestions.filter((q) => shortAnswerOf(q)).length,
  }));
}

const OPS: Record<string, (a: number[]) => number> = {
  'a+b': (a) => a[0]! + a[1]!,
  'a-b': (a) => a[0]! - a[1]!,
  'a*b': (a) => a[0]! * a[1]!,
  'a/b': (a) => a[0]! / a[1]!,
  'a*b/c': (a) => (a[0]! * a[1]!) / a[2]!,
  percent: (a) => (a[0]! / a[1]!) * 100,
  mean: (a) => a.reduce((s, n) => s + n, 0) / a.length,
  median: (a) => {
    const b = a.slice().sort((x, y) => x - y);
    return b.length % 2 ? b[(b.length - 1) / 2]! : (b[b.length / 2 - 1]! + b[b.length / 2]!) / 2;
  },
};

/** explicit_arithmetic の式を再計算して expected と一致するか。式の演算だけの確認で、意味の正しさの証明ではない */
export function arithmeticProblem(q: PackQuestion): string | null {
  const v = q.verification;
  if (!v || v.type !== 'explicit_arithmetic') return null;
  const op = OPS[String(v.op)];
  if (!op || !Array.isArray(v.inputs) || typeof v.expected !== 'number') return `${q.id}: 検算の指定が不正`;
  const expected: number = v.expected;
  const got = op(v.inputs as number[]);
  if (!(Math.abs(got - expected) < 1e-9)) return `${q.id}: 検算値${got}が原稿の${expected}と違う`;
  // 式だけでなく解答キーも照合する: 正解に指定した選択肢の value が expected と一致し、誤選択肢に同じ値がなく、shortAnswer も同じ値・同じ単位
  const correct = q.options.filter((o) => o.isCorrect);
  if (correct.length !== 1 || typeof correct[0]!.value !== 'number') return `${q.id}: 正解の選択肢に数値(value)がありません`;
  if (Math.abs(correct[0]!.value - expected) >= 1e-9) return `${q.id}: 正解の選択肢の値${correct[0]!.value}が検算値${expected}と違う`;
  if (q.options.some((o) => !o.isCorrect && typeof o.value === 'number' && Math.abs(o.value - expected) < 1e-9)) return `${q.id}: 誤選択肢に正解と同じ値がある`;
  if (q.shortAnswer !== undefined) {
    const sa = shortAnswerOf(q);
    if (!sa) return `${q.id}: shortAnswer の形が不正`;
    if (sa.accepted.length !== 1 || !sameNumber(sa.accepted[0]!, expected)) return `${q.id}: shortAnswer の値が検算値と違う`;
    if (typeof v.unit === 'string' && sa.unit !== v.unit) return `${q.id}: shortAnswer の単位が検算の単位と違う`;
  }
  return null;
}

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

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 元IDを残したまま選択肢の順だけ入れ替える。元の正解位置と同じにならないよう最大数回やり直す */
function reshuffled(q: Question, rand: () => number): Question {
  const was = q.options.findIndex((o) => o.isCorrect);
  let opts = q.options.slice();
  for (let tries = 0; tries < 6; tries++) {
    opts = q.options.slice();
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [opts[i], opts[j]] = [opts[j]!, opts[i]!];
    }
    if (opts.findIndex((o) => o.isCorrect) !== was || q.options.length < 2) break;
  }
  return { ...clone(q), id: `${q.id}#recheck`, options: clone(opts), derivedFromQuestionId: q.id };
}

/** 再確認2問: 間違えた概念を優先し、同じ概念の別の問題があればそれを使う。直前に答えた問題の連続は避ける */
export function pickRecheck(ctx: { seed: string; weak: WeakSignal[]; coreQuestions: Question[] }, count = 2): Question[] {
  const rand = rng(seedFrom(ctx.seed));
  const pool = ctx.coreQuestions;
  const picked: Question[] = [];
  const used = new Set<string>();
  const take = (q: Question | undefined) => {
    if (!q || used.has(q.id) || picked.length >= count) return;
    used.add(q.id);
    picked.push(q);
  };
  for (const w of ctx.weak) {
    const base = pool.find((q) => q.id === w.questionId);
    if (!base) continue;
    const other = pool.filter((q) => q.concept === base.concept && q.id !== base.id && !used.has(q.id));
    take(other[0] ?? base);
  }
  const rest = pool.filter((q) => !used.has(q.id));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  // 残りは、すでに選んだ概念と違う概念を先に
  rest.sort((a, b) => Number(picked.some((p) => p.concept === a.concept)) - Number(picked.some((p) => p.concept === b.concept)));
  for (const q of rest) take(q);
  const last = pool[pool.length - 1];
  if (picked.length > 1 && last && picked[0]!.id === last.id) [picked[0], picked[1]] = [picked[1]!, picked[0]!];
  return picked.map((q) => reshuffled(q, rand));
}

export class PackContent implements ContentProvider {
  private readonly themes = new Map<string, PackTheme>();

  /** 原稿の構造を検査して読み込む。壊れた原稿は黙って通さず例外にする */
  constructor(pack: LearningPack) {
    if (!pack || !Array.isArray(pack.themes) || pack.themes.length === 0) throw new Error('教材原稿にテーマがありません');
    const ids = new Set<string>();
    for (const t of pack.themes) {
      const key = `${t.qualificationId}/${t.themeId}`;
      if (this.themes.has(key)) throw new Error(`テーマの重複: ${key}`);
      if (!t.version || !t.title || t.coreQuestions.length < 3) throw new Error(`テーマが不完全: ${key}`);
      for (const q of t.coreQuestions) {
        const p = validateQuestion(q as Question);
        if (p.length) throw new Error(`問題${q.id}: ${p.join(' / ')}`);
        if (ids.has(q.id)) throw new Error(`問題IDの重複: ${q.id}`);
        ids.add(q.id);
        if (!q.sources || q.sources.length === 0) throw new Error(`問題${q.id}: 出典がありません`);
        const a = arithmeticProblem(q);
        if (a) throw new Error(a);
      }
      this.themes.set(key, t);
    }
  }

  has(qualificationId: string, themeId: string): boolean {
    return this.themes.has(`${qualificationId}/${themeId}`);
  }

  async loadTheme(qualificationId: string, themeId: string): Promise<ThemeContent> {
    const t = this.themes.get(`${qualificationId}/${themeId}`);
    if (!t) throw new Error(`教材が未作成: ${qualificationId}/${themeId}`);
    const core = clone(t.coreQuestions) as Question[];
    return {
      qualificationId,
      themeId,
      version: t.version,
      title: t.title,
      intro: t.intro,
      explanation: clone(t.explanation),
      coreQuestions: core,
      buildRecheck: (ctx) => pickRecheck(ctx),
    };
  }
}

/** 既存のビット列教材を保持したまま、原稿の複数テーマも読む */
export class CompositeContent implements ContentProvider {
  private readonly bits = new BitPatternsContent();
  private readonly pack: PackContent;
  constructor(pack: PackContent) {
    this.pack = pack;
  }
  loadTheme(qualificationId: string, themeId: string): Promise<ThemeContent> {
    if (qualificationId === 'it-passport' && themeId === 'bit-patterns') return this.bits.loadTheme(qualificationId, themeId);
    return this.pack.loadTheme(qualificationId, themeId);
  }
}
