// iOS 画面（製品・比較）の保存先の作り方。比較用の道具（読込失敗の差し込み・比較設定）は含めない＝製品の経路から読んでよい。
import { BACKUP_KEYS } from '../account/backup.ts';
import type { KeyValue } from '../state/kv.ts';

/** 比較入口の保存。本体は 'certgarden:' で始まるキーだけを使う。ここは必ず別の接頭辞（コロンの前が違う） */
export const IOS_DESIGN_PREFIX = 'certgarden-ios-design:';
/** Web の開発専用の製品プレビュー（?iosProductPreview=N）の保存。通常の保存・比較の保存のどちらとも別 */
export const PRODUCT_PREVIEW_PREFIX = 'certgarden-ios-product-preview:';
/** native の製品で、学習データ以外（世代のポインター・結び付けなど）を置く接頭辞 */
export const PRODUCT_META_PREFIX = 'certgarden-product:';

const forbidden = (prefix: string) => !prefix || prefix.startsWith('certgarden:') || 'certgarden:'.startsWith(prefix);

/** すべてのキーに接頭辞を付ける。接頭辞の外のキーは読めず、書けず、消せない */
export class PrefixedKv implements KeyValue {
  readonly base: KeyValue;
  readonly prefix: string;
  constructor(base: KeyValue, prefix = IOS_DESIGN_PREFIX) {
    if (forbidden(prefix)) throw new Error('本体の保存と重なる接頭辞は使えません');
    this.base = base;
    this.prefix = prefix;
  }
  getItem(key: string) {
    return this.base.getItem(this.prefix + key);
  }
  setItem(key: string, value: string) {
    return this.base.setItem(this.prefix + key, value);
  }
  removeItem(key: string) {
    return this.base.removeItem(this.prefix + key);
  }
}

/**
 * native の製品の保存。学習の9キー（'certgarden:*:v1'）は端末の既存の保存をそのまま読み書きする＝ゲストの原本。
 * それ以外のキー（復元した世代 g<N>/…・世代のポインター・結び付け）は専用の接頭辞の下へ置き、既存のキーと混ぜない。
 */
export class ProductKv implements KeyValue {
  readonly base: KeyValue;
  constructor(base: KeyValue) {
    this.base = base;
  }
  private map(key: string): string {
    return (BACKUP_KEYS as readonly string[]).includes(key) ? key : PRODUCT_META_PREFIX + key;
  }
  getItem(key: string) {
    return this.base.getItem(this.map(key));
  }
  setItem(key: string, value: string) {
    return this.base.setItem(this.map(key), value);
  }
  removeItem(key: string) {
    return this.base.removeItem(this.map(key));
  }
}
