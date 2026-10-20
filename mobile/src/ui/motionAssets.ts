// motion-v2 の連番atlas（design-assets・読み取り専用）。PNGは加工せず、manifest の rect/anchor で実行時に切り抜く。
import type { ImageSourcePropType } from 'react-native';
import manifest from '../../../design-assets/motion-v2/manifest.json';
import type { CompanionId } from '../state/notebook.ts';
import type { RoomId } from '../state/room.ts';

export const MOTION_IMAGES: Record<CompanionId, ImageSourcePropType> = {
  cream: require('../../../design-assets/motion-v2/cream.png'),
  lavender: require('../../../design-assets/motion-v2/lavender.png'),
  apricot: require('../../../design-assets/motion-v2/apricot.png'),
};

export interface MotionAtlas {
  width: number;
  height: number;
  referenceWidth: number;
  frames: { index: number; rect: number[]; anchor: number[] }[];
}

export const MOTION_ATLAS = manifest.atlases as unknown as Record<CompanionId, MotionAtlas>;

export const ROOMS: { id: RoomId; label: string; image: ImageSourcePropType; note: string }[] = [
  { id: 'home', label: 'おへや', image: require('../../../design-assets/app-completion-20261020/garden/room-editable.png'), note: 'みんな、のんびり中です。家具は「模様替え」で動かせます。' },
  { id: 'first', label: 'はじめのおへや', image: require('../../../design-assets/parts/room-wide-v1.png'), note: 'はじめのおへやです。家具は絵に含まれていて、動かせません。' },
  { id: 'library', label: 'としょかん', image: require('../../../design-assets/rooms-v2/library.png'), note: 'しずかな本の部屋です。' },
  { id: 'forest', label: 'もり', image: require('../../../design-assets/rooms-v2/forest.png'), note: '木もれ日の中でひと休み。' },
  { id: 'beach', label: 'うみ', image: require('../../../design-assets/rooms-v2/beach.png'), note: '波の音がきこえそう。' },
  { id: 'night', label: 'よる', image: require('../../../design-assets/rooms-v2/night.png'), note: '星空の下で、ゆったり。' },
];

/** 部屋幅に対する可視幅の割合と、中央の床の足元位置（部屋に対する比率） */
export const GARDEN_PLACEMENTS: { id: CompanionId; widthRatio: number; ground: [number, number] }[] = [
  { id: 'cream', widthRatio: 0.18, ground: [0.3, 0.64] },
  { id: 'lavender', widthRatio: 0.2, ground: [0.7, 0.66] },
  { id: 'apricot', widthRatio: 0.23, ground: [0.5, 0.79] },
];
