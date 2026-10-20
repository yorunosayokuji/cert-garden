// 全26体の全身連番（design-assets は読み取り専用）。索引は runtime-motion-catalog-v2.json、画像は require.context で引く。
// 読む範囲は索引が参照するフォルダだけ（下の正規表現）。全26体の全コマを一斉に読み込まず、表示する個体のクリップだけを準備する。
import { Image, type ImageSourcePropType } from 'react-native';
import { Asset } from 'expo-asset';
import { ClipLoader, assetUriOf } from '../state/clipLoader';
import { parseCatalog, type CharMotion, type MotionCatalog } from '../state/roomMotion';

export const MOTION_CATALOG: MotionCatalog = parseCatalog(require('../../../design-assets/app-completion-20261020/runtime-motion-catalog-v2.json'));

const byId = new Map<string, CharMotion>(MOTION_CATALOG.characters.map((c) => [c.id, c]));
export const charMotion = (id: string): CharMotion | undefined => byId.get(id);

// 注意: 正規表現は試験(mobile/test/motion.v2.test.ts)がこのファイルの文字列と一致を確かめる
const ctx = require.context(
  '../../../design-assets',
  true,
  /^\.\/(app-completion-20261020\/motions\/[a-z]+\/cropped-v2\/[a-z_]+|motion-v13-ensemble\/[a-z]+\/[a-z]+|motion-kokemaru-idle-20261016\/frames|motion-kokemaru-walk-20261019\/[a-z]+|motion-kokemaru-directions-20261019\/frames\/[a-z-]+)\/\d+\.png$/,
);

/** 索引の「design-assets/…」パスから画像を引く。無ければ例外（空白の絵でごまかさない） */
export function imageOf(file: string): ImageSourcePropType {
  const key = `./${file.replace(/^design-assets\//, '')}`;
  try {
    return ctx(key) as unknown as ImageSourcePropType;
  } catch {
    throw new Error(`動きの画像が見つかりません: ${file}`);
  }
}

/**
 * 1枚を実際に読み込む。URI は Web/Native 共通の Expo Asset（Asset.fromModule）で解決し、読み込みは Image.prefetch
 * （react-native-web にも react-native にもある）。Native 専用の URI 解決 API は Web に無いので使わない。
 */
const loader = new ClipLoader(async (file) => {
  const uri = assetUriOf(Asset.fromModule(imageOf(file) as number));
  return Image.prefetch(uri);
});

/** クリップのファイル一覧 */
export function clipFiles(c: CharMotion, names: string[]): string[] {
  return names.flatMap((n) => c.clips[n]?.frames.map((f) => f.file) ?? []);
}

export const clipsReady = (c: CharMotion, names: string[]) => loader.isReady(clipFiles(c, names));

/** 指定したクリップの画像がそろうまで待つ（失敗は ClipLoadError）。選んだ個体のものだけを頼むこと */
export const ensureClips = (c: CharMotion, names: string[]): Promise<void> => loader.ensure(clipFiles(c, names));

/** 次に使うクリップを先に用意する（待たない・失敗しても表示は止めない） */
export const warmClips = (c: CharMotion, names: string[]): void => loader.warm(clipFiles(c, names));
