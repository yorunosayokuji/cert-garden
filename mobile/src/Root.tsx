import type { ComponentType, ReactElement } from 'react';
import { Platform } from 'react-native';
import selection from '../release-selection.json';
import { decideEntry } from './ios/entry.ts';

/**
 * 起動の分岐（判定は ios/entry.ts の純粋関数）。
 *  - iOS（署名版・通常の実行）: 常に新しい製品の画面。承認された案（release-selection.json）の1つだけを出し、未選択なら起動を拒否する。旧画面へは戻らない。
 *  - Web の通常: 旧画面（本体の既存の保存）。?iosDesign=1 で5案の比較（開発サーバーか比較用ビルドだけ）、?iosProductPreview=N で製品の検品（開発サーバーだけ）
 *  - iOS の開発ビルドで EXPO_PUBLIC_IOS_DESIGN=1 の時だけ、5案の比較
 * 画面の案は環境変数・URL・保存から上書きできない。
 *
 * 下の if は、ビルド時に決まる値（__DEV__ / Platform.OS / EXPO_PUBLIC_IOS_DESIGN）だけで書いてある。
 * 書き出しの時に不要な側の require が丸ごと外れる（署名版に比較の道具や旧画面が入らない）。
 */
let loadCompare: (() => ComponentType) | null = null;
if (__DEV__ || process.env.EXPO_PUBLIC_IOS_DESIGN === '1') {
  loadCompare = () => (require('./ios/IosDesignApp') as { default: ComponentType }).default;
}
let loadProduct: (() => ComponentType<{ variant: number; space: 'device' | 'preview' }>) | null = null;
if (Platform.OS === 'ios' || __DEV__) {
  loadProduct = () => (require('./ios/ProductApp') as { default: ComponentType<{ variant: number; space: 'device' | 'preview' }> }).default;
}
let loadLegacy: (() => ComponentType) | null = null;
if (Platform.OS !== 'ios') {
  loadLegacy = () => (require('./App') as { default: ComponentType }).default;
}

const entry = decideEntry({
  platform: Platform.OS,
  isDev: __DEV__,
  buildFlag: process.env.EXPO_PUBLIC_IOS_DESIGN,
  search: Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : '',
  selection,
});

function applyFonts() {
  // 新しい画面は見出し・ボタン・本文をOSのsystemフォントにする（画面部品の読み込み前に1回。iOS native だけ）
  (require('./ui/theme') as typeof import('./ui/theme')).applySystemFonts();
}

let element: () => ReactElement;
if (entry.kind === 'compare' && loadCompare) {
  applyFonts();
  const Compare = loadCompare();
  element = () => <Compare />;
} else if (entry.kind === 'product' && loadProduct) {
  applyFonts();
  const Product = loadProduct();
  const { variant, space } = entry;
  element = () => <Product variant={variant} space={space} />;
} else if (entry.kind === 'legacy' && loadLegacy) {
  const Legacy = loadLegacy();
  element = () => <Legacy />;
} else {
  // 起動してはいけない状態（未選択の署名版・読み込み手段の無い入口）。旧画面へは戻らない
  const reason = entry.kind === 'refuse' ? entry.reason : 'badSelection';
  const Blocked = (require('./ios/ReleaseBlocked') as { default: ComponentType<{ reason: 'noSelection' | 'badSelection' }> }).default;
  element = () => <Blocked reason={reason} />;
}

export default function Root() {
  return element();
}
