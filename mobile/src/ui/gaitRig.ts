// 関節から作る歩行（純粋計算）。React・画像・ブラウザに依存しない。
// 新しい絵の30枚ではなく（30は関節姿勢の数）、AI生成した胴と脚の描画パーツ（design-assets/motion-v3/apricot-rig-parts-v1.png）を
// 30姿勢の関節位置へ向けて組み立てるための座標だけを返す。数値の出発点は rig-parts.json（試験で突き合わせる）。
//
// 座標は 96×76 の論理キャンバス（左向き歩行）。足元の接地は足裏 sole で合わせ、足先は支持中ずっと水平。
// 体は左へ 16論理px/周期 動く（ルート）。支持中の足は体に対して一定速度で右へ動くので、世界座標では止まる。
// rig-parts.json version 2（短脚: groundY58・奥55.5、足先幅11）に同期。

import { GAIT_DESIGN, LEGS, type Leg } from './gaitDesign.ts';

export const RIG_FRAMES = 30;
export const RIG_DURATION_MS = 1800;
/** 1周期でルートが左へ進む論理px（胴74pxに対して約0.22） */
export const RIG_STRIDE_PX = 16;
export const RIG_BODY_PX = 74;
export const RIG_CANVAS = [96, 76] as const;
/** キャンバス内の足元の基準（胴の中心x・近い側の接地線y）。部屋ではここを床の位置に置く */
export const RIG_ANCHOR = { x: 45, y: 58 } as const;
/** 遊脚の足先の持ち上げ（論理px） */
export const RIG_LIFT_PX = 4;
/** 足首から足裏までの高さ。足首の位置を足裏から決めるための設計値 */
const ANKLE_H = 3;

export type PartName = 'body' | 'foreUpper' | 'foreLower' | 'forePaw' | 'hindUpper' | 'hindShin' | 'hindHock' | 'hindPaw';
type Rect = readonly [number, number, number, number];
type Pt = readonly [number, number];

/** rig-parts.json の値（rect=[x,y,w,h]、start/end/sole はパーツ矩形内の座標） */
export const RIG_ATLAS = { width: 1536, height: 1024 } as const;
export const RIG_PARTS = {
  body: { rect: [60, 45, 660, 452] as Rect },
  foreUpper: { rect: [863, 196, 148, 248] as Rect, start: [75, 39] as Pt, end: [73, 221] as Pt },
  foreLower: { rect: [1247, 174, 133, 242] as Rect, start: [60, 51] as Pt, end: [63, 223] as Pt },
  forePaw: { rect: [1231, 391, 147, 93] as Rect, sole: [54, 84] as Pt, logicalWidth: 11 },
  hindUpper: { rect: [197, 584, 207, 313] as Rect, start: [108, 46] as Pt, end: [108, 270] as Pt },
  hindShin: { rect: [730, 626, 135, 265] as Rect, start: [72, 42] as Pt, end: [75, 228] as Pt },
  hindHock: { rect: [1221, 657, 152, 184] as Rect, start: [65, 48] as Pt, end: [91, 178] as Pt },
  hindPaw: { rect: [1221, 812, 151, 93] as Rect, sole: [65, 84] as Pt, logicalWidth: 11 },
} as const;
export const RIG_BODY = { origin: [8, 0] as Pt, logicalWidth: 74 } as const;

export const RIG_JOINTS: Record<Leg, { root: Pt; groundY: number; footCenterX: number }> = {
  LF: { root: [30, 40], groundY: 58, footCenterX: 28 },
  RF: { root: [26, 39], groundY: 55.5, footCenterX: 24 },
  LH: { root: [60, 40], groundY: 58, footCenterX: 59 },
  RH: { root: [57, 39], groundY: 55.5, footCenterX: 56 },
};

/** 骨の長さ（論理px）。前=肩→肘/肘→足首、後ろ=股→膝/膝→飛節/飛節→足首。体を引き伸ばさない短脚（根元から足首まで約13〜15px） */
export const BONES = { fore: [8, 10] as Pt, hind: [7, 9, 6] as readonly [number, number, number] };
/** 後脚の中足（飛節→足首）が鉛直から後ろへ傾く角度。支持中は一定、遊脚で曲げる */
const HOCK_BASE_DEG = 30;
const HOCK_FLEX_DEG = 25;

export const isFore = (leg: Leg): boolean => leg === 'LF' || leg === 'RF';
/** 奥側（右）の脚。手前の胴の後ろに描く */
export const isFar = (leg: Leg): boolean => leg === 'RF' || leg === 'RH';

