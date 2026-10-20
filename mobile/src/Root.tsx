import type { ComponentType } from 'react';
import { Platform } from 'react-native';
import { isIosDesignEnabled } from './ios/compare.ts';

/**
 * 起動の分岐。通常起動は常に本体(App)。
 * iOS候補の確認入口は、Webの明示 ?iosDesign=1（開発サーバー、または EXPO_PUBLIC_IOS_DESIGN=1 で作った確認用ビルド）か、
 * nativeの開発実行(__DEV__)かつ EXPO_PUBLIC_IOS_DESIGN=1 の時だけ。署名ビルドでは開かない。
 * 画面部品は選んだ側だけを読み込む（候補側の見た目の調整が本体に混ざらない）。
 */
const enabled = isIosDesignEnabled({
  platform: Platform.OS,
  isDev: __DEV__,
  buildFlag: process.env.EXPO_PUBLIC_IOS_DESIGN,
  search: Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : '',
});

let Selected: ComponentType;
if (enabled) {
  // 候補側だけ、見出し・ボタンの書体をOSのsystemフォントにする（画面部品の読み込み前に1回）
  (require('./ui/theme') as typeof import('./ui/theme')).applySystemFonts();
  Selected = (require('./ios/IosDesignApp') as { default: ComponentType }).default;
} else {
  Selected = (require('./App') as { default: ComponentType }).default;
}

export default function Root() {
  return <Selected />;
}
