// MotionStudy（新しく描いた動き: motion-v3）の純粋ロジック。React・画像に依存しない。
// 枚数・秒数は design-assets/motion-v3/manifest.json と同じ値（test/motionStudy.test.ts で突き合わせる）。
// 時計は motionLab.ts の Clock をそのまま使う。0.25倍は検証表示の速度で、素材の時間は変えない。

import { extentAt, type SizedAtlas } from './motionLab.ts';

export type StudyMotion = 'walk' | 'stretch' | 'down' | 'up';
/** 新規連番のシート（walk/keys は保存のみで既定では再生しない） */
export type StudySheet = 'keys' | 'walk' | 'stretch' | 'down' | 'up';
/**
 * 表示に使うもの。'walkV4' = 新規の全身パーツ5枚を連動させて組んだ歩行30姿勢（motion-v4）。
 * 'walkV4Idle' = その休止の1コマ。'walkV4Settle' / 'walkV4Start' = 休止の最初/最後に浮いた足を下げる/上げる6枚。
 * 'rig' = 旧・関節から組み立てる歩行（比較履歴。既定では使わない）
 */
export type DrawSheet = StudySheet | 'walkV4' | 'walkV4Idle' | 'walkV4Settle' | 'walkV4Start' | 'rig';

/** 全身連動の歩き（motion-v4）。design-assets/motion-v4/manifest.json の atlases.walk と同じ値（test/motionStudy.test.ts で突き合わせる） */
export const WALK_V4_FRAMES = 30;
export const WALK_V4_DURATION_MS = 1800;
/** 1周期でルートが進む論理px と、頭から尾までの基準幅（論理px）。manifest.referenceWidth・scripts/fullWalkCore.mjs の STRIDE_PX と同じ値 */
export const WALK_V4_STRIDE_PX = 14;
export const WALK_V4_REFERENCE_WIDTH = 90;
/** 休止の最初に settle、最後に start を各6枚・40msずつ（計240ms）。その間は idle */
export const WALK_V4_TRANSITION_FRAMES = 6;
export const WALK_V4_TRANSITION_FRAME_MS = 40;
export const WALK_V4_TRANSITION_MS = WALK_V4_TRANSITION_FRAMES * WALK_V4_TRANSITION_FRAME_MS;

export interface StudyMotionDef {
  id: StudyMotion;
  label: string;
  sheet: DrawSheet;
  frameCount: number;
  durationMs: number;
  /** true は周期の繰り返し（歩く）。false は一度だけ再生して最後のコマで止まる */
  loop: boolean;
}

export const STUDY_MOTIONS: Record<StudyMotion, StudyMotionDef> = {
  walk: { id: 'walk', label: '歩く', sheet: 'walkV4', frameCount: WALK_V4_FRAMES, durationMs: WALK_V4_DURATION_MS, loop: true },
  stretch: { id: 'stretch', label: '伸び', sheet: 'stretch', frameCount: 30, durationMs: 3200, loop: false },
  down: { id: 'down', label: '寝入り', sheet: 'down', frameCount: 24, durationMs: 2400, loop: false },
  // 起きるは down の逆再生ではなく、別に描いた30枚
  up: { id: 'up', label: '起きる', sheet: 'up', frameCount: 30, durationMs: 3000, loop: false },
};
export const STUDY_ORDER: StudyMotion[] = ['walk', 'stretch', 'down', 'up'];
export const STUDY_INITIAL: StudyMotion = 'stretch';

/**
 * 歩行の折返しの休みは、t0 と同じ胴・頭・尾・足 x のまま浮足だけ接地させた4脚立ちの1コマ（idle atlas。同じ寸法・同じ anchor）。
 * 休みの最初240msは settle 6枚（足を下げる）、最後240msは start 6枚（足を上げる）で、idle へ瞬間移動しない。
 * 休みの出入りで胴・頭・尾が跳ねないかは親の実物確認待ち
 */
export const STAND_SHEET: DrawSheet = 'walkV4Idle';
export const STAND_FRAME = 0;

const EPS_FRAME = 1e-9;
const EPS_MS = 1e-6;

export const frameMs = (m: StudyMotion): number => STUDY_MOTIONS[m].durationMs / STUDY_MOTIONS[m].frameCount;
/** 一度きりの動きの合計時間。歩くは終わりがない（Infinity） */
export const studyTotal = (m: StudyMotion): number => (STUDY_MOTIONS[m].loop ? Infinity : STUDY_MOTIONS[m].durationMs);
export const frameStartMs = (m: StudyMotion, i: number): number => (i * STUDY_MOTIONS[m].durationMs) / STUDY_MOTIONS[m].frameCount;

