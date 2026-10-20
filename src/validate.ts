import type { Question, ReferenceView, Source, SourceView } from './types.ts';

const ROLE_LABEL: Record<string, string> = {
  syllabus: '出題範囲の確認元',
  qualification_scope: '資格の範囲の確認元',
  concept_reference: '考え方の参考（概念の根拠）',
};

/** https の URL だけを返す（それ以外は押せない表示にする）。取得や送信はしない */
export function safeHttpsUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 資料名。title が無ければホスト名などの平易な表示 */
function sourceTitle(s: Source): string {
  if (s.title && s.title.trim()) return s.title.trim();
  try {
    return new URL(s.url).hostname.replace(/^www\d*\./, '');
  } catch {
    return '参考資料';
  }
}

/** 出典を画面向けの日本語にする。内部の状態文字列は出さず、確認の範囲を言い換える（正解の検証済みとは言わない） */
export function describeSource(s: Source): SourceView {
  const role = s.role ?? '';
  const parts: string[] = [];
  parts.push(role === 'concept_reference'
    ? '考え方の根拠として参照した資料です。この問題と正解の組を専門家が確認したものではありません。'
    : '出題範囲や資格の範囲を確かめるための資料です。この問題の正解を確かめたものではありません。');
  const st = s.status ?? '';
  if (/search|direct|invalid|unavailable|fail/i.test(st)) parts.push('直接開いて確認できず、検索結果などで部分的に確認しました。');
  if (/version not confirmed|not 3級|not current|stable concept|not .*proof/i.test(st) || /not current|not 3級|stable concept/i.test(s.section ?? '')) parts.push('版や最新の運用要件までは確認していません。');
  return {
    title: sourceTitle(s),
    url: safeHttpsUrl(s.url),
    // 「該当箇所」は区切り(;)の前の位置情報だけ。後ろの作業用の英語の注記は出さない（意味は scopeNote に日本語で反映）
    section: s.section && s.section.split(';')[0]!.trim() ? s.section.split(';')[0]!.trim() : null,
    checked: s.checked,
    roleLabel: ROLE_LABEL[role] ?? '参考資料',
    scopeNote: parts.join(''),
  };
}

/** 確定後のフィードバックに載せる参考情報（確定前には使わない） */
export function describeReferences(q: Pick<Question, 'sources' | 'sourceNote' | 'verification'>, contentVersion: string): ReferenceView {
  const vtype = typeof q.verification?.type === 'string' ? q.verification.type : '';
  return {
    sources: (q.sources ?? []).map(describeSource),
    note: q.sourceNote ?? null,
    checkNote: vtype === 'explicit_arithmetic'
      ? '数値は式で検算しています。意味の確認は作者によるもので、専門家の監修ではありません。'
      : '作者が問題・正解・説明を読み直しています。専門家の監修ではありません。',
    contentVersion,
  };
}

/** 実装の公式（2**n）とは別に、掛け算の繰り返しで検算する */
export function patternsByMultiplication(bits: number): number {
  let n = 1;
  for (let i = 0; i < bits; i++) n *= 2;
  return n;
}

/** N通りを区別するのに必要な最小ビット数（Nが2の累乗でなければ null） */
export function bitsForPatterns(patterns: number): number | null {
  let bits = 0;
  let n = 1;
  while (n < patterns) {
    n *= 2;
    bits++;
  }
  return n === patterns ? bits : null;
}

/** 問題の構造検査と、数値問題の機械検算。問題がある場合は理由の配列を返す（空なら合格）。
 * 注意: 意味問題の正しさや試験範囲の妥当性はここでは検証しない。 */
export function validateQuestion(q: Question): string[] {
  const problems: string[] = [];
  if (!q.id) problems.push('問題IDが空');
  if (!q.prompt.trim()) problems.push('問題文が空');
  if (q.options.length < 2) problems.push('選択肢が2つ未満');

  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const o of q.options) {
    if (!o.id) problems.push('選択肢IDが空');
    if (ids.has(o.id)) problems.push(`選択肢IDの重複: ${o.id}`);
    ids.add(o.id);
    const t = o.text.trim();
    if (!t) problems.push(`選択肢${o.id}の文が空`);
    if (texts.has(t)) problems.push(`選択肢の文の重複: ${t}`);
    texts.add(t);
  }

  const correct = q.options.filter((o) => o.isCorrect);
  if (correct.length === 0) problems.push('正解が無い');
  if (correct.length > 1) problems.push('正解が複数ある');

  const values = q.options.filter((o) => o.value !== undefined).map((o) => o.value as number);
  if (new Set(values).size !== values.length) problems.push('選択肢の数値が重複している（誤選択肢が正解と重なる可能性）');

  const v = q.validation;
  if (v) {
    let expected: number | null = null;
    if (v.type === 'bit_patterns') expected = patternsByMultiplication(v.bits);
    if (v.type === 'bits_for_patterns') expected = bitsForPatterns(v.patterns);
    if (expected === null) {
      problems.push('検算条件が不正（2の累乗でない等）');
    } else {
      const matches = q.options.filter((o) => o.value === expected);
      if (matches.length !== 1) problems.push(`検算値${expected}と一致する選択肢が${matches.length}個`);
      else if (!matches[0]?.isCorrect) problems.push(`検算値${expected}の選択肢が正解に設定されていない`);
    }
  }
  return problems;
}

export function assertValidQuestion(q: Question): void {
  const p = validateQuestion(q);
  if (p.length > 0) throw new Error(`問題${q.id}が不正: ${p.join(' / ')}`);
}
