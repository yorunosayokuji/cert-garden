// 個別家具8点の模様替え（画像に依存しない純粋なロジックと保存）。
// 数値の正本は design-assets/app-completion-20261020/garden/manifest.json（試験で突き合わせる）。
// 室内（編集可能な部屋）だけが対象。風景の背景に焼かれた家具は動かせない。
// 追加5点の trialPointCost はゲーム内の仮ポイントで、金銭の価格・課金ではない。
import type { KeyValue } from './kv.ts';

export type Pt = [number, number];

export interface FurnitureDef {
  id: string;
  name: string;
  /** 512角キャンバス内の足元(anchor)。描画はこの点を床の位置に合わせる */
  anchor: Pt;
  /** 画像の見える幅(px)。キャンバス幅ではない */
  referenceWidth: number;
  /** 部屋の幅に対する見える幅の割合 */
  roomWidth: number;
  defaultGround: Pt;
  /** 床での占有（幅, 奥行き）。部屋に対する割合 */
  footprint: Pt;
  layer: 'floor' | 'object';
  trialPointCost: number;
}

export const CANVAS = 512;

export const FURNITURE: readonly FurnitureDef[] = [
  { id: 'leaf-rug', name: '葉っぱのラグ', anchor: [256, 424], referenceWidth: 430, roomWidth: 0.44, defaultGround: [0.5, 0.77], footprint: [0.4, 0.13], layer: 'floor', trialPointCost: 0 },
  { id: 'knowledge-tree', name: '知恵の木', anchor: [256, 424], referenceWidth: 300, roomWidth: 0.23, defaultGround: [0.5, 0.47], footprint: [0.13, 0.08], layer: 'object', trialPointCost: 0 },
  { id: 'wood-stool', name: '木のスツール', anchor: [256, 424], referenceWidth: 359, roomWidth: 0.12, defaultGround: [0.64, 0.6], footprint: [0.09, 0.06], layer: 'object', trialPointCost: 0 },
  { id: 'bookcase', name: '小さな本棚', anchor: [256, 424], referenceWidth: 420, roomWidth: 0.25, defaultGround: [0.78, 0.52], footprint: [0.21, 0.08], layer: 'object', trialPointCost: 30 },
  { id: 'armchair', name: 'くつろぎの椅子', anchor: [256, 424], referenceWidth: 407, roomWidth: 0.22, defaultGround: [0.23, 0.67], footprint: [0.18, 0.11], layer: 'object', trialPointCost: 40 },
  { id: 'leaf-cushion', name: '葉っぱのクッション', anchor: [256, 424], referenceWidth: 430, roomWidth: 0.18, defaultGround: [0.31, 0.76], footprint: [0.15, 0.07], layer: 'object', trialPointCost: 20 },
  { id: 'coffee-table', name: '本のあるテーブル', anchor: [256, 424], referenceWidth: 430, roomWidth: 0.24, defaultGround: [0.75, 0.79], footprint: [0.19, 0.1], layer: 'object', trialPointCost: 30 },
  { id: 'leaf-pot', name: 'みどりの鉢植え', anchor: [256, 424], referenceWidth: 381, roomWidth: 0.13, defaultGround: [0.87, 0.76], footprint: [0.08, 0.06], layer: 'object', trialPointCost: 20 },
];
export const STARTER_IDS = ['leaf-rug', 'knowledge-tree', 'wood-stool'] as const;
export const FLOOR_POLYGON: Pt[] = [[0.255, 0.33], [0.765, 0.33], [0.945, 0.8], [0.875, 0.89], [0.125, 0.89], [0.055, 0.8]];

export const defOf = (id: string): FurnitureDef | undefined => FURNITURE.find((f) => f.id === id);
export const isStarter = (id: string) => (STARTER_IDS as readonly string[]).includes(id);
/** 入手できる追加の家具（仮ポイント） */
export const SHOP_ITEMS = FURNITURE.filter((f) => !isStarter(f.id));

/** 持っている家具: スターター3点＋仮ポイントで入手したもの */
export const ownedSet = (purchased: readonly string[]): Set<string> => new Set([...STARTER_IDS, ...purchased.filter((id) => defOf(id))]);

export type TreeStageName = 'seed' | 'sprout' | 'leaf' | 'fruit';
export const TREE_STAGE_INDEX: Record<TreeStageName, number> = { seed: 0, sprout: 1, leaf: 2, fruit: 3 };
/** 成長画の共通の寸法（manifest: 全段階 referenceWidth=356・anchor=[256,488]・roomWidth=.23）。各画像の余白を段階ごとに合わせ直さない */
export const TREE_GROWTH = { anchor: [256, 488] as Pt, referenceWidth: 356 };

/** 知恵の木だけ、成長画の寸法に差し替える（家具のID/所有/配置/障害物/部屋での見える幅は変えない） */
export function growthDef(def: FurnitureDef): FurnitureDef {
  return def.id === 'knowledge-tree' ? { ...def, anchor: TREE_GROWTH.anchor, referenceWidth: TREE_GROWTH.referenceWidth } : def;
}

/** 画像の描画寸法。見える幅(referenceWidth)が部屋幅×roomWidth になる倍率。キャンバス幅の仮定はしない */
export function drawRect(def: FurnitureDef, roomPx: number, ground: Pt) {
  const scale = (def.roomWidth * roomPx) / def.referenceWidth;
  return {
    left: ground[0] * roomPx - def.anchor[0] * scale,
    top: ground[1] * roomPx - def.anchor[1] * scale,
    size: CANVAS * scale,
  };
}

export interface Placed {
  id: string;
  x: number;
  y: number;
}
export interface Layout {
  version: 1;
  placed: Placed[];
}

