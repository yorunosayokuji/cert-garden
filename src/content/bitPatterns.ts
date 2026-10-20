// ITパスポート「ビット列の組合せ数」。question-samples.json の IT-03 の明示条件
// （各ビットは0か1）を基に数値違いを生成する。公式問題・書籍の転載ではない独自短問。
// 検算は数値問題のみ。意味問題・全試験範囲の検証には一般化しない。
import type { ContentProvider, Option, Question, ThemeContent, WeakSignal } from '../types.ts';
import { assertValidQuestion, patternsByMultiplication } from '../validate.ts';

export const BIT_THEME_VERSION = '2026-10-12.1';
const QUAL = 'it-passport';
const THEME = 'bit-patterns';

export const CORE_BITS = [4, 5, 6, 7, 8, 10];
const RECHECK_BITS_POOL = [3, 9, 11, 12];

type Form = 'count' | 'bits_for';

// 擬似乱数（シード付き。保存済みなので再現性は問題生成時のみ必要）
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

interface Candidate {
  value: number;
  misconception: string;
  why: string;
}

function placeOptions(
  correct: Candidate & { text: string },
  distractors: (Candidate & { text: string })[],
  seed: string,
  avoidPosition?: number,
): Option[] {
  const rand = rng(seedFrom(seed));
  const all = [correct, ...distractors];
  // 正解位置を決める（avoidPosition と同じ位置を避ける）
  let pos = Math.floor(rand() * all.length);
  if (avoidPosition !== undefined && pos === avoidPosition) pos = (pos + 1 + Math.floor(rand() * (all.length - 1))) % all.length;
  const rest = distractors.slice();
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j] as typeof rest[number], rest[i] as typeof rest[number]];
  }
  const ordered: (Candidate & { text: string })[] = [];
  let ri = 0;
  for (let i = 0; i < all.length; i++) ordered.push(i === pos ? correct : (rest[ri++] as Candidate & { text: string }));
  return ordered.map((c, i) => ({
    id: 'abcd'[i] as string,
    text: c.text,
    value: c.value,
    isCorrect: c === correct,
    ...(c === correct ? {} : { misconception: c.misconception, whyWrong: c.why }),
  }));
}

/** 重複する候補（例: 4ビットで 2n と 2^(n-1) が共に8）を除き、3つの誤選択肢を選ぶ */
function pickDistractors(correctValue: number, candidates: Candidate[], fmt: (v: number) => string) {
  const seen = new Set<number>([correctValue]);
  const out: (Candidate & { text: string })[] = [];
  for (const c of candidates) {
    if (c.value < 1 || seen.has(c.value)) continue;
    seen.add(c.value);
    out.push({ ...c, text: fmt(c.value) });
    if (out.length === 3) break;
  }
  if (out.length < 3) throw new Error('誤選択肢を3つ作れない');
  return out;
}

