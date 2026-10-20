import { Animated, Image, StyleSheet, View } from 'react-native';
import { ATLAS_IMAGES, CELL, COLS, ROWS, anchorOf, type Pose } from './assets';
import type { CompanionId } from '../state/notebook';

interface Props {
  id: CompanionId;
  pose: Pose;
  /** 3列2行の1セルを描く正方形の一辺(px) */
  size: number;
  /** 親の絶対座標で「足元」を置く位置。指定するとポーズ別 anchor で補正する */
  ground?: { x: number; y: number };
  transform?: Animated.WithAnimatedValue<any>[];
  label?: string;
}

/**
 * アトラス(512セル×3列2行)から1ポーズを切り出す。画像は手描きの独立ポーズ差分で、連番アニメではない。
 * ground を渡すと、ポーズ別の anchor(足元)がその点に来るよう位置を補正する。
 */
export function Sprite({ id, pose, size, ground, transform, label }: Props) {
  const a = anchorOf(id, pose);
  const scale = size / CELL;
  const col = a.index % COLS;
  const row = Math.floor(a.index / COLS);
  const place = ground ? { left: ground.x - a.x * scale, top: ground.y - a.y * scale } : { left: 0, top: 0 };
  return (
    <Animated.View
      pointerEvents="none"
      accessible={!!label}
      accessibilityLabel={label}
      accessibilityRole={label ? 'image' : undefined}
      style={[styles.cell, { width: size, height: size, ...place }, transform ? { transform: transform as any } : null]}
    >
      <View style={{ width: size, height: size, overflow: 'hidden' }}>
        <Image
          source={ATLAS_IMAGES[id]}
          resizeMode="stretch"
          style={{ width: size * COLS, height: size * ROWS, marginLeft: -col * size, marginTop: -row * size }}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ cell: { position: 'absolute' } });
