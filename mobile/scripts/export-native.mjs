// 使い方: node scripts/export-native.mjs product|compare-dev|flag-release
// iOS 向けの JS を書き出し、中身を確かめる。外部への送信・認証・支払いはしない。Mac / Xcode / 署名は使わない。
//  product      → dist-native/          製品相当(配布): Hermes バイトコード・minify・比較フラグなし。署名版と同じ判定で製品/起動拒否に入る
//  compare-dev  → dist-native-compare/  比較の開発ビルド相当: --dev (__DEV__=true) + EXPO_PUBLIC_IOS_DESIGN=1。native で比較の入口に入る条件と同じ。
//                                       配布物ではない（開発用のJS。Hermes の配布物と呼ばない）
//  flag-release → dist-native-flag/     補助検査: 配布相当(--dev なし)にフラグだけ付けた出力。__DEV__ が false なので native では比較に入らない
//                                       （署名版に比較フラグが混ざっても比較は開かないことの確認用。比較 native の検証には数えない）
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODES, exportArgs, verifyNativeExport } from './nativeExport.mjs';

const mode = process.argv[2];
const m = MODES[mode];
if (!m) {
  console.error('使い方: export-native.mjs product|compare-dev|flag-release');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, EXPO_PUBLIC_IOS_DESIGN: m.flag };
// shell を介さず、expo の CLI を現在の node で直接起動する（引数を連結しない）
const run = spawnSync(process.execPath, [`${root}node_modules/expo/bin/cli`, ...exportArgs(mode)], { cwd: root, env, stdio: 'inherit' });
if (run.status !== 0) {
  console.error(`expo export が失敗しました（終了コード ${run.status}）`);
  process.exit(run.status ?? 1);
}
const v = verifyNativeExport(`${root}${m.out}`, mode);
console.log(`bundle ${v.info.bundleBytes} bytes / assets ${v.info.assets} / Hermes ${v.info.hermes} / dev ${v.info.dev}`);
if (!v.ok) {
  for (const e of v.errors) console.error(`NG  ${e}`);
  process.exit(1);
}
console.log(`OK  iOS の書き出し（${mode}）。ネイティブのコンパイル・署名・実機は別で、ここでは行っていません`);
