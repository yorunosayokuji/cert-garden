// 本番前の静的preflight。ログイン/リモート/秘密ストアには一切アクセスしない。
//   node scripts/preflight.mjs                 … wrangler.jsonc を検査（通常はまだ未設定なので失敗する＝正しい）
//   node scripts/preflight.mjs --check-secrets … 加えて、環境変数に入れた秘密の「形」だけ検査（値は表示しない）
// 終了コード 0 は「静的設定と（指定時）秘密の形が揃った」だけで、デプロイ/実OAuth成功を意味しない。
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importPKCS8 } from 'jose';

export const REQUIRED_VARS = ['GOOGLE_CLIENT_IDS', 'APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID']; // ALLOWED_ORIGINS は任意（空=ブラウザー呼び出しを許可しない。ネイティブはOrigin無し）
export const REQUIRED_SECRETS = ['APPLE_PRIVATE_KEY', 'APPLE_TOKEN_ENC_KEY'];
const SECRET_NAME = /(PRIVATE|SECRET|TOKEN_ENC|PASSWORD|API_KEY)/i;

/** JSONC → JSON（文字列内の // は保持） */
export function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** @returns {string[]} 問題点（空なら静的設定は合格） */
export function checkConfig(cfg) {
  const problems = [];
  const vars = cfg.vars ?? {};
  const db = (cfg.d1_databases ?? []).find((d) => d.binding === 'DB');
  if (!db) problems.push('D1 binding "DB" がありません');
  else if (!db.database_id || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(db.database_id)) problems.push('D1 database_id が未作成のダミーです（作成後に本人確認のうえ設定）');
  if (vars.APP_ENV !== 'production') problems.push('vars.APP_ENV が "production" ではありません');
  for (const k of REQUIRED_VARS) if (!String(vars[k] ?? '').trim()) problems.push(`vars.${k} が空です（未設定のままだとログインは503で拒否される）`);
  const origins = String(vars.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.some((o) => o === '*' || !/^https:\/\/[^/*]+$/.test(o))) problems.push('ALLOWED_ORIGINS にワイルドカード/https以外/パス付きがあります');
  for (const [k, v] of Object.entries(vars)) {
    if (SECRET_NAME.test(k) || /BEGIN [A-Z ]*PRIVATE KEY/.test(String(v))) problems.push(`vars.${k} は秘密に見えます。vars ではなく wrangler secret を使う`);
  }
  if (cfg.workers_dev === true) problems.push('workers_dev が有効です');
  return problems;
}

/** @param {Record<string,string|undefined>} env 秘密の形だけ検査。値は出力しない */
export async function checkSecretShapes(env) {
  const problems = [];
  const pem = (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
  if (!pem) problems.push('APPLE_PRIVATE_KEY が環境にありません');
  else {
    try {
      await importPKCS8(pem, 'ES256');
    } catch {
      problems.push('APPLE_PRIVATE_KEY がPKCS8のES256(P-256)鍵として読めません');
    }
  }
  const k = env.APPLE_TOKEN_ENC_KEY;
  if (!k) problems.push('APPLE_TOKEN_ENC_KEY が環境にありません');
  else if (Buffer.from(k.trim(), 'base64').length !== 32) problems.push('APPLE_TOKEN_ENC_KEY はbase64の32バイトにしてください');
  return problems;
}

async function main() {
  const path = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
  const problems = checkConfig(parseJsonc(readFileSync(path, 'utf8')));
  const checkSecrets = process.argv.includes('--check-secrets');
  if (checkSecrets) problems.push(...(await checkSecretShapes(process.env)));
  else console.log('注意: 秘密の存在は確認していません（wrangler secret list はログインが要るため実行しない）。必要な秘密名:', REQUIRED_SECRETS.join(', '));
  if (problems.length === 0) {
    console.log('preflight: 静的設定は合格（デプロイ・実OAuth・リモートD1は未確認）');
    return 0;
  }
  console.error('preflight: 不合格');
  for (const p of problems) console.error(' - ' + p);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
