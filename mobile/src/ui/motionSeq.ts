// 連番アニメの純粋ロジック（React/画像に依存しない）。motion-v2 の12コマを、動作→休みの順で再生する計画を作る。
import type { CompanionId } from '../state/notebook.ts';

export interface Step {
  frame: number;
  ms: number;
}
export type Rand = () => number;

export const REST_FRAME = 0;
/** 動作1コマ 120–180ms、まばたきだけ 80–120ms */
export const MOVE_MS: [number, number] = [120, 180];
export const BLINK_MS: [number, number] = [80, 120];
/** 静止 3–6秒、眠りの保持 4–7秒 */
export const HOLD_MS: [number, number] = [3000, 6000];
export const SLEEP_HOLD_MS: [number, number] = [4000, 7000];
/** 反応のあと次の周期へ戻るまでの短い休み */
export const AFTER_REACTION_MS = 1600;

export function makeRng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: Rand, [lo, hi]: [number, number]) => Math.round(lo + (hi - lo) * r());
const play = (frames: number[], r: Rand, range: [number, number]): Step[] => frames.map((frame) => ({ frame, ms: between(r, range) }));

export type ClipName = 'blink' | 'flutter' | 'wave' | 'stretch' | 'sleepBack' | 'sleepYawn';

/** 休み姿勢(0)から出て隣接する姿勢だけを通り、0へ戻る */
const CLIPS: Record<CompanionId, Partial<Record<ClipName, { in: number[]; out?: number[]; blink?: boolean }>>> = {
  cream: {
    blink: { in: [1, 2, 3, 0], blink: true },
    // 0→4→…→7 と伏せて眠り、保持してから逆戻りで起きる
    sleepBack: { in: [4, 5, 6, 7], out: [6, 5, 4, 0] },
    // 眠ったあと起きてあくび(8–11)→座る(11→0)
    sleepYawn: { in: [4, 5, 6, 7], out: [8, 9, 10, 11, 0] },
  },
  lavender: {
    flutter: { in: [1, 2, 1, 3, 0] },
    wave: { in: [4, 5, 6, 5, 6, 7, 0] },
    // 8=眠そうな目、9→10=耳を閉じる。起きるときは逆戻りして 11(耳を戻す)→0
    sleepBack: { in: [8, 9, 10], out: [9, 8, 11, 0] },
  },
  apricot: {
    blink: { in: [1, 2, 3, 0], blink: true },
    stretch: { in: [4, 5, 6, 5, 7, 0] },
    sleepBack: { in: [8, 9, 10, 11], out: [10, 9, 8, 0] },
  },
};

const PLANS: Record<CompanionId, ClipName[]> = {
  cream: ['blink', 'blink', 'sleepBack', 'blink', 'blink', 'sleepYawn'],
  lavender: ['flutter', 'wave', 'flutter', 'sleepBack', 'flutter', 'wave'],
  apricot: ['blink', 'stretch', 'blink', 'sleepBack'],
};

export function clipFrames(id: CompanionId, name: ClipName): number[] {
  const c = CLIPS[id][name];
  return c ? [...c.in, ...(c.out ?? [])] : [];
}

/** n 番目の周期: 動作 → 休み(3–6秒)。眠る動作は保持4–7秒を挟む */
export function planCycle(id: CompanionId, n: number, r: Rand): Step[] {
  const plan = PLANS[id];
  const name = plan[n % plan.length]!;
  const c = CLIPS[id][name]!;
  const steps = play(c.in, r, c.blink ? BLINK_MS : MOVE_MS);
  if (c.out) {
    steps[steps.length - 1] = { frame: steps[steps.length - 1]!.frame, ms: between(r, SLEEP_HOLD_MS) };
    steps.push(...play(c.out, r, MOVE_MS));
  }
  // 最後は休み姿勢(0)で静止。clip の最終コマ(0)の表示時間そのものを静止として延ばす
  const last = steps[steps.length - 1]!;
  steps[steps.length - 1] = { frame: last.frame, ms: between(r, HOLD_MS) };
  return steps;
}

export type ReactionKind = 'welcome' | 'calm';

/** 正答確定→歓迎(紫wave/杏のび/クリームあくび)、誤答・不明→落ち着いたまばたき */
export function reactionSteps(id: CompanionId, kind: ReactionKind, r: Rand): Step[] {
  let steps: Step[];
  if (kind === 'welcome') {
    steps = id === 'lavender' ? play(CLIPS.lavender.wave!.in, r, MOVE_MS) : id === 'apricot' ? play(CLIPS.apricot.stretch!.in, r, MOVE_MS) : play([4, 8, 9, 10, 11, 0], r, MOVE_MS);
  } else {
    steps = id === 'lavender' ? play([8, 9, 8, 0], r, MOVE_MS) : play(CLIPS[id].blink!.in, r, BLINK_MS);
  }
  const last = steps[steps.length - 1]!;
  steps[steps.length - 1] = { frame: last.frame, ms: AFTER_REACTION_MS };
  return steps;
}

/** コアの cue → 反応。'cheer'/'celebrate'=歓迎、'encourage'=落ち着き。それ以外(idleなど)は反応なし */
export function reactionKindOf(cue: string): ReactionKind | null {
  if (cue === 'cheer' || cue === 'celebrate') return 'welcome';
  if (cue === 'encourage') return 'calm';
  return null;
}

/** 3体の開始位相。最初の動作までの待ちを体ごとにずらす */
export function initialDelay(phaseIndex: number, r: Rand): number {
  return 700 + phaseIndex * 1300 + Math.round(r() * 600);
}

/** タイマーを差し替えられる再生器。stop() 後は二度とコマを出さない */
export class SequencePlayer {
  private queue: Step[] = [];
  private timer: unknown = null;
  private n = 0;
  private running = false;
  private readonly id: CompanionId;
  private readonly phaseIndex: number;
  private readonly rand: Rand;
  private readonly onFrame: (frame: number) => void;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (h: unknown) => void;
  constructor(
    id: CompanionId,
    phaseIndex: number,
    rand: Rand,
    onFrame: (frame: number) => void,
    schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    cancel: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {
    this.id = id;
    this.phaseIndex = phaseIndex;
    this.rand = rand;
    this.onFrame = onFrame;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.queue = [{ frame: REST_FRAME, ms: initialDelay(this.phaseIndex, this.rand) }];
    this.onFrame(REST_FRAME);
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.queue = [];
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }

  /** 反応の一回再生。いまの動作を打ち切り、反応のあと通常の周期へ戻る */
  inject(steps: Step[]): void {
    if (!this.running) return;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.queue = steps.slice();
    this.tick();
  }

  private tick = (): void => {
    if (!this.running) return;
    if (this.queue.length === 0) this.queue = planCycle(this.id, this.n++, this.rand);
    const s = this.queue.shift()!;
    this.onFrame(s.frame);
    this.timer = this.schedule(this.tick, s.ms);
  };
}

interface AtlasLike {
  referenceWidth: number;
  frames: { index: number; rect: number[]; anchor: number[] }[];
}

/** 全フレーム共通の拡大率。表示最大幅 / referenceWidth（コマごとに正規化しない）。maxHeight があれば高さでも頭打ちにする */
export function commonScale(atlas: AtlasLike, targetWidth: number, maxHeight?: number): number {
  const byWidth = targetWidth / atlas.referenceWidth;
  if (maxHeight === undefined) return byWidth;
  const tallest = Math.max(...atlas.frames.map((f) => f.rect[3]!));
  return Math.min(byWidth, maxHeight / tallest);
}
