// 使い方: node scripts/check-eas-source.mjs
// EAS へ送るソースの形（専用 Git の写し・manifest・必要ソース・私的な物が無い）をローカルで確かめる。EAS CLI は呼ばない。
// 元の AI制作 のフォルダで実行すると拒否になる（それが正しい）。
import { fileURLToPath } from 'node:url';
import { checkSourceRoot } from './sourcePreflight.mjs';

const mobile = fileURLToPath(new URL('..', import.meta.url));
const r = checkSourceRoot(mobile);
if (r.ok) console.log(`OK  EAS へ送るソースの形（Git の根: ${r.gitRoot}）`);
else {
  for (const e of r.errors.slice(0, 40)) console.error(`NG  ${e}`);
  if (r.errors.length > 40) console.error(`NG  …ほか ${r.errors.length - 40} 件`);
  process.exit(1);
}
