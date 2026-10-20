// 数字を入力して答える問題の解析。検算できる数値だけが対象で、自由記述の採点は行わない。
// 形式が不正な入力・違う単位は「入力エラー」であり、正誤判定も学習記録も進めない。
import type { Question } from './types.ts';

export type ParsedNumber = { ok: true; value: number; display: string } | { ok: false; reason: string };

const MINUS = /[−‒–—ー－]/g; // −‒–—ー－ を半角の - に

/**
 * NFKC・前後空白・全角数字・Unicodeの負号を扱う。許すのは「[符号]整数または小数、正しい3桁区切り、(同じ明示単位)」だけ。
 * NaN / Infinity / 指数 / 16進 / 分数 / 数字の途中の空白 / 不正な桁区切り / 別の単位 / 先頭の0の並びは入力エラー。
 */
export function parseNumberInput(raw: string, unit = ''): ParsedNumber {
  let t = raw.normalize('NFKC').replace(MINUS, '-').trim();
  if (t === '') return { ok: false, reason: '数字を入力してください。' };
  if (unit !== '' && t.endsWith(unit)) t = t.slice(0, t.length - unit.length).trimEnd();
  else if (unit === '' && /[^\d\s,.+-]/.test(t)) return { ok: false, reason: '数字だけを入力してください。' };
  if (t === '') return { ok: false, reason: '数字を入力してください。' };
  if (/\s/.test(t)) return { ok: false, reason: '数字の途中に空白は入れられません。' };
  const m = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(t);
  if (!m) return { ok: false, reason: unit ? `数字だけ（単位は「${unit}」のみ）を入力してください。例: 1,000 や 37.5` : '数字だけを入力してください。例: 1,000 や 37.5' };
  const int = m[2]!.replace(/,/g, '');
  if (int.length > 1 && int.startsWith('0')) return { ok: false, reason: '先頭に0を並べずに入力してください。' };
  const value = Number(`${m[1] === '-' ? '-' : ''}${int}${m[3] ?? ''}`);
  if (!Number.isFinite(value) || Math.abs(value) > 1e12) return { ok: false, reason: '大きすぎる数です。' };
  return { ok: true, value, display: `${value}` };
}

export interface ShortAnswer {
  /** 解答キー（数値）。原稿の accepted を同じ解析で読んだもの */
  accepted: number[];
  /** 画面に出す正解の表記（単位つき）。確認後にだけ使う */
  acceptedText: string;
  unit: string;
}

/** 数値の shortAnswer だけを読む。形が違えば null（4択として扱う）。自由記述は対象外 */
export function shortAnswerOf(q: Pick<Question, 'shortAnswer'>): ShortAnswer | null {
  const s = q.shortAnswer;
  if (!s || !Array.isArray(s.accepted) || s.accepted.length === 0 || typeof s.unit !== 'string') return null;
  const nums: number[] = [];
  for (const a of s.accepted) {
    if (typeof a !== 'string') return null;
    const p = parseNumberInput(a, '');
    if (!p.ok) return null;
    nums.push(p.value);
  }
  return { accepted: nums, acceptedText: `${s.accepted[0] as string}${s.unit}`, unit: s.unit };
}

export const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
