import { Platform } from 'react-native';

export const C = {
  bg: '#f6efe0',
  page: '#e9dfc8',
  card: '#fffaf0',
  ink: '#3b2f25',
  sub: '#6e5f50',
  line: '#c9b998',
  accent: '#5e8f4a',
  accentDark: '#3f6a31',
  accentText: '#ffffff',
  warn: '#a2522a',
  okBg: '#e6f3dc',
  chosenBg: '#eaf2de',
  hintBg: '#fff1c9',
  gentleBg: '#f1ecfa',
  leaf: '#e3edd0',
  disabled: '#d8cfba',
  disabledInk: '#7d705f',
};
export const MAX_W = 480;

/**
 * 本文は日本語ゴシック(regular)。見出し・ボタンは weight 600/700。
 * Webは同梱の Noto Sans JP (OFL) を webFont.web.ts が "CertGarden Sans" として読み込み、先頭に置く。読めない時だけ後続のOS書体へ落ちる。
 */
const WEB_SANS = '"CertGarden Sans",Meiryo,"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,system-ui,sans-serif';
const WEB_ROUND = '"CertGarden Sans",Meiryo,"Noto Sans JP","Hiragino Maru Gothic ProN","Hiragino Sans","Yu Gothic UI",Meiryo,system-ui,sans-serif';
export const FONT_BODY = Platform.select({ web: WEB_SANS, default: undefined });
/** iOSは Hiragino Maru Gothic ProN（無い端末ではシステム書体にフォールバック）。Androidはシステム書体 */
export const FONT_HEAD = Platform.select({ web: WEB_ROUND, ios: 'HiraMaruProN-W4', default: undefined });
export const T = {
  body: { fontFamily: FONT_BODY, fontWeight: '400' as const },
  head: { fontFamily: FONT_HEAD, fontWeight: '600' as const },
  button: { fontFamily: FONT_HEAD, fontWeight: '700' as const },
};

/**
 * iOS候補の入口専用。見出し・ボタン・本文をOSのsystemフォントにする（本体の採用書体は変えない）。
 * 各画面の StyleSheet は import 時に T を展開するため、候補の画面を読み込む前に1回だけ呼ぶ。nativeのiOSだけ（Webは同梱フォントのまま）。
 */
export function applySystemFonts(): void {
  if (Platform.OS !== 'ios') return;
  (T.head as { fontFamily: string | undefined }).fontFamily = undefined;
  (T.button as { fontFamily: string | undefined }).fontFamily = undefined;
  (T.body as { fontFamily: string | undefined }).fontFamily = undefined;
}
