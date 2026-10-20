// 使い方: node scripts/check-ios-config.mjs [--build]
//  既定: 設定ファイルの条件(problems)だけ検査。未設定の必須項目は「未設定」と表示するが失敗にしない。
//  --build: EASビルド前の検査。未設定の必須項目(bundle ID / owner / projectId)があれば失敗(終了コード1)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { missingForBuild, problems } from './iosConfigCheck.mjs';

const dir = fileURLToPath(new URL('..', import.meta.url));
const appJson = JSON.parse(readFileSync(`${dir}app.json`, 'utf8'));
const easJson = JSON.parse(readFileSync(`${dir}eas.json`, 'utf8'));
const pkgJson = JSON.parse(readFileSync(`${dir}package.json`, 'utf8'));
const build = process.argv.includes('--build');

const bad = problems(appJson, easJson, pkgJson);
const missing = missingForBuild(appJson, easJson);
for (const p of bad) console.error(`NG  ${p}`);
for (const m of missing) console.log(`未設定  ${m}`);
if (bad.length === 0) console.log('OK  設定ファイルの条件（暗号申告・iPhone専用・scheme・4プロファイル・確認用入口の混入なし）');
if (bad.length > 0 || (build && missing.length > 0)) {
  if (build && missing.length > 0) console.error('EASビルドには上の未設定項目が必要です（本人のアカウント作成後に設定）。');
  process.exit(1);
}
