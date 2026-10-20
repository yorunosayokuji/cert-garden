// MotionLab 用の素材（design-assets・読み取り専用）。PNGは無加工で、manifest の rect/anchor で実行時に切り抜く。
import type { ImageSourcePropType } from 'react-native';
import manifest30 from '../../../design-assets/motion30/manifest.json';
import { MOTION_ATLAS, type MotionAtlas } from './motionAssets';

export const LAB_IMAGES: Record<'old' | 'new' | 'walk', ImageSourcePropType> = {
  old: require('../../../design-assets/motion-v2/apricot.png'),
  new: require('../../../design-assets/motion30/apricot-30.png'),
  walk: require('../../../design-assets/motion30/apricot-walk-12.png'),
};

const atlases = manifest30.atlases as unknown as { apricot30: MotionAtlas; walk: MotionAtlas };

export const LAB_ATLAS: Record<'old' | 'new' | 'walk', MotionAtlas> = {
  old: MOTION_ATLAS.apricot,
  new: atlases.apricot30,
  walk: atlases.walk,
};
