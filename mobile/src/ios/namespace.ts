// iOS候補の確認用保存。既存の certgarden:* キーには一切触れず、別の接頭辞の下だけに読み書きする。
// 既存の各 Store は KeyValue を受け取るだけなので、ここで包んだ KeyValue を渡せば本体の保存から隔離できる。
import type { KeyValue } from '../state/kv.ts';
import { IOS_DESIGN_PREFIX, PrefixedKv } from './storage.ts';

// 接頭辞つきの保存は製品の経路からも使うので storage.ts にある（ここは比較専用の道具だけ）
export { IOS_DESIGN_PREFIX, PrefixedKv };
export const COMPARE_KEY = 'compare:v1';

/**
 * 比較用の読込失敗。arm したキーの「次の1回の読み取り」だけ失敗させる（本物の失敗経路＝コアの読込エラー→再試行を確認するため）。
 * 書き込みや他のキーは変えない。失敗したら自動で解除し、再試行は成功する。
 */
export class FaultKv implements KeyValue {
  readonly inner: KeyValue;
  private readonly armed = new Set<string>();
  constructor(inner: KeyValue) {
    this.inner = inner;
  }
  armReadFailure(key: string) {
    this.armed.add(key);
  }
  disarm() {
    this.armed.clear();
  }
  get isArmed() {
    return this.armed.size > 0;
  }
  async getItem(key: string) {
    if (this.armed.delete(key)) throw new Error('確認用の読込失敗');
    return this.inner.getItem(key);
  }
  setItem(key: string, value: string) {
    return this.inner.setItem(key, value);
  }
  removeItem(key: string) {
    return this.inner.removeItem(key);
  }
}

export interface CompareSettings {
  /** 1〜5。候補の番号 */
  variant: number;
  /** スケルトンあり/なし（なしは通常のローダー） */
  skeleton: boolean;
  /** 比較用の最低表示。0 なら実際の準備が整い次第すぐ進む。本番の画面には存在しない */
  delayMs: number;
}

export const COMPARE_DELAY_MS = 1200;
export const VARIANT_COUNT = 5;
export const DEFAULT_COMPARE: CompareSettings = { variant: 1, skeleton: true, delayMs: COMPARE_DELAY_MS };

/** 保存・URLから来た値を検査して直す。知らない値は既定値にする（黙って別の値を採用しない） */
export function parseCompare(raw: unknown): CompareSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const variant = typeof o.variant === 'number' && Number.isInteger(o.variant) && o.variant >= 1 && o.variant <= VARIANT_COUNT ? o.variant : DEFAULT_COMPARE.variant;
  const skeleton = typeof o.skeleton === 'boolean' ? o.skeleton : DEFAULT_COMPARE.skeleton;
  const delayMs = o.delayMs === 0 || o.delayMs === COMPARE_DELAY_MS ? (o.delayMs as number) : DEFAULT_COMPARE.delayMs;
  return { variant, skeleton, delayMs };
}

/** 比較設定の保存（候補の中身とは別キー。名前空間の中） */
export class CompareStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<CompareSettings> {
    try {
      const text = await this.kv.getItem(COMPARE_KEY);
      return text === null ? DEFAULT_COMPARE : parseCompare(JSON.parse(text));
    } catch {
      return DEFAULT_COMPARE;
    }
  }
  async save(s: CompareSettings): Promise<void> {
    await this.kv.setItem(COMPARE_KEY, JSON.stringify(s));
  }
}
