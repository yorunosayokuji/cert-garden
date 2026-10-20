// wranglerを匿名テレメトリ無効で起動する薄いラッパー（このプロセスの環境変数にだけ設定）。
// 使い方: node scripts/wrangler-quiet.mjs <wranglerの引数...>
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
process.exit(r.status ?? 1);
