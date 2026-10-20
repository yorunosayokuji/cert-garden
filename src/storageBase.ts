import { codes, CoreError } from './errors.ts';
import type { CoreState, StorageAdapter, StorageLoad } from './types.ts';

export function emptyState(initialFruits: number, maxFruits: number): CoreState {
  return {
    schemaVersion: 1,
    wallet: { fruits: initialFruits, maxFruits },
    points: 0,
    studySeconds: {},
    completedThemes: {},
    reviews: {},
    mastery: {},
    stages: {},
    completions: {},
    log: [],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 最低限の構造検査。通らなければ壊れたデータとして扱い、黙って初期化しない */
export function parseState(raw: unknown): CoreState {
  if (!isObj(raw) || raw.schemaVersion !== 1) throw new CoreError(codes.corruptStorage, '保存データの版が不明、または形式が違います');
  const w = raw.wallet;
  if (!isObj(w) || !Number.isFinite(w.fruits) || !Number.isFinite(w.maxFruits)) throw new CoreError(codes.corruptStorage, '知恵の実のデータが壊れています');
  if (!Number.isFinite(raw.points)) throw new CoreError(codes.corruptStorage, 'ポイントのデータが壊れています');
  for (const k of ['studySeconds', 'completedThemes', 'reviews', 'mastery', 'stages', 'completions'] as const) {
    if (!isObj(raw[k])) throw new CoreError(codes.corruptStorage, `${k} が壊れています`);
  }
  if (!Array.isArray(raw.log)) throw new CoreError(codes.corruptStorage, 'log が壊れています');
  // 家具は後から足した任意の項目（旧保存には無い）。あるなら形を検査する
  if (raw.furniture !== undefined) {
    const f = raw.furniture;
    if (!isObj(f) || !Array.isArray(f.owned) || !f.owned.every((x) => typeof x === 'string') || new Set(f.owned).size !== f.owned.length) {
      throw new CoreError(codes.corruptStorage, '家具のデータが壊れています');
    }
  }
  // 実の時計・ミッション・木も後から足した任意の項目。あるなら形を検査する
  const fc = raw.fruitClock;
  if (fc !== undefined && (!isObj(fc) || typeof fc.lastDay !== 'string' || !Number.isFinite(fc.anchor) || !Number.isFinite(fc.maxSeen))) throw new CoreError(codes.corruptStorage, '実の時計のデータが壊れています');
  const dl = raw.daily;
  const okM = (m: unknown) => isObj(m) && (m.completionId === null || typeof m.completionId === 'string') && typeof m.claimed === 'boolean';
  if (dl !== undefined && (!isObj(dl) || typeof dl.day !== 'string' || !okM(dl.learn) || !okM(dl.review))) throw new CoreError(codes.corruptStorage, '今日のミッションのデータが壊れています');
  if (raw.claimed !== undefined && (!isObj(raw.claimed) || !Object.values(raw.claimed).every((v) => typeof v === 'string'))) throw new CoreError(codes.corruptStorage, '受け取りの記録が壊れています');
  const tr = raw.tree;
  if (tr !== undefined && (!isObj(tr) || !Number.isFinite(tr.total) || (tr.total as number) < 0 || typeof tr.lastDay !== 'string')) throw new CoreError(codes.corruptStorage, '木の世話のデータが壊れています');
  if (raw.growthMigrated !== undefined && typeof raw.growthMigrated !== 'boolean') throw new CoreError(codes.corruptStorage, '引き継ぎの印が壊れています');
  return raw as unknown as CoreState;
}

export class MemoryStorage implements StorageAdapter {
  private data: string | null = null;
  async load(): Promise<StorageLoad> {
    if (this.data === null) return { kind: 'empty' };
    return { kind: 'ok', state: parseState(JSON.parse(this.data)) };
  }
  async save(state: CoreState): Promise<void> {
    this.data = JSON.stringify(state);
  }
  /** テスト用: 保存内容を直接書き換える */
  setRaw(text: string | null) {
    this.data = text;
  }
}
