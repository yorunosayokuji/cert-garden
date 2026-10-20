import { useEffect, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { characterName, type CharacterId } from '../state/characters';
import { clipOf, fittedRect } from '../state/roomMotion';
import { SEED_IMAGES } from './characterAssets';
import { charMotion, imageOf } from './motionCatalog';
import { useClipsReady } from './useClips';

/** 待機の連番コマ番号。run が false になった瞬間にタイマーを止め、最初のコマ（休み姿勢）に戻す。選択が替わると前の時計は破棄する */
export function useIdleFrame(id: CharacterId, run: boolean, offset = 0): number {
  const c = charMotion(id);
  const clip = c ? clipOf(c, 'idle') : undefined;
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!clip || !run || clip.frames.length < 2) {
      setI(0);
      return;
    }
    let idx = offset % clip.frames.length;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      setI(idx);
      t = setTimeout(() => {
        idx = (idx + 1) % clip.frames.length;
        tick();
      }, clip.frames[idx]!.ms);
    };
    tick();
    return () => clearTimeout(t);
  }, [id, clip, run, offset]);
  return i;
}

interface Props {
  id: CharacterId;
  /** 基準の見える幅(px)。画像は個体ごとの referenceWidth で換算する */
  width: number;
  /** 足元より上の高さの上限(px)。超えるときだけ共通倍率で縮める */
  maxHeight?: number;
  /** 親の絶対座標での足元 */
  ground: { x: number; y: number };
  run: boolean;
  offset?: number;
  label?: string;
  z?: number;
}

/**
 * 学習の机・初回チェックの相棒。待機の全身連番を切り替えるだけ（他キャラの絵で代用しない・反転・上下揺れ・変形はしない）。
 * 寸法は索引の referenceWidth と clip.anchor。コマごとのbboxで幅を合わせ直さない。
 */
export function CharacterSprite({ id, width, maxHeight, ground, run, offset = 0, label, z }: Props) {
  const c = charMotion(id);
  // 待機の画像がそろうまで時計を進めない（準備前はこの個体の最初のコマのまま。別の個体の絵は出さない）
  const { status } = useClipsReady(c ? [c] : [], () => ['idle']);
  const frameIdx = useIdleFrame(id, run && status === 'ready', offset);
  if (!c) {
    // 索引に無い個体は原画の静止画で表示する（動きは付けない）
    return (
      <View pointerEvents="none" accessible={!!label} accessibilityLabel={label ?? characterName(id)} style={[styles.box, { left: ground.x - width / 2, top: ground.y - width, width, height: width }]}>
        <Image source={SEED_IMAGES[id]} resizeMode="contain" style={{ width, height: width }} />
      </View>
    );
  }
  const clip = clipOf(c, 'idle');
  const r = fittedRect(c, clip, width, maxHeight, ground);
  const frame = clip.frames[Math.min(frameIdx, clip.frames.length - 1)]!;
  return (
    <View
      pointerEvents="none"
      accessible={!!label}
      accessibilityLabel={label ?? characterName(id)}
      accessibilityRole={label ? 'image' : undefined}
      style={[styles.box, { left: r.left, top: r.top, width: r.side, height: r.side }, z !== undefined ? { zIndex: z } : null]}
    >
      <Image source={imageOf(frame.file)} resizeMode="stretch" style={{ width: r.side, height: r.side }} />
    </View>
  );
}

const styles = StyleSheet.create({ box: { position: 'absolute' } });
