// 個別家具8点の原画（design-assets は読み取り専用。コピー・加工しない）。Metro は静的な require が必要。
import type { ImageSourcePropType } from 'react-native';

/** 知恵の木の成長4段階（0=たね／1=芽／2=若木／3=実の木）。元の knowledge-tree.png は家具の画像として保持する */
export const TREE_STAGE_IMAGES: ImageSourcePropType[] = [
  require('../../../design-assets/app-completion-20261020/garden/tree-growth/0.png'),
  require('../../../design-assets/app-completion-20261020/garden/tree-growth/1.png'),
  require('../../../design-assets/app-completion-20261020/garden/tree-growth/2.png'),
  require('../../../design-assets/app-completion-20261020/garden/tree-growth/3.png'),
];

export const FURNITURE_IMAGES: Record<string, ImageSourcePropType> = {
  'leaf-rug': require('../../../design-assets/app-completion-20261020/garden/leaf-rug.png'),
  'knowledge-tree': require('../../../design-assets/app-completion-20261020/garden/knowledge-tree.png'),
  'wood-stool': require('../../../design-assets/app-completion-20261020/garden/wood-stool.png'),
  bookcase: require('../../../design-assets/app-completion-20261020/garden/bookcase.png'),
  armchair: require('../../../design-assets/app-completion-20261020/garden/armchair.png'),
  'leaf-cushion': require('../../../design-assets/app-completion-20261020/garden/leaf-cushion.png'),
  'coffee-table': require('../../../design-assets/app-completion-20261020/garden/coffee-table.png'),
  'leaf-pot': require('../../../design-assets/app-completion-20261020/garden/leaf-pot.png'),
};
