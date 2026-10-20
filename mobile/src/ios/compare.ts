// iOS候補の確認用ロジック（画面に依存しない純粋関数）。試験はここを直接検査する。
import { COMPARE_DELAY_MS, VARIANT_COUNT, parseCompare, type CompareSettings } from './namespace.ts';

export interface VariantDef {
  id: number;
  name: string;
  /** 他の案との違いの軸（色違いではなく、ナビゲーションと配置の違い） */
  axis: string;
}

/** Apple参照と候補.md の5方向（番号・名前・違いの軸） */
export const VARIANTS: readonly VariantDef[] = [
  { id: 1, name: '標準タブ', axis: '安定した4区画のナビゲーション' },
  { id: 2, name: '全景ルーム', axis: '部屋への没入と浮いた操作' },
  { id: 3, name: '学習カード', axis: '両価値を一つの起点へ置く情報構成' },
  { id: 4, name: '2つの主役', axis: '第一階層と補助機能を分ける' },
  { id: 5, name: 'スワイプ往復', axis: '指の連続操作で行き来' },
];

// ---- 入口 ----

export interface EntryInput {
  platform: string;
  /** 開発サーバー実行中か（__DEV__） */
  isDev: boolean;
  /** EXPO_PUBLIC_IOS_DESIGN の値。確認用ビルドだけ '1' */
  buildFlag: string | undefined;
  /** web の location.search（native では空） */
  search: string;
}

/**
 * 候補入口を開くか。通常起動は常に本体。
 * web: 明示の ?iosDesign=1 が必要で、開発サーバーか確認用ビルド(EXPO_PUBLIC_IOS_DESIGN=1)の時だけ。
 * native: 開発実行(__DEV__)かつ EXPO_PUBLIC_IOS_DESIGN=1 の時だけ。署名ビルド(__DEV__ でない)では常に本体。
 */
export function isIosDesignEnabled(i: EntryInput): boolean {
  if (i.platform === 'web') {
    if (!(i.isDev || i.buildFlag === '1')) return false;
    return new URLSearchParams(i.search).get('iosDesign') === '1';
  }
  return i.isDev && i.buildFlag === '1';
}

// ---- URL ----

export interface CompareOverrides {
  variant?: number;
  skeleton?: boolean;
  delayMs?: number;
}

export function parseCompareSearch(search: string): CompareOverrides {
  const q = new URLSearchParams(search);
  const out: CompareOverrides = {};
  const v = Number.parseInt(q.get('v') ?? '', 10);
  if (Number.isInteger(v) && v >= 1 && v <= VARIANT_COUNT) out.variant = v;
  const skel = q.get('skel');
  if (skel === '1') out.skeleton = true;
  else if (skel === '0') out.skeleton = false;
  const delay = q.get('delay');
  if (delay === '0') out.delayMs = 0;
  else if (delay === '1.2') out.delayMs = COMPARE_DELAY_MS;
  return out;
}

/** URL の明示指定を優先し、無い項目は保存値を使う */
export function mergeCompare(stored: CompareSettings, over: CompareOverrides): CompareSettings {
  return parseCompare({ ...stored, ...over });
}

/** 現在の URL を保ったまま、比較設定だけを書き込んだ search を返す（iosDesign=1 などは残す） */
export function buildCompareSearch(search: string, s: CompareSettings): string {
  const q = new URLSearchParams(search);
  q.set('iosDesign', '1');
  q.set('v', String(s.variant));
  q.set('skel', s.skeleton ? '1' : '0');
  q.set('delay', s.delayMs === 0 ? '0' : '1.2');
  return `?${q.toString()}`;
}

// ---- picker の操作（PICKER.md の Behavior contract） ----

export interface KeyInfo {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** イベント発生元。入力欄の中なら無視する */
  targetTag: string;
  targetEditable: boolean;
}

export type PickerAction = { type: 'set'; variant: number } | { type: 'replay' } | null;

export function pickerKeyAction(e: KeyInfo, current: number, count = VARIANT_COUNT): PickerAction {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.targetTag) || e.targetEditable) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const num = Number.parseInt(e.key, 10);
  if (e.key.length === 1 && num >= 1 && num <= count) return { type: 'set', variant: num };
  if (e.key === 'ArrowRight') return { type: 'set', variant: (current % count) + 1 };
  if (e.key === 'ArrowLeft') return { type: 'set', variant: ((current - 2 + count) % count) + 1 };
  if (e.key === 'r' || e.key === 'R') return { type: 'replay' };
  return null;
}

// ---- 比較用の最低表示（本番の画面には使わない） ----

/**
 * 読み込み表示を出し続けるか。実際の準備中は必ず表示。準備が終わっていても、開始から delayMs 未満なら表示を続ける（比較用）。
 * delayMs=0 なら実際の準備だけで決まる＝待ちを足さない。
 */
export function minShowVisible(startedAt: number | null, real: boolean, now: number, delayMs: number): boolean {
  if (real) return true;
  if (startedAt === null || delayMs <= 0) return false;
  return now - startedAt < delayMs;
}

/** あと何 ms で表示を終えてよいか（実際の準備が終わっている時のみ意味がある） */
export function minShowRemaining(startedAt: number | null, now: number, delayMs: number): number {
  if (startedAt === null || delayMs <= 0) return 0;
  return Math.max(0, delayMs - (now - startedAt));
}

// ---- 画面の分類（スケルトンの出し分け） ----

export type SkeletonKind = 'home' | 'learn' | 'notebook' | 'shop' | 'question' | 'result';
export const SKELETON_KINDS: readonly SkeletonKind[] = ['home', 'learn', 'notebook', 'shop', 'question', 'result'];

// ---- 読み込み表示の固定（比較入口だけ。撮影・見比べ用。製品の経路には無い） ----

export function parsePin(search: string): SkeletonKind | null {
  const v = new URLSearchParams(search).get('pin');
  return (SKELETON_KINDS as readonly string[]).includes(v ?? '') ? (v as SkeletonKind) : null;
}

/** URL の pin だけを差し替える（他の指定は残す）。null で pin を外す */
export function withPin(search: string, pin: SkeletonKind | null): string {
  const q = new URLSearchParams(search);
  if (pin) q.set('pin', pin);
  else q.delete('pin');
  const s = q.toString();
  return s ? `?${s}` : '';
}