export const starterLayout = (): Layout => ({
  version: 1,
  placed: STARTER_IDS.map((id) => ({ id, x: defOf(id)!.defaultGround[0], y: defOf(id)!.defaultGround[1] })),
});

/** 足元を中心に置いた床の占有（左, 上, 右, 下） */
export function footprintRect(def: FurnitureDef, x: number, y: number): [number, number, number, number] {
  const [w, h] = def.footprint;
  return [x - w / 2, y - h, x + w / 2, y];
}

function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const EPS = 1e-9;
const overlaps = (a: number[], b: number[]) => a[0]! < b[2]! - EPS && b[0]! < a[2]! - EPS && a[1]! < b[3]! - EPS && b[1]! < a[3]! - EPS;

/** 置けない理由（null なら置ける）。床の外・他の家具との重なりは確定前にここで弾く。床のラグは他の家具の下に敷けるので重なりの対象外 */
export function placementProblem(layout: Layout, id: string, x: number, y: number): string | null {
  const def = defOf(id);
  if (!def) return '知らない家具です';
  const r = footprintRect(def, x, y);
  const corners: Pt[] = [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]];
  if (!corners.every((c) => inPolygon(c, FLOOR_POLYGON))) return '床の外には置けません';
  if (def.layer === 'floor') return null;
  for (const p of layout.placed) {
    if (p.id === id) continue;
    const o = defOf(p.id);
    if (!o || o.layer === 'floor') continue;
    if (overlaps(r, footprintRect(o, p.x, p.y))) return `${o.name}と重なります`;
  }
  return null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** 置いてある家具を動かす。置けない位置なら null（動かさない） */
export function moveTo(layout: Layout, id: string, x: number, y: number): Layout | null {
  if (!layout.placed.some((p) => p.id === id)) return null;
  const nx = round3(x);
  const ny = round3(y);
  if (placementProblem(layout, id, nx, ny)) return null;
  return { ...layout, placed: layout.placed.map((p) => (p.id === id ? { id, x: nx, y: ny } : p)) };
}
export const moveBy = (layout: Layout, id: string, dx: number, dy: number): Layout | null => {
  const p = layout.placed.find((q) => q.id === id);
  return p ? moveTo(layout, id, p.x + dx, p.y + dy) : null;
};

/** しまう（所有は残り、配置だけ外れる） */
export const storeAway = (layout: Layout, id: string): Layout => ({ ...layout, placed: layout.placed.filter((p) => p.id !== id) });

/** 置く: 既定の位置、置けなければ床の中で最も近い空き位置。無ければ null */
export function placeItem(layout: Layout, id: string): Layout | null {
  const def = defOf(id);
  if (!def || layout.placed.some((p) => p.id === id)) return null;
  const [gx, gy] = def.defaultGround;
  let best: Pt | null = null;
  let bestD = Infinity;
  for (let ix = 0; ix <= 50; ix++) {
    for (let iy = 0; iy <= 50; iy++) {
      const x = ix / 50;
      const y = iy / 50;
      const d = (x - gx) ** 2 + (y - gy) ** 2;
      if (d < bestD && !placementProblem(layout, id, x, y)) {
        best = [x, y];
        bestD = d;
      }
    }
  }
  if (!placementProblem(layout, id, gx, gy)) best = [gx, gy];
  return best ? { ...layout, placed: [...layout.placed, { id, x: round3(best[0]), y: round3(best[1]) }] } : null;
}

/** 描画順: 床のラグが最背面、ほかは足元Yの小さい順（奥から手前）。キャラとはzで混ぜるため y を返す */
export function drawOrder(layout: Layout): Placed[] {
  return layout.placed.slice().sort((a, b) => {
    const la = defOf(a.id)?.layer === 'floor' ? 0 : 1;
    const lb = defOf(b.id)?.layer === 'floor' ? 0 : 1;
    return la - lb || a.y - b.y;
  });
}

/** 所有していない家具の配置は描かない・保存しない（購入の無い配置を作らない） */
export const onlyOwned = (layout: Layout, owned: Set<string>): Layout => ({ ...layout, placed: layout.placed.filter((p) => owned.has(p.id)) });

export const sameLayout = (a: Layout, b: Layout) => JSON.stringify(a) === JSON.stringify(b);

// ---- 保存 ----
export const FURNITURE_KEY = 'certgarden:furniture:v1';

export function isValidLayout(v: unknown): v is Layout {
  const o = v as Partial<Layout> | null;
  if (typeof o !== 'object' || o === null || o.version !== 1 || !Array.isArray(o.placed)) return false;
  const ids = new Set<string>();
  for (const p of o.placed) {
    if (typeof p !== 'object' || p === null || !defOf(p.id) || ids.has(p.id)) return false;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return false;
    ids.add(p.id);
  }
  return true;
}

export interface LayoutLoad {
  layout: Layout;
  corrupt: boolean;
}

/** 配置の保存（学習・編成・診断とは別キー）。無ければスターター3点の初期配置。壊れていても上書きしない */
export class LayoutStore {
  readonly kv: KeyValue;
  constructor(kv: KeyValue) {
    this.kv = kv;
  }
  async load(): Promise<LayoutLoad> {
    const text = await this.kv.getItem(FURNITURE_KEY);
    if (text === null) return { layout: starterLayout(), corrupt: false };
    try {
      const v: unknown = JSON.parse(text);
      if (isValidLayout(v)) return { layout: v, corrupt: false };
    } catch {
      // corrupt
    }
    return { layout: starterLayout(), corrupt: true };
  }
  async save(layout: Layout): Promise<void> {
    await this.kv.setItem(FURNITURE_KEY, JSON.stringify(layout));
  }
}
