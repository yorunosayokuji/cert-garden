// 全26体の全身連番を、部屋の床で「待機→歩く→止まる→待機」させるための純粋なロジック（画像・RNに依存しない）。
// 動きは全身画像の切替と、地上座標X/Yの移動だけ。パーツ変形・反転・拡縮・上下揺れ・逆再生はしない。
// 数値の正本は design-assets/app-completion-20261020/runtime-motion-catalog-v2.json（参照元の索引は試験で突き合わせる）。

export const CANVAS = 512;
export type Dir = 'left' | 'right';

export interface MotionFrame {
  file: string;
  ms: number;
  bbox?: number[];
}
export interface MotionClip {
  frames: MotionFrame[];
  /** 元512px座標での足元（このクリップの全コマ共通） */
  anchor: [number, number];
  loop?: boolean;
  /** コマごとの前進の割合（索引にある個体だけ。踏切・空中だけ進み、接地のコマは0）。無ければ時間に比例して一定 */
  travelWeights?: number[];
}
export interface CharMotion {
  id: string;
  name: string;
  kind: string;
  nativeFacing: string;
  /** 部屋の幅に対する、1体の基準の見える幅 */
  roomWidth: number;
  /** 画像の基準の見える幅(px, 512座標)。コマごとのbboxで幅を合わせ直さない */
  referenceWidth: number;
  /** 1サイクル(歩行クリップ1周)で進む距離 = strideRatio × 見える幅 */
  strideRatio: number;
  clips: Record<string, MotionClip>;
}
export interface MotionCatalog {
  characters: CharMotion[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 索引を検査して読む。足りない・壊れた索引は黙って通さず例外にする */
export function parseCatalog(raw: unknown): MotionCatalog {
  const o = raw as { characters?: unknown } | null;
  if (!o || !Array.isArray(o.characters) || o.characters.length === 0) throw new Error('動きの索引に個体がありません');
  const seen = new Set<string>();
  const characters = o.characters.map((c: Record<string, unknown>): CharMotion => {
    const id = String(c.id);
    if (seen.has(id)) throw new Error(`個体の重複: ${id}`);
    seen.add(id);
    if (!isNum(c.roomWidth) || c.roomWidth <= 0 || !isNum(c.referenceWidth) || c.referenceWidth <= 0 || !isNum(c.strideRatio) || c.strideRatio <= 0) throw new Error(`${id}: 幅/歩幅の指定が不正`);
    const clipsRaw = c.clips as Record<string, { frames?: unknown; anchor?: unknown; loop?: unknown }> | undefined;
    if (!clipsRaw) throw new Error(`${id}: クリップがありません`);
    const clips: Record<string, MotionClip> = {};
    for (const [name, k] of Object.entries(clipsRaw)) {
      const a = k.anchor as unknown[];
      if (!Array.isArray(k.frames) || k.frames.length === 0 || !Array.isArray(a) || !isNum(a[0]) || !isNum(a[1]) || a[0] < 0 || a[0] > CANVAS || a[1] < 0 || a[1] > CANVAS) throw new Error(`${id}/${name}: コマかanchorが不正`);
      const frames = (k.frames as Record<string, unknown>[]).map((f) => {
        if (typeof f.file !== 'string' || !isNum(f.ms) || f.ms <= 0) throw new Error(`${id}/${name}: コマの定義が不正`);
        return { file: f.file, ms: f.ms, ...(Array.isArray(f.bbox) ? { bbox: f.bbox as number[] } : {}) };
      });
      const tw = (k as { travelWeights?: unknown }).travelWeights;
      if (tw !== undefined) {
        if (!Array.isArray(tw) || tw.length !== frames.length || !tw.every((v) => isNum(v) && v >= 0) || !(tw as number[]).some((v) => v > 0)) throw new Error(`${id}/${name}: travelWeights が不正`);
      }
      clips[name] = { frames, anchor: [a[0], a[1]], ...(k.loop === true ? { loop: true } : {}), ...(tw ? { travelWeights: (tw as number[]).slice() } : {}) };
    }
    for (const need of ['idle', 'walk_left', 'walk_right']) if (!clips[need]) throw new Error(`${id}: ${need} がありません`);
    return {
      id, name: String(c.name), kind: String(c.kind), nativeFacing: String(c.nativeFacing), roomWidth: c.roomWidth, referenceWidth: c.referenceWidth, strideRatio: c.strideRatio, clips,
    };
  });
  return { characters };
}

/** 移動のことば。個体の種類に合わせる（脚のない・飛ぶ・跳ねる個体を「歩く」と言わない） */
export function moveWord(kind: string): string {
  if (kind === 'hopper') return 'はねて';
  if (/float/.test(kind)) return 'ふわふわと';
  if (/fly/.test(kind)) return 'とんで';
  return 'すすんで';
}

/** クリップ名の表示（通常は「左へすすむ」など共通語。確認画面のボタンにも使う） */
export function clipLabel(name: string): string {
  const dir = name.endsWith('_left') ? '左' : name.endsWith('_right') ? '右' : '';
  if (name === 'idle') return '待機';
  if (name.startsWith('walk')) return `${dir}へすすむ`;
  if (name.startsWith('start')) return `うごきだし（${dir}）`;
  if (name.startsWith('stop')) return `とまる（${dir}）`;
  return name;
}

/** 箱庭の画像の説明。実際の待機/移動/停止に合わせる */
export function motionLabel(c: CharMotion, s: { phase: string; dir: string }): string {
  const dir = s.dir === 'right' ? '右' : '左';
  if (s.phase === 'walk') return `${c.name}が${dir}へ${moveWord(c.kind)}います`;
  if (s.phase === 'start') return `${c.name}がうごきだそうとしています`;
  if (s.phase === 'stop') return `${c.name}がとまろうとしています`;
  return `${c.name}がくつろいでいます`;
}

export const clipOf = (c: CharMotion, name: string): MotionClip => c.clips[name] ?? c.clips.idle!;
export const clipDuration = (clip: MotionClip) => clip.frames.reduce((n, f) => n + f.ms, 0);

/** 1体の描画寸法。見える幅は部屋幅×roomWidth、画像は referenceWidth で換算する（コマごとのbboxで合わせない）。足元は clip.anchor */
export function spriteRect(c: CharMotion, clip: MotionClip, roomPx: number, ground: { x: number; y: number }) {
  const side = (c.roomWidth * roomPx * CANVAS) / c.referenceWidth;
  return { side, left: ground.x - (side * clip.anchor[0]) / CANVAS, top: ground.y - (side * clip.anchor[1]) / CANVAS };
}

/** 机の帯などの小さな枠: 見える幅 targetWidth(px) を基準に、足元より上の高さが maxHeight を超えるときだけ共通倍率で縮める */
export function fittedRect(c: CharMotion, clip: MotionClip, targetWidth: number, maxHeight: number | undefined, ground: { x: number; y: number }) {
  let side = (targetWidth * CANVAS) / c.referenceWidth;
  const top = clip.frames[0]?.bbox?.[1] ?? 0;
  const above = ((clip.anchor[1] - top) / CANVAS) * side;
  if (maxHeight !== undefined && above > maxHeight && above > 0) side *= maxHeight / above;
  return { side, left: ground.x - (side * clip.anchor[0]) / CANVAS, top: ground.y - (side * clip.anchor[1]) / CANVAS };
}

/** 時刻(ms)に対するコマ番号。ループなら周回、そうでなければ最後のコマで止まる */
export function frameAt(clip: MotionClip, t: number, loop = true): number {
  const total = clipDuration(clip);
  let u = loop ? ((t % total) + total) % total : Math.min(Math.max(t, 0), total - 1e-9);
  for (let i = 0; i < clip.frames.length; i++) {
    u -= clip.frames[i]!.ms;
    if (u < 0) return i;
  }
  return clip.frames.length - 1;
}

// ---------------- 床の通行 ----------------
export type Pt = [number, number];
export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** 床の多角形のYでの横の範囲（凸でなくても外側の範囲）。Yが範囲外なら null */
export function spanAt(poly: Pt[], y: number): [number, number] | null {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi === yj) continue;
    if ((y >= Math.min(yi, yj)) && (y <= Math.max(yi, yj))) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
  }
  if (xs.length < 2) return null;
  return [Math.min(...xs), Math.max(...xs)];
}

