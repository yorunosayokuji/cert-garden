import type { KeyValue } from './kv.ts';

export const NOTEBOOK_KEY = 'certgarden:notebook:v1';
export const SETTINGS_KEY = 'certgarden:settings:v1';

/** 自己申告の取得記録。公式の合格証明ではない。学習コアの進捗とは別に保存する */
export interface NotebookEntry {
  id: string;
  name: string;
  /** YYYY-MM-DD（空なら未入力） */
  date: string;
  memo: string;
  /** 任意: 学習の資格(10資格のID)に結び付ける。学習時間・完了テーマ・次の復習の表示に使う（学習を自動付与はしない） */
  qualificationId?: string;
  /** 任意: 「取得した」という自分の記録。公式の合格証明ではなく、自動判定もしない */
  passed?: boolean;
}

export type CompanionId = 'cream' | 'lavender' | 'apricot';

export interface Settings {
  companion: CompanionId;
  reduceMotion: boolean;
}

export const DEFAULT_SETTINGS: Settings = { companion: 'apricot', reduceMotion: false };

export function validateEntry(name: string, date: string): string | null {
  if (name.trim() === '') return '資格の名前を入れてください';
  if (date.trim() !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!m) return '日付は 2026-10-12 のように入れてください';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      return 'その日付は存在しません';
    }
  }
  return null;
}

export class NotebookStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  /** 壊れていれば例外（黙って空にしない） */
  async load(): Promise<NotebookEntry[]> {
    const text = await this.kv.getItem(NOTEBOOK_KEY);
    if (text === null) return [];
    const v: unknown = JSON.parse(text);
    if (!Array.isArray(v)) throw new Error('手帳のデータが壊れています');
    const ids = new Set<string>();
    for (const e of v) {
      const o = e as Partial<Record<keyof NotebookEntry, unknown>> | null;
      if (
        typeof o !== 'object' || o === null ||
        typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.date !== 'string' || typeof o.memo !== 'string' ||
        ids.has(o.id) || validateEntry(o.name, o.date) !== null ||
        (o.qualificationId !== undefined && typeof o.qualificationId !== 'string') ||
        (o.passed !== undefined && typeof o.passed !== 'boolean')
      ) {
        throw new Error('手帳のデータが壊れています');
      }
      ids.add(o.id);
    }
    return v as NotebookEntry[];
  }
  async save(entries: NotebookEntry[]): Promise<void> {
    await this.kv.setItem(NOTEBOOK_KEY, JSON.stringify(entries));
  }
}

export class SettingsStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<Settings> {
    const text = await this.kv.getItem(SETTINGS_KEY);
    if (text === null) return DEFAULT_SETTINGS;
    const v = JSON.parse(text) as Partial<Settings>;
    const companion: CompanionId = v.companion === 'cream' || v.companion === 'lavender' || v.companion === 'apricot' ? v.companion : 'apricot';
    return { companion, reduceMotion: v.reduceMotion === true };
  }
  async save(s: Settings): Promise<void> {
    await this.kv.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}
