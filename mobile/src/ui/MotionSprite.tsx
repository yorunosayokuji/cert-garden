import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { CompanionId } from '../state/notebook';
import { MOTION_ATLAS, MOTION_IMAGES } from './motionAssets';
import { REST_FRAME, SequencePlayer, commonScale, makeRng, reactionKindOf, reactionSteps } from './motionSeq';

export interface Reaction {
  cue: string;
  /** 同じ cue が続いても反応し直すための通番 */
  seq: number;
}

/** 連番のコマ番号を返す。enabled が false になった瞬間にタイマーを止め、休み姿勢に戻す */
export function useSpriteFrame(id: CompanionId, enabled: boolean, phaseIndex: number, reaction?: Reaction | null): number {
  const [frame, setFrame] = useState(REST_FRAME);
  const playerRef = useRef<SequencePlayer | null>(null);
  const randRef = useRef(makeRng(1234 + phaseIndex * 977));
  const seenSeq = useRef(reaction?.seq ?? 0); // マウント前の反応は再生しない

  useEffect(() => {
    if (!enabled) {
      setFrame(REST_FRAME);
      return;
    }
    const p = new SequencePlayer(id, phaseIndex, randRef.current, setFrame);
    playerRef.current = p;
    p.start();
    return () => {
      p.stop();
      playerRef.current = null;
    };
  }, [id, enabled, phaseIndex]);

  useEffect(() => {
    if (!reaction || reaction.seq === seenSeq.current) return;
    seenSeq.current = reaction.seq;
    const kind = reactionKindOf(reaction.cue);
    if (kind) playerRef.current?.inject(reactionSteps(id, kind, randRef.current));
  }, [reaction, id]);

  return frame;
}

interface Props {
  id: CompanionId;
  frame: number;
  /** 表示最大幅(px)。全コマ共通の拡大率 = これ / referenceWidth */
  targetWidth: number;
  /** 高さの上限(px)。指定しても拡大率は全コマ共通のまま */
  maxHeight?: number;
  /** 親の絶対座標での足元（コマの下端中央） */
  ground: { x: number; y: number };
  label?: string;
}

/** manifest の rect/anchor でコマを切り抜いて描く。4×3の均等割りはしない */
export function MotionSprite({ id, frame, targetWidth, maxHeight, ground, label }: Props) {
  const atlas = MOTION_ATLAS[id];
  const f = atlas.frames[frame] ?? atlas.frames[REST_FRAME]!;
  const s = commonScale(atlas, targetWidth, maxHeight);
  const [rx, ry, rw, rh] = f.rect as [number, number, number, number];
  const [ax, ay] = f.anchor as [number, number];
  return (
    <View
      pointerEvents="none"
      accessible={!!label}
      accessibilityLabel={label}
      accessibilityRole={label ? 'image' : undefined}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      style={[styles.box, { left: ground.x - ax * s, top: ground.y - ay * s, width: rw * s, height: rh * s }]}
    >
      <Image
        source={MOTION_IMAGES[id]}
        resizeMode="stretch"
        accessibilityElementsHidden
        style={{ position: 'absolute', width: atlas.width * s, height: atlas.height * s, left: -rx * s, top: -ry * s }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ box: { position: 'absolute', overflow: 'hidden' } });