export interface Body {
  x: number;
  y: number;
  /** 足元の左右の半幅（部屋に対する割合） */
  halfW: number;
}

/** このYで立てる横の区間（床の中、家具の膨らませた足元と他の個体を避けた範囲）。短い水平移動の通れる区間 */
export function freeIntervals(poly: Pt[], y: number, halfW: number, depth: number, obstacles: Rect[], others: Body[], margin = 0.02): [number, number][] {
  const span = spanAt(poly, y);
  if (!span) return [];
  let free: [number, number][] = [[span[0] + halfW, span[1] - halfW]];
  const blocks: [number, number][] = [];
  for (const o of obstacles) {
    if (y >= o.t - depth && y <= o.b + depth) blocks.push([o.l - halfW, o.r + halfW]);
  }
  for (const b of others) {
    if (Math.abs(b.y - y) < 0.05) blocks.push([b.x - b.halfW - halfW - margin, b.x + b.halfW + halfW + margin]);
  }
  for (const [bl, br] of blocks) {
    const next: [number, number][] = [];
    for (const [l, r] of free) {
      if (br <= l || bl >= r) next.push([l, r]);
      else {
        if (bl > l) next.push([l, bl]);
        if (br < r) next.push([br, r]);
      }
    }
    free = next;
  }
  return free.filter(([l, r]) => r - l > 1e-6);
}