export interface V { x: number; y: number }
export interface SegDraw { part: PartName; from: V; to: V }
export interface LegPose {
  leg: Leg;
  support: boolean;
  /** 足裏の位置（96×76格子へ丸めた値）。支持中は水平の足先がここに接する */
  foot: V;
  /** 丸める前の足裏位置 */
  footRaw: V;
  /** 関節: 前=[肩,肘,足首]、後ろ=[股,膝,飛節,足首] */
  joints: V[];
  segs: SegDraw[];
  /** 骨長を守れず届かせた（過伸展・過屈曲）場合 true。設計どおりなら常に false */
  clamped: boolean;
}
export interface RigPose { legs: Record<Leg, LegPose> }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 2関節IK。mid は root→target の線から bendX 側（+1=右/後ろ、-1=左/前）へ折れる */
function ik2(root: V, target: V, l1: number, l2: number, bendX: 1 | -1): { mid: V; end: V; clamped: boolean } {
  const dx = target.x - root.x;
  const dy = target.y - root.y;
  const dist = Math.hypot(dx, dy);
  const maxD = (l1 + l2) * 0.995;
  const minD = Math.abs(l1 - l2) + 0.5;
  const d = clamp(dist, minD, maxD);
  const ux = dist > 1e-9 ? dx / dist : 0;
  const uy = dist > 1e-9 ? dy / dist : 1;
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let px = -uy;
  let py = ux;
  if (px * bendX < 0) {
    px = -px;
    py = -py;
  }
  return {
    mid: { x: root.x + ux * a + px * h, y: root.y + uy * a + py * h },
    end: { x: root.x + ux * d, y: root.y + uy * d },
    clamped: d !== dist,
  };
}

const SUPPORT = GAIT_DESIGN.supportPct / 100;

/** その脚の周期内の相対位相（接地の瞬間=0）。t は周期を1とした時刻 */
export function legRel(leg: Leg, t: number): number {
  const rel = (t - GAIT_DESIGN.touchdownPct[leg] / 100) % 1;
  return rel < 0 ? rel + 1 : rel;
}

/** 体に対する足裏の理想位置。支持=一定速度で右へ（接地から支持終わりまで STRIDE*.65=10.4px）、遊脚=ゆるやかに前へ返しつつ持ち上げる */
export function footTarget(leg: Leg, t: number): { x: number; y: number; support: boolean; swingS: number } {
  const J = RIG_JOINTS[leg];
  const rel = legRel(leg, t);
  const span = RIG_STRIDE_PX * SUPPORT;
  if (rel < SUPPORT - 1e-9) {
    return { x: J.footCenterX - span / 2 + RIG_STRIDE_PX * rel, y: J.groundY, support: true, swingS: 0 };
  }
  const s = clamp((rel - SUPPORT) / (1 - SUPPORT), 0, 1);
  const e = s * s * (3 - 2 * s);
  return { x: J.footCenterX + span / 2 - span * e, y: J.groundY - RIG_LIFT_PX * Math.sin(Math.PI * s), support: false, swingS: s };
}

function solveLeg(leg: Leg, raw: V, support: boolean, swingS: number): LegPose {
  const J = RIG_JOINTS[leg];
  const root: V = { x: J.root[0], y: J.root[1] };
  const foot: V = { x: Math.round(raw.x), y: Math.round(raw.y) };
  const ankle: V = { x: foot.x, y: foot.y - ANKLE_H };
  if (isFore(leg)) {
    const [l1, l2] = BONES.fore;
    const r = ik2(root, ankle, l1, l2, 1);
    return {
      leg, support, foot, footRaw: raw, clamped: r.clamped,
      joints: [root, r.mid, ankle],
      segs: [{ part: 'foreUpper', from: root, to: r.mid }, { part: 'foreLower', from: r.mid, to: ankle }],
    };
  }
  const [l1, l2, l3] = BONES.hind;
  const phi = ((HOCK_BASE_DEG + HOCK_FLEX_DEG * Math.sin(Math.PI * swingS)) * Math.PI) / 180;
  const hock: V = { x: ankle.x + l3 * Math.sin(phi), y: ankle.y - l3 * Math.cos(phi) };
  const r = ik2(root, hock, l1, l2, -1);
  return {
    leg, support, foot, footRaw: raw, clamped: r.clamped,
    joints: [root, r.mid, r.end, ankle],
    segs: [
      { part: 'hindUpper', from: root, to: r.mid },
      { part: 'hindShin', from: r.mid, to: r.end },
      { part: 'hindHock', from: r.end, to: ankle },
    ],
  };
}

