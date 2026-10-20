// MotionStudy 用の素材（design-assets/motion-v3・読み取り専用）。PNGは無加工で、manifest の rect/anchor で実行時に切り抜く。
// 旧素材(motionLabAssets / motionAssets)の参照・順序には触れない。
import type { ImageSourcePropType } from 'react-native';
import manifest from '../../../design-assets/motion-v3/manifest.json';
import manifestV4 from '../../../design-assets/motion-v4/manifest.json';
import type { MotionAtlas } from './motionAssets';
import type { StudySheet } from './motionStudy.ts';

export const STUDY_IMAGES: Record<StudySheet, ImageSourcePropType> = {
  keys: require('../../../design-assets/motion-v3/apricot-walk-keys8-v1.png'),
  walk: require('../../../design-assets/motion-v3/apricot-walk-24-v1.png'),
  stretch: require('../../../design-assets/motion-v3/apricot-stretch-30-v1.png'),
  down: require('../../../design-assets/motion-v3/apricot-down-24-v1.png'),
  up: require('../../../design-assets/motion-v3/apricot-up-30-v1.png'),
};

/** 関節から作る歩行の部品シート（無加工。切り抜きと変形は gaitRig.ts の描画リスト） */
export const RIG_IMAGE: ImageSourcePropType = require('../../../design-assets/motion-v3/apricot-rig-parts-v1.png');

export const STUDY_ATLAS = manifest.atlases as unknown as Record<StudySheet, MotionAtlas>;

/**
 * 全身連動を組んだ歩行30姿勢（motion-v4）。新規の全身パーツ5枚を scripts/render-full-walk.mjs が30姿勢へ連続変形して描いた絵（30枚の新規手描きではない）。
 * manifest.json（atlases.walk / atlases.idle）と apricot-walk-30.png / apricot-walk-idle.png は親がスクリプトを実行して置く。
 * 置かれるまで型検査・試験・書き出しは読込みで失敗する（受領待ち。旧版や仮の絵で代用しない）。
 */
export const WALK_V4_IMAGE: ImageSourcePropType = require('../../../design-assets/motion-v4/apricot-walk-30.png');
export const WALK_V4_ATLAS = manifestV4.atlases.walk as unknown as MotionAtlas;
/** 休止の1コマ（歩行シートと同じ 96x80・同じ anchor・同じ referenceWidth） */
export const WALK_V4_IDLE_IMAGE: ImageSourcePropType = require('../../../design-assets/motion-v4/apricot-walk-idle.png');
export const WALK_V4_IDLE_ATLAS = manifestV4.atlases.idle as unknown as MotionAtlas;
/** 休止の最初（足を下げる）と最後（足を上げる）の6枚ずつ（576x80 の横1列・同じ rect 寸法/anchor/referenceWidth） */
export const WALK_V4_SETTLE_IMAGE: ImageSourcePropType = require('../../../design-assets/motion-v4/apricot-walk-settle.png');
export const WALK_V4_SETTLE_ATLAS = manifestV4.atlases.settle as unknown as MotionAtlas;
export const WALK_V4_START_IMAGE: ImageSourcePropType = require('../../../design-assets/motion-v4/apricot-walk-start.png');
export const WALK_V4_START_ATLAS = manifestV4.atlases.start as unknown as MotionAtlas;
