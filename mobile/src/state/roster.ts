import type { KeyValue } from './kv.ts';
import { CHARACTER_IDS, LEGACY_COMPANION, isCharacterId, type CharacterId } from './characters.ts';

export const ROSTER_KEY = 'certgarden:roster:v1';
export const SLOT_COUNT = 3;

/**
 * 同室の3枠と学習の相棒。全26体は「試作の体験用」にいつでも選べる（購入・所有の確定ではない）。
 * 設定(Settings)や学習コアの保存とは別キー。
 */
export interface Roster {
  version: 1;
  /** 同室の3枠（重複なし） */
  room: CharacterId[];
  /** 学習中に机にいる相棒 */
  companion: CharacterId;
}

/** 旧設定の相棒（cream/lavender/apricot）を引き継ぐ。旧来の箱庭の3体（クリーム・ラベンダー・あんず）がそのまま同室になる */
export function defaultRoster(legacyCompanion?: string): Roster {
  const companion = (legacyCompanion && LEGACY_COMPANION[legacyCompanion]) || 'anzu';
  return { version: 1, room: ['cream', 'lavender', 'anzu'], companion };
}

export function isValidRoster(v: unknown): v is Roster {
  const o = v as Partial<Roster> | null;
  return (
    typeof o === 'object' && o !== null && o.version === 1 &&
    Array.isArray(o.room) && o.room.length === SLOT_COUNT && o.room.every(isCharacterId) && new Set(o.room).size === SLOT_COUNT &&
    isCharacterId(o.companion)
  );
}

/** 枠に個体を置く。すでに別の枠にいる個体を選んだら、その2枠を入れ替える */
export function setSlot(r: Roster, slot: number, id: CharacterId): Roster {
  if (slot < 0 || slot >= SLOT_COUNT || !CHARACTER_IDS.includes(id)) return r;
  const room = r.room.slice();
  const from = room.indexOf(id);
  if (from === slot) return r;
  if (from >= 0) room[from] = room[slot]!;
  room[slot] = id;
  return { ...r, room };
}

export const setCompanion = (r: Roster, id: CharacterId): Roster => (CHARACTER_IDS.includes(id) ? { ...r, companion: id } : r);

export interface RosterLoad {
  roster: Roster;
  /** 保存が壊れていた。上書きしない（画面は既定の編成で表示するだけ） */
  corrupt: boolean;
}

export class RosterStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  /** 無ければ旧設定から引き継ぐ。壊れていても保存は書き換えず corrupt を返す */
  async load(legacyCompanion?: string): Promise<RosterLoad> {
    const text = await this.kv.getItem(ROSTER_KEY);
    if (text === null) return { roster: defaultRoster(legacyCompanion), corrupt: false };
    try {
      const v: unknown = JSON.parse(text);
      if (isValidRoster(v)) return { roster: v, corrupt: false };
    } catch {
      // 下で corrupt
    }
    return { roster: defaultRoster(legacyCompanion), corrupt: true };
  }
  async save(r: Roster): Promise<void> {
    await this.kv.setItem(ROSTER_KEY, JSON.stringify(r));
  }
}
