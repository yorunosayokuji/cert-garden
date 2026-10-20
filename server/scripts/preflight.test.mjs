import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkConfig, checkSecretShapes, parseJsonc } from './preflight.mjs';

const good = () => ({
  workers_dev: false,
  d1_databases: [{ binding: 'DB', database_name: 'cert-garden', database_id: '11111111-2222-3333-4444-555555555555' }],
  vars: { APP_ENV: 'production', GOOGLE_CLIENT_IDS: 'a.apps.googleusercontent.com', APPLE_CLIENT_ID: 'com.example.app', APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', ALLOWED_ORIGINS: 'https://app.example.com' },
});

test('現在のwrangler.jsoncは未設定なので不合格（fail closedの確認）', () => {
  const cfg = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const p = checkConfig(cfg);
  assert.ok(p.some((s) => s.includes('database_id')));
  assert.ok(p.some((s) => s.includes('GOOGLE_CLIENT_IDS')));
  assert.ok(p.some((s) => s.includes('APP_ENV')));
});

test('揃った設定は合格', () => assert.deepEqual(checkConfig(good()), []));

test('ダミーdatabase_id/ワイルドカードorigin/vars内の秘密/workers_devを拒否', () => {
  const c = good();
  c.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
  c.vars.ALLOWED_ORIGINS = '*';
  c.vars.APPLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----x';
  c.workers_dev = true;
  const p = checkConfig(c).join('\n');
  for (const k of ['database_id', 'ALLOWED_ORIGINS', 'APPLE_PRIVATE_KEY', 'workers_dev']) assert.ok(p.includes(k), k);
});

test('JSONCは文字列内の//(URL)を壊さない', () => assert.equal(parseJsonc('{"a":"https://x.y", // c\n "b":1,}').a, 'https://x.y'));

test('秘密の形: 正しいPKCS8 P-256鍵+32バイト鍵は合格、欠落/形違いは不合格（値は出力しない）', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.deepEqual(await checkSecretShapes({ APPLE_PRIVATE_KEY: pem, APPLE_TOKEN_ENC_KEY: randomBytes(32).toString('base64') }), []);
  assert.equal((await checkSecretShapes({})).length, 2);
  assert.equal((await checkSecretShapes({ APPLE_PRIVATE_KEY: 'x', APPLE_TOKEN_ENC_KEY: randomBytes(16).toString('base64') })).length, 2);
});
