// 起動の入口の判定（純粋関数）。どの画面を開くかは、ここと release-selection.json だけで決まる。
// 画面の選択を環境変数・URL・保存から上書きすることはできない（承認は release-selection.json を人が書き換えた時だけ）。

export interface EntryInput {
  platform: string;
  /** 開発サーバー実行中か（__DEV__） */
  isDev: boolean;
  /** EXPO_PUBLIC_IOS_DESIGN の値。比較用の開発ビルドだけ '1' */
  buildFlag: string | undefined;
  /** web の location.search（native では空） */
  search: string;
}

/**
 * 比較入口（5案を見比べる道具）を開くか。
 * web: 明示の ?iosDesign=1 が必要で、開発サーバーか比較用ビルド(EXPO_PUBLIC_IOS_DESIGN=1)の時だけ。
 * native: 開発実行(__DEV__)かつ EXPO_PUBLIC_IOS_DESIGN=1 の時だけ。署名ビルド(__DEV__ でない)では開かない。
 */
export function isIosDesignEnabled(i: EntryInput): boolean {
  if (i.platform === 'web') {
    if (!(i.isDev || i.buildFlag === '1')) return false;
    return new URLSearchParams(i.search).get('iosDesign') === '1';
  }
  return i.isDev && i.buildFlag === '1';
}

export const VARIANT_MIN = 1;
export const VARIANT_MAX = 5;

export interface Selection {
  /** 本人が選んだ画面の案(1〜5)。未選択は null。ここが null のうちは、署名版は起動しない */
  approvedVariant: number | null;
}

/** release-selection.json の中身を検査する。形が違えば null（＝未選択扱い。勝手に1〜5のどれかにしない） */
export function parseSelection(raw: unknown): Selection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = (raw as { approvedVariant?: unknown }).approvedVariant;
  if (v === null) return { approvedVariant: null };
  if (typeof v === 'number' && Number.isInteger(v) && v >= VARIANT_MIN && v <= VARIANT_MAX) return { approvedVariant: v };
  return null;
}

export type Entry =
  | { kind: 'legacy' }
  | { kind: 'compare' }
  | { kind: 'product'; variant: number; space: 'device' | 'preview' }
  | { kind: 'refuse'; reason: 'noSelection' | 'badSelection' };

export interface EntryContext extends EntryInput {
  /** release-selection.json の値（形の検査前） */
  selection: unknown;
}

/** 製品の読み込みの設定。スケルトン ON、人工の待ち 0（本物の ready/error/retry だけで進む）。比較の設定や保存からは変えられない */
export function productConfig(variant: number): { variant: number; skeleton: true; delayMs: 0 } {
  return { variant, skeleton: true, delayMs: 0 };
}

/** ?iosProductPreview=N（Web の開発サーバーだけ）。1〜5 以外は無視 */
export function parseProductPreview(search: string): number | null {
  const v = new URLSearchParams(search).get('iosProductPreview');
  if (v === null || !/^[1-5]$/.test(v)) return null;
  return Number(v);
}

/**
 * どの入口を開くか。
 *  - web: 通常は旧画面。?iosDesign=1 で比較（開発サーバーか比較用ビルド）、?iosProductPreview=N で製品の検品（開発サーバーだけ）
 *  - iOS: 比較用の開発ビルドなら比較、それ以外は常に製品。承認済みの案があればその案、無ければ起動を拒否（旧画面へは戻らない）
 *  - それ以外の端末（Android など）: 旧画面（この製品の対象外）
 */
export function decideEntry(i: EntryContext): Entry {
  if (i.platform === 'web') {
    if (isIosDesignEnabled(i)) return { kind: 'compare' };
    const preview = i.isDev ? parseProductPreview(i.search) : null;
    if (preview !== null) return { kind: 'product', variant: preview, space: 'preview' };
    return { kind: 'legacy' };
  }
  if (i.platform !== 'ios') return { kind: 'legacy' };
  if (isIosDesignEnabled(i)) return { kind: 'compare' };
  const sel = parseSelection(i.selection);
  if (!sel) return { kind: 'refuse', reason: 'badSelection' };
  if (sel.approvedVariant === null) return { kind: 'refuse', reason: 'noSelection' };
  return { kind: 'product', variant: sel.approvedVariant, space: 'device' };
}