export function makeBitQuestion(
  form: Form,
  bits: number,
  id: string,
  seed: string,
  avoidPosition?: number,
  derivedFromQuestionId?: string,
): Question {
  const N = patternsByMultiplication(bits);
  if (form === 'count') {
    const distractors = pickDistractors(
      N,
      [
        { value: bits, misconception: 'count_as_bits', why: 'ビット数そのものと、組合せ数を区別します。' },
        { value: 2 * bits, misconception: 'multiply_not_power', why: `2×${bits}ではなく、2を${bits}回掛けます。` },
        { value: N / 2, misconception: 'off_by_one_bit', why: `${N / 2}通りは${bits - 1}ビットの場合です。` },
        { value: N * 2, misconception: 'one_extra_bit', why: `${N * 2}通りは${bits + 1}ビットの場合です。` },
      ],
      (v) => `${v}通り`,
    );
    const options = placeOptions({ value: N, misconception: '', why: '', text: `${N}通り` }, distractors, seed, avoidPosition);
    const q: Question = {
      id,
      concept: 'ビット列の組合せ数',
      prompt: `各ビットが0か1をとるとき、${bits}ビットで表せるビット列は何通り？`,
      options,
      explanation: `各位置に2通りあり、${bits}個分を掛けるので2の${bits}乗＝${N}通りです。`,
      hint: '各ビットは0か1の2通り。ビットの数だけ2を掛け合わせます（足し算や、ビット数の倍ではありません）。',
      sources: [],
      sourceNote: '0か1をとるという仮定を問題内に明示。一般の組合せ計算を掛け算の繰り返しで再計算。',
      validation: { type: 'bit_patterns', bits },
      ...(derivedFromQuestionId ? { derivedFromQuestionId } : {}),
    };
    assertValidQuestion(q);
    return q;
  }
  // 逆向き: N通りを区別するのに何ビット必要か
  const distractors = pickDistractors(
    bits,
    [
      { value: bits + 1, misconception: 'one_extra_bit', why: `${bits + 1}ビットなら${patternsByMultiplication(bits + 1)}通りまで表せます。必要最小のビット数を答えます。` },
      { value: bits - 1, misconception: 'off_by_one_bit', why: `${bits - 1}ビットでは${patternsByMultiplication(bits - 1)}通りまでしか表せません。` },
      { value: N, misconception: 'count_as_bits', why: `${N}は通り数です。ビット数を問われています。` },
      { value: 2 * bits, misconception: 'multiply_not_power', why: '2の累乗の指数を求める問いです。2倍ではありません。' },
    ],
    (v) => `${v}ビット`,
  );
  const options = placeOptions({ value: bits, misconception: '', why: '', text: `${bits}ビット` }, distractors, seed, avoidPosition);
  const q: Question = {
    id,
    concept: 'ビット列の組合せ数',
    prompt: `各ビットが0か1をとるとき、ちょうど${N}通りのビット列を区別して表すのに必要なビット数は？`,
    options,
    explanation: `2を${bits}回掛けると${N}になるので、${bits}ビットです（2の${bits}乗＝${N}）。`,
    hint: '2を何回掛けると、その通り数になるかを数えます。',
    sources: [],
    sourceNote: '0か1をとるという仮定を問題内に明示。2の累乗を掛け算の繰り返しで再計算。',
    validation: { type: 'bits_for_patterns', patterns: N },
    ...(derivedFromQuestionId ? { derivedFromQuestionId } : {}),
  };
  assertValidQuestion(q);
  return q;
}

function qid(suffix: string) {
  return `${QUAL}/${THEME}@${BIT_THEME_VERSION}:${suffix}`;
}

export function buildBitTheme(): ThemeContent {
  const coreQuestions = CORE_BITS.map((bits, i) =>
    makeBitQuestion('count', bits, qid(`core-${i + 1}`), `${BIT_THEME_VERSION}:core:${i}`),
  );
  return {
    qualificationId: QUAL,
    themeId: THEME,
    version: BIT_THEME_VERSION,
    title: 'ビット列の組合せ数',
    intro: '今日は「ビットの数から、表せる組合せの数を求める」を覚えます。',
    explanation: [
      '1ビットは0か1の2通りです。',
      '2ビットなら 00・01・10・11 の4通り。ビットが1つ増えるたびに、組合せの数は2倍になります。',
      'だから nビットで表せる数は、2を n回掛けた「2のn乗」通りです。',
    ],
    coreQuestions,
    buildRecheck({ seed, weak, coreQuestions: core }) {
      // 誤答・わからないがあった誤解を多い順に。無ければ「同形式の新しい数」と「逆向き」で確認する。
      const counts = new Map<string, WeakSignal[]>();
      for (const w of weak) counts.set(w.misconception, [...(counts.get(w.misconception) ?? []), w]);
      const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
      const usedBits = new Set(CORE_BITS);
      const pool = RECHECK_BITS_POOL.filter((b) => !usedBits.has(b));
      const rand = rng(seedFrom(seed));
      const pickBits = (i: number) => pool[(i + Math.floor(rand() * pool.length)) % pool.length] as number;
      const out: Question[] = [];
      const chosen: number[] = [];
      for (let i = 0; i < 2; i++) {
        const target = ranked[i]?.[1][0];
        // 誤解が1種類だけなら2問目は逆向きにして理解を別角度から確認する
        const form: Form = i === 1 ? 'bits_for' : target && target.misconception === 'one_extra_bit' ? 'bits_for' : 'count';
        let bits = pickBits(i);
        if (chosen.includes(bits)) bits = pool.find((b) => !chosen.includes(b)) as number;
        chosen.push(bits);
        const avoid = target?.correctPosition;
        out.push(
          makeBitQuestion(form, bits, qid(`recheck-${i + 1}`), `${seed}:recheck:${i}`, avoid, target?.questionId ?? core[0]?.id),
        );
      }
      return out;
    },
  };
}

export class BitPatternsContent implements ContentProvider {
  async loadTheme(qualificationId: string, themeId: string): Promise<ThemeContent> {
    if (qualificationId !== QUAL || themeId !== THEME) throw new Error(`教材が未作成: ${qualificationId}/${themeId}`);
    return buildBitTheme();
  }
}
