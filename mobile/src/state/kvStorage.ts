import { codes, CoreError, parseState, type CoreState, type StorageAdapter, type StorageLoad } from '../../../src/mobile.ts';
import type { KeyValue } from './kv.ts';

export const CORE_KEY = 'certgarden:core:v1';

/** StudyCore の保存先。壊れたデータは黙って初期化せず CORRUPT_STORAGE で失敗する */
export class KvStorage implements StorageAdapter {
  readonly kv: KeyValue;
  readonly key: string;
  constructor(kv: KeyValue, key = CORE_KEY) {
    this.kv = kv;
    this.key = key;
  }
  async load(): Promise<StorageLoad> {
    let text: string | null;
    try {
      text = await this.kv.getItem(this.key);
    } catch {
      throw new CoreError(codes.corruptStorage, '端末の保存データを読めませんでした');
    }
    if (text === null) return { kind: 'empty' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CoreError(codes.corruptStorage, '保存データが壊れています（そのまま残してあります）');
    }
    return { kind: 'ok', state: parseState(parsed) };
  }
  async save(state: CoreState): Promise<void> {
    await this.kv.setItem(this.key, JSON.stringify(state));
  }
}
