// 四足歩行の「設計上の位相」（純粋データ）。絵から測った足位置ではない。
// 近い側=左(LH/LF)、遠い側=右(RH/RF)。接地は 左後→左前→右後→右前 の順で 25% ずつずれる。

export type Leg = 'LH' | 'LF' | 'RH' | 'RF';
export const LEGS: Leg[] = ['LH', 'LF', 'RH', 'RF'];
export const LEG_NAMES: Record<Leg, string> = { LH: '左後', LF: '左前', RH: '右後', RF: '右前' };

export const GAIT_DESIGN = {
  /** 接地する周期位置(%) */
  touchdownPct: { LH: 0, LF: 25, RH: 50, RF: 75 } as Record<Leg, number>,
  /** 支持（足が床にある）の割合(%) */
  supportPct: 65,
  /** 運び（足を前へ運ぶ）の割合(%) */
  swingPct: 35,
} as const;

/** 骨格ガイドSVGの脚の色（近い側=暖色、遠い側=寒色）。SVGと揃える */
export const LEG_COLORS: Record<Leg, string> = { LH: '#F29A2E', LF: '#E8604C', RH: '#7A4FC4', RF: '#3B7DD8' };

/** [開始%, 終了%] の並び。周期の終わりをまたぐときは2つに分ける */
export type Seg = [number, number];

function wrapSegs(start: number, len: number): Seg[] {
  const s = ((start % 100) + 100) % 100;
  const e = s + len;
  return e <= 100 ? [[s, e]] : [[s, 100], [0, e - 100]];
}

export function supportSegments(leg: Leg): Seg[] {
  return wrapSegs(GAIT_DESIGN.touchdownPct[leg], GAIT_DESIGN.supportPct);
}
export function swingSegments(leg: Leg): Seg[] {
  return wrapSegs(GAIT_DESIGN.touchdownPct[leg] + GAIT_DESIGN.supportPct, GAIT_DESIGN.swingPct);
}

/** 周期位置 pct(%) でその脚が支持中か */
export function isSupport(leg: Leg, pct: number): boolean {
  const p = ((pct % 100) + 100) % 100;
  const rel = (p - GAIT_DESIGN.touchdownPct[leg] + 100) % 100;
  return rel < GAIT_DESIGN.supportPct;
}

export const supportCount = (pct: number): number => LEGS.filter((l) => isSupport(l, pct)).length;