/** 経過時刻 t(ms) のコマ。一度きりの動きは範囲外を両端へ丸める。割り算の誤差で1コマ手前にならないよう微小値を足す */
export function frameIndexAt(m: StudyMotion, t: number): number {
  const d = STUDY_MOTIONS[m];
  const raw = Math.floor((Math.max(0, t) * d.frameCount) / d.durationMs + EPS_FRAME);
  return d.loop ? raw % d.frameCount : Math.min(raw, d.frameCount - 1);
}

// ---------- 歩行（部屋の中を左右へ） ----------

export interface StudyWalkParams {
  /** 可視幅/部屋幅 */
  bodyRatio: number;
  /** 1周期で進む距離（可視幅に対する割合） */
  strideBody: number;
  /** 片道の歩行周期数（整数。折返しで足が周期の頭に戻る） */
  cycles: number;
  xCenter: number;
  /** 足元の高さ（部屋に対する比率）。歩行帯・固定位置とも同じ */
  y: number;
  /** 端での休み */
  restMs: number;
}
/**
 * 可視幅=頭から尾まで約90論理px（referenceWidth）。1周期のルート移動14論理px（90の約0.156倍）。
 * 新30姿勢は支持脚の足裏が体に対して14px/周期で動くよう組んであり（scripts/fullWalkCore.mjs の設計値）、世界座標では止まる設計。
 * 実画面で足が滑らないことの証明ではない（親が実物を見て確認・調整する）。
 */
export const STUDY_WALK: StudyWalkParams = { bodyRatio: 0.23, strideBody: WALK_V4_STRIDE_PX / WALK_V4_REFERENCE_WIDTH, cycles: 6, xCenter: 0.5, y: 0.86, restMs: 1500 };
/** 歩く以外の固定位置 */
export const STUDY_FIXED = { x: 0.5, y: STUDY_WALK.y } as const;

export interface StudyWalkPlan {
  cycles: number;
  cycleMs: number;
  legMs: number;
  restMs: number;
  slotMs: number;
  /** 1周期で進む距離（部屋に対する比率） */
  stride: number;
  xMin: number;
  xMax: number;
  y: number;
}
export function studyWalkPlan(p: StudyWalkParams = STUDY_WALK): StudyWalkPlan {
  const cycleMs = STUDY_MOTIONS.walk.durationMs;
  const stride = p.strideBody * p.bodyRatio;
  const span = stride * p.cycles;
  const legMs = p.cycles * cycleMs;
  return { cycles: p.cycles, cycleMs, legMs, restMs: p.restMs, slotMs: legMs + p.restMs, stride, xMin: p.xCenter - span / 2, xMax: p.xCenter + span / 2, y: p.y };
}

export type Facing = 'left' | 'right';
export interface StudyPose {
  sheet: DrawSheet;
  frame: number;
  /** 足元の中心（部屋に対する比率） */
  x: number;
  y: number;
  /** 'left' が原画の向き。'right' は左右反転 */
  facing: Facing;
  moving: boolean;
}

/** 右端から左へ歩き、止まって休み（休みの後半で向きを変える）、反対へ歩く。向きの反転は止まっている間だけ */
export function walkPoseAt(t: number, plan: StudyWalkPlan = studyWalkPlan()): StudyPose {
  const tt = Math.max(0, t);
  const k = Math.floor(tt / plan.slotMs);
  const r = tt - k * plan.slotMs;
  const goingLeft = k % 2 === 0;
  const span = plan.xMax - plan.xMin;
  if (r < plan.legMs) {
    const prog = r / plan.legMs;
    const x = goingLeft ? plan.xMax - span * prog : plan.xMin + span * prog;
    const frame = Math.floor(r / frameMs('walk') + EPS_FRAME) % STUDY_MOTIONS.walk.frameCount;
    return { sheet: 'walkV4', frame, x, y: plan.y, facing: goingLeft ? 'left' : 'right', moving: true };
  }
  // 休み: 最初の240msは settle 6枚（足を下げる）、最後の240msは start 6枚（足を上げる）、その間は idle。位置は休み中動かさない
  const x = goingLeft ? plan.xMin : plan.xMax;
  const rr = r - plan.legMs;
  const turned = rr >= plan.restMs / 2;
  const nextLeft = turned ? !goingLeft : goingLeft;
  const facing: Facing = nextLeft ? 'left' : 'right';
  const top = WALK_V4_TRANSITION_FRAMES - 1;
  if (rr < WALK_V4_TRANSITION_MS) {
    const frame = Math.min(top, Math.floor(rr / WALK_V4_TRANSITION_FRAME_MS + EPS_FRAME));
    return { sheet: 'walkV4Settle', frame, x, y: plan.y, facing, moving: false };
  }
  const startAt = plan.restMs - WALK_V4_TRANSITION_MS;
  if (rr >= startAt) {
    const frame = Math.min(top, Math.floor((rr - startAt) / WALK_V4_TRANSITION_FRAME_MS + EPS_FRAME));
    return { sheet: 'walkV4Start', frame, x, y: plan.y, facing, moving: false };
  }
  return { sheet: STAND_SHEET, frame: STAND_FRAME, x, y: plan.y, facing, moving: false };
}