export const intervalOf = (x: number, free: [number, number][]) => free.find(([l, r]) => x >= l - 1e-9 && x <= r + 1e-9) ?? null;

/** 最も近い立てる位置（空きが無ければ null） */
export function nearestFree(x: number, free: [number, number][]): number | null {
  let best: number | null = null;
  let bd = Infinity;
  for (const [l, r] of free) {
    const c = Math.min(Math.max(x, l), r);
    if (Math.abs(c - x) < bd) {
      bd = Math.abs(c - x);
      best = c;
    }
  }
  return best;
}

// ---------------- 歩く個体 ----------------
function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Phase = 'idle' | 'start' | 'walk' | 'stop';
export interface WalkerState {
  phase: Phase;
  dir: Dir;
  clip: string;
  frame: number;
  x: number;
  y: number;
}
export interface Env {
  poly: Pt[];
  obstacles: Rect[];
  others: Body[];
  /** false の間は歩き出さない（編集中・非表示・動きを減らす・家具のない風景など） */
  canWalk: boolean;
}

/**
 * 歩行1周の各コマに割り当てる前進の重み(合計1)。索引に travelWeights があるクリップ（ラベンダーの左右）はそれを使い、
 * 接地のコマ（重み0）ではその場に留める。重みの無い個体だけ、コマの時間に比例して一定に進む。仮の曲線は使わない。
 */
export function strideWeights(_c: CharMotion, clip: MotionClip): number[] {
  if (clip.travelWeights) {
    const s = clip.travelWeights.reduce((a, b) => a + b, 0);
    return clip.travelWeights.map((v) => v / s);
  }
  const total = clipDuration(clip);
  return clip.frames.map((f) => f.ms / total);
}

const MIN_IDLE = 2500;
const IDLE_SPAN = 4500;
const MAX_CYCLES = 3;

export class Walker {
  readonly char: CharMotion;
  private s: WalkerState;
  private rand: () => number;
  private t = 0; // 現在のクリップ内の経過(ms)
  private idleLeft: number;
  private cyclesLeft = 0;
  private walkTotal = 0;

  constructor(char: CharMotion, start: { x: number; y: number }, seed: number) {
    this.char = char;
    this.rand = rng(seed);
    this.s = { phase: 'idle', dir: 'left', clip: 'idle', frame: 0, x: start.x, y: start.y };
    this.idleLeft = MIN_IDLE + this.rand() * IDLE_SPAN * 0.5;
  }
  state(): WalkerState {
    return { ...this.s };
  }
  private halfW() {
    return this.char.roomWidth * 0.3;
  }
  private free(env: Env): [number, number][] {
    return freeIntervals(env.poly, this.s.y, this.halfW(), 0.02, env.obstacles, env.others);
  }

  /** 開始位置や家具が動いたあと、家具の中にいれば空き床へ移す（立ち止まっているときだけ）。全区間が塞がっていれば動かさない */
  relocate(env: Env): boolean {
    const free = this.free(env);
    if (intervalOf(this.s.x, free)) return false;
    const n = nearestFree(this.s.x, free);
    if (n === null) return false;
    this.s.x = n;
    return true;
  }

  /** 止まって待機に戻す（隠れた・停止した・編集中）。再開時に隠れていた時間を取り戻さない */
  settle() {
    this.s = { ...this.s, phase: 'idle', clip: 'idle', frame: 0 };
    this.t = 0;
    this.cyclesLeft = 0;
  }

  private enter(phase: Phase, clip: string) {
    this.s.phase = phase;
    this.s.clip = clip;
    this.s.frame = 0;
    this.t = 0;
  }

