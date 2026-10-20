// 使い方: node scripts/run-with-env.mjs KEY=VALUE [KEY=VALUE ...] -- コマンド 引数...
// OS差のない環境変数つき実行（cross-env を依存に足さないため）。npx は使わず、mobile 直下の node_modules/.bin を使う。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
if (sep < 0 || sep === args.length - 1) {
  console.error('使い方: run-with-env.mjs KEY=VALUE -- コマンド 引数...');
  process.exit(2);
}
const env = { ...process.env };
for (const kv of args.slice(0, sep)) {
  const i = kv.indexOf('=');
  if (i <= 0) {
    console.error(`KEY=VALUE の形ではありません: ${kv}`);
    process.exit(2);
  }
  env[kv.slice(0, i)] = kv.slice(i + 1);
}
const [cmd, ...rest] = args.slice(sep + 1);
const bin = fileURLToPath(new URL('../node_modules/.bin/', import.meta.url));
const child = spawn(`${bin}${cmd}`, rest, { env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 1));
