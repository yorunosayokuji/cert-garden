// 採用26体の原画（静止画）。お店の一覧の見本と、索引に無い場合の代わりに使う。design-assets は読み取り専用。
// 動く全身連番は motionCatalog.ts（runtime-motion-catalog-v2.json）から引く。ここには連番を置かない。
import type { ImageSourcePropType } from 'react-native';
import type { CharacterId } from '../state/characters';

export const SEED_IMAGES: Record<CharacterId, ImageSourcePropType> = {
  anzu: require('../../../design-assets/motion-v13-ensemble/anzu/idle/01.png'),
  cream: require('../../../design-assets/motion-v13-ensemble/cream/idle/01.png'),
  lavender: require('../../../design-assets/motion-v13-ensemble/lavender/idle/01.png'),
  beans: require('../../../design-assets/motion-v13-ensemble/beans/idle/01.png'),
  mint: require('../../../design-assets/motion-v13-ensemble/mint/idle/01.png'),
  kokemaru: require('../../../design-assets/characters-plus10-20261015/characters/01-こけまる.png'),
  pomuri: require('../../../design-assets/characters-plus10-20261015/characters/02-ぽむり.png'),
  sumimaru: require('../../../design-assets/characters-plus10-20261015/characters/03-すみまる.png'),
  hiyomo: require('../../../design-assets/characters-plus10-20261015/characters/04-ひよも.png'),
  urune: require('../../../design-assets/characters-plus10-20261015/characters/05-うるね.png'),
  hoshiru: require('../../../design-assets/characters-plus10-20261015/characters/06-ほしる.png'),
  kurin: require('../../../design-assets/characters-plus10-20261015/characters/07-くりん.png'),
  mochine: require('../../../design-assets/characters-plus10-20261015/characters/08-もちね.png'),
  ruriko: require('../../../design-assets/characters-plus10-20261015/characters/09-るりこ.png'),
  mitsuno: require('../../../design-assets/characters-plus10-20261015/characters/10-みつの.png'),
  curlyhorn: require('../../../design-assets/characters-selected11-20261016/characters/01-巻き角のふわ獣.png'),
  flowerlong: require('../../../design-assets/characters-selected11-20261016/characters/02-花襟の長耳獣.png'),
  mushroom: require('../../../design-assets/characters-selected11-20261016/characters/03-赤傘のきのこ獣.png'),
  nightfox: require('../../../design-assets/characters-selected11-20261016/characters/04-星耳の夜色獣.png'),
  bat: require('../../../design-assets/characters-selected11-20261016/characters/05-ふわ胸のコウモリ獣.png'),
  leafwrap: require('../../../design-assets/characters-selected11-20261016/characters/06-秋葉に包まれた獣.png'),
  moonsleeper: require('../../../design-assets/characters-selected11-20261016/characters/07-月星毛布の眠り獣.png'),
  cloudfur: require('../../../design-assets/characters-selected11-20261016/characters/08-青白い雲毛の獣.png'),
  lantern: require('../../../design-assets/characters-selected11-20261016/characters/09-灯り触角の夜獣.png'),
  flowergill: require('../../../design-assets/characters-selected11-20261016/characters/10-花えらの桃色水獣.png'),
  cloudghost: require('../../../design-assets/characters-selected11-20261016/characters/11-淡色のうず雲おばけ.png'),
};
