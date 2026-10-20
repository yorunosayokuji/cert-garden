import type { DiagLoad, DiagState, DiagStorage } from '../../../src/mobile.ts';
import type { KeyValue } from './kv.ts';

export const DIAG_KEY = 'certgarden:diagnostic:v1';

/** 初回チェックの保存（学習コア・設定・編成とは別キー）。壊れた文字列は 'corrupt' として返し、書き換えない。形の検査はエンジン側 */
export class KvDiagStorage implements DiagStorage {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<DiagLoad> {
    const text = await this.kv.getItem(DIAG_KEY);
    if (text === null) return { kind: 'empty' };
    try {
      return { kind: 'ok', state: JSON.parse(text) as DiagState };
    } catch {
      return { kind: 'corrupt' };
    }
  }
  async save(state: DiagState): Promise<void> {
    await this.kv.setItem(DIAG_KEY, JSON.stringify(state));
  }
}
