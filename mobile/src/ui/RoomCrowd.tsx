import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { FLOOR_POLYGON } from '../state/furniture';
import { Walker, clipOf, motionLabel, spriteRect, type CharMotion, type Env, type Rect, type WalkerState } from '../state/roomMotion';
import { imageOf } from './motionCatalog';
import { useClipsReady, type ClipsStatus } from './useClips';

interface Opts {
  obstacles: Rect[];
  /** false の間は歩き出さず待機（編集中・非表示・動きを減らす・家具を避けられない風景） */
  canWalk: boolean;
  /** false なら時計を止め、待機の最初のコマに戻す（歩きコマだけ回さない・復帰時に時間を取り戻さない） */
  run: boolean;
}

const TICK_MS = 80;
const MAX_DT = 120;

const key = (s: WalkerState) => `${s.phase}|${s.dir}|${s.clip}|${s.frame}|${Math.round(s.x * 2000)}`;

/**
 * 同室の最大3体を、1つの時計で動かす。選択が替わると前の個体の時計は破棄し、新しい個体を現在位置から始める。
 * 動きは全身画像の切替と地上座標の移動だけ。
 */
export function useCrowd(chars: CharMotion[], starts: { x: number; y: number }[], opts: Opts): { states: WalkerState[]; status: ClipsStatus; retry: () => void } {
  // この3体のクリップの画像がそろうまで時計を進めない（準備前は各個体の待機の最初のコマのまま。別の個体の絵で代替しない）
  const clips = useClipsReady(chars, (c) => Object.keys(c.clips));
  const ids = chars.map((c) => c.id).join(',');
  const optsRef = useRef(opts);
  const ready = clips.status === 'ready';
  optsRef.current = { ...opts, canWalk: opts.canWalk && ready, run: opts.run && ready };
  const walkers = useMemo(() => chars.map((c, i) => new Walker(c, starts[i]!, 1000 + i * 7919 + c.id.length * 31)), [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const [states, setStates] = useState<WalkerState[]>(() => walkers.map((w) => w.state()));
  const envFor = (i: number, current: WalkerState[]): Env => ({
    poly: FLOOR_POLYGON,
    obstacles: optsRef.current.obstacles,
    canWalk: optsRef.current.canWalk,
    others: current.filter((_, j) => j !== i).map((s, j) => ({ x: s.x, y: s.y, halfW: chars[j >= i ? j + 1 : j]!.roomWidth * 0.3 })),
  });

  // 個体が替わったら新しい歩行者で作り直す。家具の中なら空き床へ移す
  useEffect(() => {
    const cur = walkers.map((w) => w.state());
    walkers.forEach((w, i) => w.relocate(envFor(i, cur)));
    setStates(walkers.map((w) => w.state()));
  }, [walkers]); // eslint-disable-line react-hooks/exhaustive-deps

  const sig = opts.obstacles.map((o) => `${o.l},${o.t},${o.r},${o.b}`).join(';');
  useEffect(() => {
    // 家具が動いたあと、立ち止まっている個体が家具の中なら空き床へ
    const cur = walkers.map((w) => w.state());
    let moved = false;
    walkers.forEach((w, i) => {
      if (cur[i]!.phase === 'idle' && w.relocate(envFor(i, cur))) moved = true;
    });
    if (moved) setStates(walkers.map((w) => w.state()));
  }, [sig, walkers]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!opts.run || !ready) {
      walkers.forEach((w) => w.settle());
      setStates(walkers.map((w) => w.state()));
      return;
    }
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(now - last, MAX_DT); // 長い空白(タブが隠れていた等)は取り戻さない
      last = now;
      const cur = walkers.map((w) => w.state());
      walkers.forEach((w, i) => w.step(dt, envFor(i, cur)));
      const next = walkers.map((w) => w.state());
      setStates((prev) => (prev.length === next.length && prev.every((p, i) => key(p) === key(next[i]!)) ? prev : next));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [walkers, opts.run, opts.canWalk, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return { states, status: clips.status, retry: clips.retry };
}

/** 部屋の中の1体。足元の座標(部屋に対する割合)と、いまのクリップ/コマの全身画像だけで描く */
export function RoomCreature({ char, state, S, z }: { char: CharMotion; state: WalkerState; S: number; z: number }) {
  const label = motionLabel(char, state);
  const clip = clipOf(char, state.clip);
  const frame = clip.frames[Math.min(state.frame, clip.frames.length - 1)]!;
  const r = spriteRect(char, clip, S, { x: state.x * S, y: state.y * S });
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ position: 'absolute', left: r.left, top: r.top, width: r.side, height: r.side, zIndex: z }}
    >
      <Image source={imageOf(frame.file)} resizeMode="stretch" style={{ width: r.side, height: r.side }} />
    </View>
  );
}
