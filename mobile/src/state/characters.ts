// 採用26体の一覧（画像に依存しない純粋なデータ）。
// 正本は design-assets/app-completion-20261020/character-catalog.json。順序・id・名前は試験で突き合わせる。
// 旧3種（cream / lavender / apricot）は apricot → anzu の名前違いとして引き継ぐ（LEGACY_COMPANION）。

export interface CharacterInfo {
  id: string;
  name: string;
  /** 部屋での見た目の幅（部屋幅に対する可視幅の割合）。catalog の roomWidth */
  roomWidth: number;
}

export const CHARACTERS: readonly CharacterInfo[] = [
  { id: 'anzu', name: 'あんず', roomWidth: 0.23 },
  { id: 'cream', name: 'クリーム', roomWidth: 0.2 },
  { id: 'lavender', name: 'ラベンダー', roomWidth: 0.23 },
  { id: 'beans', name: 'ビーンズ', roomWidth: 0.24 },
  { id: 'mint', name: 'ミント', roomWidth: 0.21 },
  { id: 'kokemaru', name: 'こけまる', roomWidth: 0.2 },
  { id: 'pomuri', name: 'ぽむり', roomWidth: 0.2 },
  { id: 'sumimaru', name: 'すみまる', roomWidth: 0.2 },
  { id: 'hiyomo', name: 'ひよも', roomWidth: 0.2 },
  { id: 'urune', name: 'うるね', roomWidth: 0.2 },
  { id: 'hoshiru', name: 'ほしる', roomWidth: 0.2 },
  { id: 'kurin', name: 'くりん', roomWidth: 0.2 },
  { id: 'mochine', name: 'もちね', roomWidth: 0.2 },
  { id: 'ruriko', name: 'るりこ', roomWidth: 0.2 },
  { id: 'mitsuno', name: 'みつの', roomWidth: 0.2 },
  { id: 'curlyhorn', name: '巻き角のふわ獣', roomWidth: 0.2 },
  { id: 'flowerlong', name: '花襟の長耳獣', roomWidth: 0.2 },
  { id: 'mushroom', name: '赤傘のきのこ獣', roomWidth: 0.2 },
  { id: 'nightfox', name: '星耳の夜色獣', roomWidth: 0.2 },
  { id: 'bat', name: 'ふわ胸のコウモリ獣', roomWidth: 0.2 },
  { id: 'leafwrap', name: '秋葉に包まれた獣', roomWidth: 0.2 },
  { id: 'moonsleeper', name: '月星毛布の眠り獣', roomWidth: 0.2 },
  { id: 'cloudfur', name: '青白い雲毛の獣', roomWidth: 0.2 },
  { id: 'lantern', name: '灯り触角の夜獣', roomWidth: 0.2 },
  { id: 'flowergill', name: '花えらの桃色水獣', roomWidth: 0.2 },
  { id: 'cloudghost', name: '淡色のうず雲おばけ', roomWidth: 0.2 },
];

export type CharacterId = string;
export const CHARACTER_IDS: readonly CharacterId[] = CHARACTERS.map((c) => c.id);

export const isCharacterId = (v: unknown): v is CharacterId => typeof v === 'string' && CHARACTER_IDS.includes(v);
export const characterName = (id: CharacterId): string => CHARACTERS.find((c) => c.id === id)?.name ?? id;

/** 旧 CompanionId から新IDへ。apricot は採用名「あんず」(anzu) と同じ個体 */
export const LEGACY_COMPANION: Record<string, CharacterId> = { cream: 'cream', lavender: 'lavender', apricot: 'anzu' };