  /** dtMs だけ進める。呼び出し側は大きな dt を渡さない（復帰時は settle して dt を捨てる） */
  step(dtMs: number, env: Env) {
    let left = Math.max(0, dtMs);
    let guard = 0;
    while (left > 1e-6 && guard++ < 64) {
      const clip = clipOf(this.char, this.s.clip);
      if (this.s.phase === 'idle') {
        const use = Math.min(left, this.idleLeft);
        this.t += use;
        this.idleLeft -= use;
        left -= use;
        this.s.frame = frameAt(clip, this.t);
        if (this.idleLeft <= 1e-6) this.beginWalk(env);
        continue;
      }
      const phase: Phase = this.s.phase;
      const total = clipDuration(clip);
      const remain = phase === 'walk' ? total - (this.t % total) : total - this.t;
      const use = Math.min(left, remain);
      if (phase === 'walk' && !this.advance(use, clip, env)) {
        left -= use;
        this.finishWalk(); // 壁・家具・他の個体の手前で止まる
        continue;
      }
      this.t += use;
      left -= use;
      this.s.frame = frameAt(clip, this.t, phase === 'walk');
      if (phase === 'walk') {
        // 歩行1周を終えたところで数える。周の途中では止めない（止まるコマで急に姿勢が変わらないように）
        if (use >= remain - 1e-6) {
          this.cyclesLeft -= 1;
          if (this.cyclesLeft <= 0) this.finishWalk();
        }
      } else if (this.t >= total - 1e-6) {
        if (phase === 'start') this.enter('walk', `walk_${this.s.dir}`);
        else this.toIdle();
      }
    }
  }

  private toIdle() {
    this.enter('idle', 'idle');
    this.idleLeft = MIN_IDLE + this.rand() * IDLE_SPAN;
  }

  private finishWalk() {
    const stop = `stop_${this.s.dir}`;
    if (this.char.clips[stop]) this.enter('stop', stop);
    else this.toIdle();
  }

  private beginWalk(env: Env) {
    const rest = () => {
      this.idleLeft = MIN_IDLE + this.rand() * IDLE_SPAN; // 待機の続き（待機コマは巻き戻さない）
    };
    if (!env.canWalk) return rest();
    this.relocate(env);
    const free = this.free(env);
    const iv = intervalOf(this.s.x, free);
    const stride = this.char.strideRatio * this.char.roomWidth;
    if (!iv) return rest();
    const roomL = Math.floor((this.s.x - iv[0]) / stride);
    const roomR = Math.floor((iv[1] - this.s.x) / stride);
    const options: Dir[] = [];
    if (roomL >= 1) options.push('left');
    if (roomR >= 1) options.push('right');
    if (options.length === 0) return rest(); // 通れる区間が無ければ待機のまま
    const dir = options[Math.floor(this.rand() * options.length)]!;
    const max = Math.min(MAX_CYCLES, dir === 'left' ? roomL : roomR);
    this.cyclesLeft = 1 + Math.floor(this.rand() * max);
    this.walkTotal = this.cyclesLeft;
    this.s.dir = dir;
    const start = `start_${dir}`;
    if (this.char.clips[start]) this.enter('start', start);
    else this.enter('walk', `walk_${dir}`);
  }

  /** 歩行コマの時間 use だけ前進。壁・家具・他の個体に当たる位置までで止める（false なら止まる） */
  private advance(use: number, clip: MotionClip, env: Env): boolean {
    const stride = this.char.strideRatio * this.char.roomWidth;
    const w = strideWeights(this.char, clip);
    const total = clipDuration(clip);
    // この区間 [t, t+use] に含まれる各コマの前進量
    let dist = 0;
    let a = this.t % total;
    let remaining = use;
    for (let i = 0; i < clip.frames.length && remaining > 1e-9; i++) {
      const f = clip.frames[i]!;
      const end = clip.frames.slice(0, i + 1).reduce((n, g) => n + g.ms, 0);
      if (a >= end - 1e-9) continue;
      const part = Math.min(remaining, end - a);
      dist += stride * w[i]! * (part / f.ms);
      remaining -= part;
      a += part;
    }
    const sign = this.s.dir === 'right' ? 1 : -1;
    const nx = this.s.x + sign * dist;
    const free = this.free(env);
    const iv = intervalOf(this.s.x, free);
    if (!iv) return false;
    if (nx < iv[0] || nx > iv[1]) {
      this.s.x = Math.min(Math.max(nx, iv[0]), iv[1]);
      return false;
    }
    this.s.x = nx;
    return true;
  }
}
