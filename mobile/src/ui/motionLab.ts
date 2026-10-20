// MotionLab の純粋ロジック（React・画像に依存しない）。
// 12コマ版(old)と30コマ版(new)を同じ経過時間(ms)で比べる時間表と、歩行見本の位置・向き・コマ。
// 30は「30fps」でなく姿勢の総数。ここではコマ数と表示時間を分けて持つ。

export type LabMotion = 'blink' | 'stretch' | 'sleep';
export type Version = 'old' | 'new';

/** 動作の前後の立ち姿 */
export const LEAD_MS = 1000;
export const TAIL_MS = 1500;
export const SLEEP_HOLD_MS = 5500;
export const STAND_FRAME = 0;

export interface Seg {
  frame: number;
  ms: number;
}

/** frames を totalMs で均等に割る */
function even(frames: number[], totalMs: number): Seg[] {
  const ms = totalMs / frames.length;
  return frames.map((frame) => ({ frame, ms }));
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** 比較用に固定した時間表。旧版の120〜180msのランダムは中央値150ms（まばたきは100ms）で固定 */
const MOTIONS: Record<LabMotion, Record<Version, Seg[]>> = {
  blink: {
    old: even([1, 2, 3], 300),
    new: even([1, 2, 3, 4], 300),
  },
  stretch: {
    old: even([4, 5, 6, 5, 7], 750),
    new: even(range(5, 14), 750),
  },
  sleep: {
    // 寝入り450ms → 11で5500ms保持 → 起床450ms
    old: [...even([8, 9, 10], 450), { frame: 11, ms: SLEEP_HOLD_MS }, ...even([10, 9, 8], 450)],
    // 起床は顔側の瞳の足元からの高さが単調に上がる順（22=43.5,26=65.3,27=78.2,25=79.5,23=79.6,24=84.3,28=92.2,29=92.6px。色範囲での推定）。
    // 合成・モーフはしない
    new: [...even(range(15, 20), 450), { frame: 21, ms: SLEEP_HOLD_MS }, ...even([22, 26, 27, 25, 23, 24, 28, 29], 450)],
  },
};

export const MOTION_LABELS: Record<LabMotion, string> = { blink: 'まばたき', stretch: '伸び', sleep: '寝る・起きる' };
export const MOTION_ORDER: LabMotion[] = ['blink', 'stretch', 'sleep'];

export interface Track {
  segs: Seg[];
  /** 各セグメントの開始時刻(ms) */
  starts: number[];
  total: number;
  /** 動作の区間 [start, end) */
  motionStart: number;
  motionEnd: number;
  /** 眠りの保持区間（眠る動作だけ） */
  hold: [number, number] | null;
}

export function buildTrack(motion: LabMotion, version: Version): Track {
  const move = MOTIONS[motion][version];
  const segs: Seg[] = [{ frame: STAND_FRAME, ms: LEAD_MS }, ...move, { frame: STAND_FRAME, ms: TAIL_MS }];
  const starts: number[] = [];
  let t = 0;
  let hold: [number, number] | null = null;
  segs.forEach((s, i) => {
    starts.push(t);
    if (motion === 'sleep' && s.ms === SLEEP_HOLD_MS && i > 0 && i < segs.length - 1) hold = [t, t + s.ms];
    t += s.ms;
  });
  const moveMs = move.reduce((a, s) => a + s.ms, 0);
  return { segs, starts, total: t, motionStart: LEAD_MS, motionEnd: LEAD_MS + moveMs, hold };
}

/** 経過時刻 t のコマ。範囲外は両端へ丸める（終端は立ち姿） */
export function frameAt(track: Track, t: number): number {
  if (!(t > 0)) return track.segs[0]!.frame;
  if (t >= track.total) return track.segs[track.segs.length - 1]!.frame;
  let i = track.starts.length - 1;
  while (i > 0 && track.starts[i]! > t) i--;
  return track.segs[i]!.frame;
}

export type Phase = 'before' | 'motion' | 'hold' | 'after';
/** 両版で同じ時刻に同じ区間になることの確認に使う */
export function phaseAt(track: Track, t: number): Phase {
  if (t < track.motionStart) return 'before';
  if (t >= track.motionEnd) return 'after';
  if (track.hold && t >= track.hold[0] && t < track.hold[1]) return 'hold';
  return 'motion';
}

/** コマ送りが止まる時刻（両版の切り替わり時刻の和集合＋終端）。昇順・重複なし */
export function compareBounds(a: Track, b: Track): number[] {
  const all = [...a.starts, ...b.starts, a.total, b.total].sort((x, y) => x - y);
  const out: number[] = [];
  for (const v of all) if (out.length === 0 || v - out[out.length - 1]! > 1e-6) out.push(v);
  return out;
}

const EPS = 1e-6;
export function nextBoundary(bounds: number[], t: number): number {
  for (const b of bounds) if (b > t + EPS) return b;
  return bounds[bounds.length - 1]!;
}
export function prevBoundary(bounds: number[], t: number): number {
  for (let i = bounds.length - 1; i >= 0; i--) if (bounds[i]! < t - EPS) return bounds[i]!;
  return bounds[0]!;
}

// ---------- 共通時計 ----------

export type Speed = 1 | 0.25;
export interface Clock {
  elapsed: number;
  playing: boolean;
  speed: Speed;
}
/** 非表示から戻った直後などの大きな隙間で位相が飛ばないよう、1回に進める実時間の上限 */
export const MAX_DT_MS = 100;

export const initialClock = (playing: boolean): Clock => ({ elapsed: 0, playing, speed: 1 });

/** 実時間 dt(ms) だけ進める。total に達したら止まる（Infinity なら止まらない）。止まっている時計は動かない */
export function advance(c: Clock, dtMs: number, total: number): Clock {
  if (!c.playing) return c;
  const dt = Math.min(Math.max(dtMs, 0), MAX_DT_MS);
  const e = c.elapsed + dt * c.speed;
  if (e >= total) return { ...c, elapsed: total, playing: false };
  return { ...c, elapsed: e };
}
export function togglePlay(c: Clock, total: number): Clock {
  if (c.playing) return { ...c, playing: false };
  return { ...c, elapsed: c.elapsed >= total ? 0 : c.elapsed, playing: true };
}
export const restartClock = (c: Clock, autoplay: boolean): Clock => ({ ...c, elapsed: 0, playing: autoplay });
/** 速度を変えても elapsed は変えない（位相が飛ばない） */
export const setSpeed = (c: Clock, speed: Speed): Clock => ({ ...c, speed });
/** 時刻を指定する。操作中は止める */
export function seekClock(c: Clock, t: number, total: number): Clock {
  return { ...c, elapsed: Math.min(Math.max(t, 0), total), playing: false };
}

// ---------- 表示の大きさ（0番の全身高さ基準） ----------

export interface SizedAtlas {
  frames: { rect: number[] }[];
}
const maxOf = (a: SizedAtlas, i: 2 | 3) => Math.max(...a.frames.map((f) => f.rect[i]!));
/** 0番（立ち姿）の全身高さを h0(px) にする倍率。atlas内の全コマに同じ倍率を使う（コマごとの伸縮なし） */
export const scaleFromFrame0 = (a: SizedAtlas, h0: number): number => h0 / a.frames[0]!.rect[3]!;
/** その倍率で全コマが取る最大の幅・高さ */
export const extentAt = (a: SizedAtlas, scale: number): { w: number; h: number } => ({ w: maxOf(a, 2) * scale, h: maxOf(a, 3) * scale });
/** 各atlasの全コマが maxW に収まる最大の 0番高さ（全atlas共通） */
export function fitFrame0Height(atlases: SizedAtlas[], maxW: number): number {
  return Math.min(...atlases.map((a) => maxW / extentAt(a, scaleFromFrame0(a, 1)).w));
}
/** 全atlasの全コマの最大高さ＋上下の余白(margin)。足元は stage 下端から margin 上 */
export function stageHeightFor(atlases: SizedAtlas[], h0: number, margin = 12): number {
  return Math.ceil(Math.max(...atlases.map((a) => extentAt(a, scaleFromFrame0(a, h0)).h)) + margin * 2);
}

// ---------- 歩行見本 ----------

export interface WalkParams {
  frames: number;
  /** 12コマで1周期 */
  cycleMs: number;
  /** 可視幅/部屋幅 */
  bodyRatio: number;
  /** 1周期で進む距離（体幅に対する割合の目標 0.25〜0.35） */
  strideBody: number;
  /** 中心の可動域（部屋に対する比率） */
  xMin: number;
  xMax: number;
  /** 足元の高さ（部屋に対する比率。ラベンダーの手前の床の歩行帯） */
  y: number;
  /** 端で止まって休む時間 */
  restMs: number;
}
export const WALK: WalkParams = { frames: 12, cycleMs: 1200, bodyRatio: 0.23, strideBody: 0.3, xMin: 0.3, xMax: 0.7, y: 0.86, restMs: 1500 };
export const WALK_FRAME_MS = WALK.cycleMs / WALK.frames;

export interface WalkPlan {
  /** 片道の周期数（整数にして、止まる時に足が1周期の頭へ戻るようにする） */
  cycles: number;
  legMs: number;
  /** 1周期で進む距離（部屋に対する比率） */
  stride: number;
  slotMs: number;
}
export function walkPlan(p: WalkParams = WALK): WalkPlan {
  const span = p.xMax - p.xMin;
  const cycles = Math.max(1, Math.round(span / (p.strideBody * p.bodyRatio)));
  const legMs = cycles * p.cycleMs;
  return { cycles, legMs, stride: span / cycles, slotMs: legMs + p.restMs };
}

export type Facing = 'left' | 'right';
export interface WalkState {
  /** 足元の中心(部屋に対する比率) */
  x: number;
  y: number;
  /** 'left' が原画の向き。'right' は左右反転 */
  facing: Facing;
  moving: boolean;
  frame: number;
}

/** 共通時間 t(ms) から、位置・向き・コマを一緒に求める。右端から左へ歩き、止まって休み、向きを変えて戻る */
export function walkAt(t: number, p: WalkParams = WALK, plan: WalkPlan = walkPlan(p)): WalkState {
  const tt = Math.max(0, t);
  const k = Math.floor(tt / plan.slotMs);
  const r = tt - k * plan.slotMs;
  const goingLeft = k % 2 === 0;
  const span = p.xMax - p.xMin;
  if (r < plan.legMs) {
    const prog = r / plan.legMs;
    const x = goingLeft ? p.xMax - span * prog : p.xMin + span * prog;
    const frame = Math.floor(r / WALK_FRAME_MS) % p.frames;
    return { x, y: p.y, facing: goingLeft ? 'left' : 'right', moving: true, frame };
  }
  const x = goingLeft ? p.xMin : p.xMax;
  // 停止中の後半で次の進行方向へ向きを変える（反転は止まっている間だけ）
  const turned = r - plan.legMs >= p.restMs / 2;
  const nextLeft = turned ? !goingLeft : goingLeft;
  return { x, y: p.y, facing: nextLeft ? 'left' : 'right', moving: false, frame: 0 };
}

/** その場の歩行：同じ共通時間で12コマを回す */
export const inPlaceFrame = (t: number, p: WalkParams = WALK): number => Math.floor(Math.max(0, t) / WALK_FRAME_MS) % p.frames;

/** 歩行のコマ送り（±1コマ分の時間）。WALK_FRAME_MS の倍数へ寄せる */
export function walkStepTime(t: number, dir: 1 | -1): number {
  const k = Math.round(t / WALK_FRAME_MS * 1e6) / 1e6;
  const base = Number.isInteger(k) ? k : dir === 1 ? Math.floor(k) : Math.ceil(k);
  return Math.max(0, (base + dir) * WALK_FRAME_MS);
}
