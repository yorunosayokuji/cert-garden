import { Image, Platform, StyleSheet, View, type ImageStyle } from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import type { MotionAtlas } from './motionAssets';

interface Props {
  image: ImageSourcePropType;
  atlas: MotionAtlas;
  frame: number;
  /** 拡大率。atlas内の全コマで共通（コマごとに伸縮しない） */
  scale: number;
  /** 親の絶対座標での足元（コマの下端の anchor 位置） */
  ground: { x: number; y: number };
  /** 左右反転（足元の x は動かさない） */
  flip?: boolean;
  label?: string;
}

/** Web ではドット絵の縁を保つ。native では指定なし */
const PIXELATED = (Platform.OS === 'web' ? { imageRendering: 'pixelated' } : null) as unknown as ImageStyle | null;

/** manifest の rect/anchor で切り抜いて描く。画像の加工・コマごとの拡縮はしない */
export function LabSprite({ image, atlas, frame, scale: s, ground, flip, label }: Props) {
  const f = atlas.frames[frame] ?? atlas.frames[0]!;
  const [rx, ry, rw, rh] = f.rect as [number, number, number, number];
  const [ax, ay] = f.anchor as [number, number];
  // 反転は箱の中心まわり。足元の anchor が ground.x に来るよう左端を取り直す
  const left = flip ? ground.x - (rw - ax) * s : ground.x - ax * s;
  return (
    <View
      pointerEvents="none"
      accessible={!!label}
      accessibilityLabel={label}
      accessibilityRole={label ? 'image' : undefined}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      style={[styles.box, { left, top: ground.y - ay * s, width: rw * s, height: rh * s }, flip ? { transform: [{ scaleX: -1 }] } : null]}
    >
      <Image
        source={image}
        resizeMode="stretch"
        accessibilityElementsHidden
        style={[{ position: 'absolute', width: atlas.width * s, height: atlas.height * s, left: -rx * s, top: -ry * s }, PIXELATED]}
      />
    </View>
  );
}

const styles = StyleSheet.create({ box: { position: 'absolute', overflow: 'hidden' } });