/** 歩行のコマ送りが止まる時刻（1スロット内）。歩行コマの頭＋休みの settle 6枚＋idle＋向きを変える時刻＋start 6枚 */
export function walkBounds(plan: StudyWalkPlan = studyWalkPlan()): number[] {
  const out: number[] = [];
  const n = plan.cycles * STUDY_MOTIONS.walk.frameCount;
  for (let i = 0; i < n; i++) out.push(i * frameMs('walk'));
  for (let i = 0; i < WALK_V4_TRANSITION_FRAMES; i++) out.push(plan.legMs + i * WALK_V4_TRANSITION_FRAME_MS);
  out.push(plan.legMs + WALK_V4_TRANSITION_MS, plan.legMs + plan.restMs / 2);
  for (let i = 0; i < WALK_V4_TRANSITION_FRAMES; i++) out.push(plan.legMs + plan.restMs - WALK_V4_TRANSITION_MS + i * WALK_V4_TRANSITION_FRAME_MS);
  return out;
}

/** 歩行の1コマ前/次。表示が変わる点を1つずつ進む（立ち姿の休みと向き替えも1手ずつ） */
export function walkStep(t: number, dir: 1 | -1, plan: StudyWalkPlan = studyWalkPlan()): number {
  const bounds = walkBounds(plan);
  const tt = Math.max(0, t);
  const k = Math.floor(tt / plan.slotMs);
  const r = tt - k * plan.slotMs;
  let i = 0;
  while (i + 1 < bounds.length && bounds[i + 1]! <= r + EPS_MS) i++;
  if (dir === 1) return i + 1 < bounds.length ? k * plan.slotMs + bounds[i + 1]! : (k + 1) * plan.slotMs;
  if (i > 0) return k * plan.slotMs + bounds[i - 1]!;
  return k === 0 ? 0 : (k - 1) * plan.slotMs + bounds[bounds.length - 1]!;
}

// ---------- 共通 ----------

/** 動き m の経過時刻 t での表示（シート・コマ・位置・向き） */
export function studyPoseAt(m: StudyMotion, t: number): StudyPose {
  if (m === 'walk') return walkPoseAt(t);
  const d = STUDY_MOTIONS[m];
  return { sheet: d.sheet, frame: frameIndexAt(m, t), x: STUDY_FIXED.x, y: STUDY_FIXED.y, facing: 'left', moving: false };
}

/** 1コマ前/次の時刻。一度きりの動きは両端で止まる。コマは飛ばさない */
export function stepStudy(m: StudyMotion, t: number, dir: 1 | -1): number {
  if (m === 'walk') return walkStep(t, dir);
  const n = STUDY_MOTIONS[m].frameCount;
  const next = Math.min(Math.max(frameIndexAt(m, t) + dir, 0), n - 1);
  return frameStartMs(m, next);
}

// ---------- 表示の大きさ ----------

/** 部屋の中の倍率。各シートの referenceWidth を部屋幅の bodyRatio に合わせる（シート内は全コマ共通・コマごとの拡縮なし） */
export const roomScale = (S: number, referenceWidth: number, bodyRatio: number = STUDY_WALK.bodyRatio): number => (bodyRatio * S) / referenceWidth;

/** 全コマが maxW×maxH に収まる共通倍率（拡大表示用） */
export function fitScale(a: SizedAtlas, maxW: number, maxH: number): number {
  const e = extentAt(a, 1);
  return Math.min(maxW / e.w, maxH / e.h);
}

export interface AnchoredAtlas extends SizedAtlas {
  frames: { rect: number[]; anchor: number[] }[];
}
/** 足元の anchor を枠の中央に置いたとき、左右反転でも全コマの左右が出ない片側の最大幅（尾の見切れ確認用） */
export const anchorHalfWidth = (a: AnchoredAtlas): number =>
  Math.max(...a.frames.map((f) => Math.max(f.anchor[0]!, f.rect[2]! - f.anchor[0]!)));

/** 足元の anchor を枠の横中央に置いても、全コマ・左右反転の両方で maxW×maxH に収まる共通倍率 */
export function fitScaleCentered(a: AnchoredAtlas, maxW: number, maxH: number): number {
  const e = extentAt(a, 1);
  return Math.min(maxW / (2 * anchorHalfWidth(a)), maxH / e.h);
}
