import type { HoldLoad, HoldState, HoldStorage } from '../../../src/mobile.ts';
import type { KeyValue } from './kv.ts';

export const HOLDS_KEY = 'certgarden:holds:v1';

/** 問題の記録・保留の保存（この端末だけ。学習・診断・編成・家具とは別キー）。壊れた文字列は 'corrupt' として返し、書き換えない */
export class KvHoldStorage implements HoldStorage {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<HoldLoad> {
    const text = await this.kv.getItem(HOLDS_KEY);
    if (text === null) return { kind: 'empty' };
    try {
      return { kind: 'ok', state: JSON.parse(text) as HoldState };
    } catch {
      return { kind: 'corrupt' };
    }
  }
  async save(state: HoldState): Promise<void> {
    await this.kv.setItem(HOLDS_KEY, JSON.stringify(state));
  }
}
