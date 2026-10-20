// EAS の eas-build-pre-install から呼ばれる（npm install より前。純Nodeで依存なし）。
// 使い方（EAS の外で試す時）: EAS_BUILD_PROFILE=preview EAS_BUILD_PLATFORM=ios node scripts/eas-pre-install.mjs
// EAS CLI（build / submit）は呼ばない。失敗したら終了コード1でビルドを止める。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateBuild, realFs } from './buildPolicy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => {
  try {
    return JSON.parse(readFileSync(`${root}${rel}`, 'utf8'));
  } catch {
    return undefined;
  }
};

const result = evaluateBuild({
  profile: process.env.EAS_BUILD_PROFILE ?? '',
  platform: process.env.EAS_BUILD_PLATFORM ?? '',
  env: process.env,
  appJson: readJson('app.json'),
  easJson: readJson('eas.json'),
  pkgJson: readJson('package.json'),
  selection: readJson('release-selection.json'),
  fs: realFs(root),
});

if (result.ok) {
  console.log(`OK  ビルド前の検査（${result.kind === 'dev' ? '比較用の開発ビルド' : '製品ビルド'}）`);
} else {
  for (const m of result.errors) console.error(`NG  ${m}`);
  console.error('ビルド前の検査に通りませんでした。上の項目を直してください。');
  process.exit(1);
}
