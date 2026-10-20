// 素材は design-assets（Codex管理・読み取り専用）を直接参照する。コピー・加工はしない。
import type { ImageSourcePropType } from 'react-native';
import manifest from '../../../design-assets/manifest.json';
import type { CompanionId } from '../state/notebook.ts';
import { POSES, anchorFrom, type Pose } from './poses.ts';

export { POSES, type Pose };

export const ATLAS_IMAGES: Record<CompanionId, ImageSourcePropType> = {
  cream: require('../../../design-assets/variants/cream-atlas-v1.png'),
  lavender: require('../../../design-assets/variants/lavender-atlas-v1.png'),
  apricot: require('../../../design-assets/variants/apricot-atlas-v1.png'),
};

export const ROOM_IMAGE: ImageSourcePropType = require('../../../design-assets/parts/room-wide-v1.png');
export const DESK_IMAGE: ImageSourcePropType = require('../../../design-assets/parts/study-desk-v1.png');

export const COMPANION_NAMES: Record<CompanionId, string> = {
  cream: 'クリーム',
  lavender: 'ラベンダー',
  apricot: 'アプリコット',
};
export const COMPANION_IDS: CompanionId[] = ['cream', 'lavender', 'apricot'];

export const CELL = manifest.atlas.cellWidth; // 512
export const COLS = manifest.atlas.columns;
export const ROWS = manifest.atlas.rows;

export function anchorOf(id: CompanionId, pose: Pose) {
  return anchorFrom(manifest, id, pose);
}

export const HOME_PLACEMENTS = manifest.home.placements as unknown as { id: CompanionId; pose: Pose; ground: [number, number]; cellWidthRatio: number }[];
export const STUDY_LAYOUT = manifest.study as unknown as { aspectRatio: number; cellWidthRatio: number; ground: [number, number]; character: CompanionId };
export const ROOM_ASPECT = 1; // room-wide-v1.png は 1254x1254
