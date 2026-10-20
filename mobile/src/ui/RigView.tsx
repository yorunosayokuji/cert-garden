// native 用: 分節パーツを View/Image で重ねて描く（Web は RigView.web.tsx の canvas）。
// 回転の基点は View の中心ではなくパーツの関節なので、中心→基点の差で平行移動して回す。
import { Image, StyleSheet, View } from 'react-native';
import { RIG_ANCHOR, RIG_ATLAS, RIG_CANVAS, type DrawItem } from './gaitRig.ts';
import { RIG_IMAGE } from './motionStudyAssets';

export interface RigViewProps {
  items: DrawItem[];
  /** 論理px→画面px */
  scale: number;
  /** 親の絶対座標での足元（RIG_ANCHOR の位置） */
  ground: { x: number; y: number };
  flip?: boolean;
  label?: string;
}

export function RigView({ items, scale: s, ground, flip, label }: RigViewProps) {
  const [cw, ch] = RIG_CANVAS;
  const ax = flip ? cw - RIG_ANCHOR.x : RIG_ANCHOR.x;
  return (
    <View
      pointerEvents="none"
      accessible={!!label}
      accessibilityLabel={label}
      accessibilityRole={label ? 'image' : undefined}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      style={[styles.box, { left: ground.x - ax * s, top: ground.y - RIG_ANCHOR.y * s, width: cw * s, height: ch * s }, flip ? { transform: [{ scaleX: -1 }] } : null]}
    >
      {items.map((it, i) => {
        const k = it.scale * s;
        const [rx, ry, rw, rh] = it.rect;
        const w = rw * k;
        const h = rh * k;
        const px = it.pivotSrc[0] * k;
        const py = it.pivotSrc[1] * k;
        const dx = px - w / 2;
        const dy = py - h / 2;
        return (
          <View
            key={`${it.part}${i}`}
            style={{
              position: 'absolute',
              left: it.pivot[0] * s - px,
              top: it.pivot[1] * s - py,
              width: w,
              height: h,
              overflow: 'hidden',
              transform: it.rot === 0 ? undefined : [{ translateX: dx }, { translateY: dy }, { rotate: `${it.rot}rad` }, { translateX: -dx }, { translateY: -dy }],
            }}
          >
            <Image
              source={RIG_IMAGE}
              resizeMode="stretch"
              accessibilityElementsHidden
              style={{ position: 'absolute', width: RIG_ATLAS.width * k, height: RIG_ATLAS.height * k, left: -rx * k, top: -ry * k }}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({ box: { position: 'absolute', overflow: 'hidden' } });
