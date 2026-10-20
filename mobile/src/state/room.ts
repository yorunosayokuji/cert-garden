import type { KeyValue } from './kv.ts';

export const ROOM_KEY = 'certgarden:room:v1';
/** home = 家具を動かせる室内（空室背景＋個別家具）。first = 元のCの部屋（家具は絵に含まれ、動かせない）。ほかは風景 */
export type RoomId = 'home' | 'first' | 'library' | 'forest' | 'beach' | 'night';
export const ROOM_IDS: RoomId[] = ['home', 'first', 'library', 'forest', 'beach', 'night'];
/** 家具の編集ができる部屋 */
export const EDITABLE_ROOM: RoomId = 'home';
export const DEFAULT_ROOM: RoomId = 'home';

/** 箱庭で見る背景の選択。設定(Settings)とは別キーに保存し、読めない値は既定の部屋に戻す */
export class RoomStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<RoomId> {
    const text = await this.kv.getItem(ROOM_KEY);
    if (text === null) return DEFAULT_ROOM;
    try {
      const v = JSON.parse(text) as { room?: unknown };
      return ROOM_IDS.find((r) => r === v.room) ?? DEFAULT_ROOM;
    } catch {
      return DEFAULT_ROOM;
    }
  }
  async save(room: RoomId): Promise<void> {
    await this.kv.setItem(ROOM_KEY, JSON.stringify({ room }));
  }
}