function buildPose(feet: Record<Leg, { x: number; y: number; support: boolean; swingS: number }>): RigPose {
  const legs = {} as Record<Leg, LegPose>;
  for (const leg of LEGS) legs[leg] = solveLeg(leg, { x: feet[leg].x, y: feet[leg].y }, feet[leg].support, feet[leg].swingS);
  return { legs };
}

/** n 番目の姿勢（n は連続した通し番号でもよい。周期は30姿勢） */
export function rigPoseAt(n: number): RigPose {
  const t = (((n % RIG_FRAMES) + RIG_FRAMES) % RIG_FRAMES) / RIG_FRAMES;
  const feet = {} as Record<Leg, ReturnType<typeof footTarget>>;
  for (const leg of LEGS) feet[leg] = footTarget(leg, t);
  return buildPose(feet);
}

/** 休憩: 4本とも足先を中立の位置に置いた立ち姿（同じ関節構造・同じパーツ。別シートへ切り替えない） */
export function restRigPose(): RigPose {
  const feet = {} as Record<Leg, ReturnType<typeof footTarget>>;
  for (const leg of LEGS) feet[leg] = { x: RIG_JOINTS[leg].footCenterX, y: RIG_JOINTS[leg].groundY, support: true, swingS: 0 };
  return buildPose(feet);
}

/** 通し番号 n（周期をまたいで増える）の瞬間に、その脚の足裏が世界座標でどこか。体の原点は左へ RIG_STRIDE_PX/周期 動く */
export const footWorldX = (pose: LegPose, n: number): number => pose.foot.x - (RIG_STRIDE_PX * n) / RIG_FRAMES;

// ---------- 描画リスト（Web canvas / native View 共通） ----------

export interface DrawItem {
  part: PartName;
  rect: Rect;
  /** パーツ内の回転・拡縮の基点（パーツ矩形内の座標） */
  pivotSrc: Pt;
  /** 基点を置く論理キャンバス上の位置 */
  pivot: [number, number];
  /** パーツ全体を一様に拡縮する倍率（論理px/元px） */
  scale: number;
  /** ラジアン（時計回り・y下向き座標） */
  rot: number;
}

const bodyItem = (): DrawItem => ({
  part: 'body',
  rect: RIG_PARTS.body.rect,
  pivotSrc: [0, 0],
  pivot: [RIG_BODY.origin[0], RIG_BODY.origin[1]],
  scale: RIG_BODY.logicalWidth / RIG_PARTS.body.rect[2],
  rot: 0,
});

/** 骨 start→end を from→to へ向ける（一様拡縮＋回転）。パーツの元の傾きは回転で打ち消す */
export function segItem(s: SegDraw): DrawItem {
  const p = RIG_PARTS[s.part as Exclude<PartName, 'body' | 'forePaw' | 'hindPaw'>];
  const sdx = p.end[0] - p.start[0];
  const sdy = p.end[1] - p.start[1];
  const tdx = s.to.x - s.from.x;
  const tdy = s.to.y - s.from.y;
  return {
    part: s.part,
    rect: p.rect,
    pivotSrc: p.start,
    pivot: [s.from.x, s.from.y],
    scale: Math.hypot(tdx, tdy) / Math.hypot(sdx, sdy),
    rot: Math.atan2(tdy, tdx) - Math.atan2(sdy, sdx),
  };
}

/** 足先は水平のまま（回転なし）、足裏 sole を foot に置く */
export function pawItem(leg: Leg, foot: V): DrawItem {
  const part = isFore(leg) ? 'forePaw' : 'hindPaw';
  const p = RIG_PARTS[part];
  return { part, rect: p.rect, pivotSrc: p.sole, pivot: [foot.x, foot.y], scale: p.logicalWidth / p.rect[2], rot: 0 };
}

/** 下から上へ: 奥の2脚 → 胴 → 手前の2脚。脚の中は 骨（下 → 上。上の関節が重なりを隠す）の後に足先を最後に描き、白い足先を骨が覆わない */
export function drawList(pose: RigPose): DrawItem[] {
  const leg = (l: Leg): DrawItem[] => {
    const lp = pose.legs[l];
    return [...[...lp.segs].reverse().map(segItem), pawItem(l, lp.foot)];
  };
  return [...leg('RH'), ...leg('RF'), bodyItem(), ...leg('LH'), ...leg('LF')];
}
