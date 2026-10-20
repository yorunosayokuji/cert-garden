import { QUALIFICATIONS } from '../../../src/mobile.ts';
import type { KeyValue } from './kv.ts';

export const LEARN_PREFS_KEY = 'certgarden:learnprefs:v1';
export const DEFAULT_QUAL = 'it-passport';

/** 学ぶ画面で最後に選んだ資格（見た目の設定だけ。読めない・知らない値は既定に戻す。学習の保存には触れない） */
export class LearnPrefsStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<string> {
    const text = await this.kv.getItem(LEARN_PREFS_KEY);
    if (text === null) return DEFAULT_QUAL;
    try {
      const v = JSON.parse(text) as { qualificationId?: unknown };
      return QUALIFICATIONS.find((q) => q.id === v.qualificationId)?.id ?? DEFAULT_QUAL;
    } catch {
      return DEFAULT_QUAL;
    }
  }
  async save(qualificationId: string): Promise<void> {
    await this.kv.setItem(LEARN_PREFS_KEY, JSON.stringify({ qualificationId }));
  }
}
