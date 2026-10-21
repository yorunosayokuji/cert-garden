import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { b64, BASE, call, makeWorld, req, resetDb, signIdToken, login, installAppleTokenServer } from './helpers.ts';

beforeEach(resetDb);

describe('本番入口(src/index.ts)をWorkers runtimeで実行: wrangler.jsonc の実設定（Apple未設定はfail closed）', () => {
  const f = (path: string, init?: RequestInit) => (exports as any).default.fetch(new Request(BASE + path, init)) as Promise<Response>;

  it('health: D1に届き、Googleは設定済み・Appleは未設定と表示。no-store', async () => {
    const r = await f('/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toMatchObject({ status: 'ok', db: 'ok', providers: { google: true, apple: false } });
  });

  it('実設定: Googleは公開client IDで設定済み(challenge発行できる)、Apple未設定は503。偽のchallengeでは交換できず、匿名の成功は返さない', async () => {
    const post = (path: string, body: unknown) => f(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/v1/auth/challenge', { provider: 'google' })).status).toBe(200);
    expect((await post('/v1/auth/exchange', { provider: 'google', challengeId: 'x', idToken: 'x'.repeat(30) })).status).toBe(400);
    expect((await post('/v1/auth/challenge', { provider: 'apple' })).status).toBe(503);
    expect((await post('/v1/auth/exchange', { provider: 'apple', challengeId: 'x', idToken: 'x'.repeat(30) })).status).toBe(503);
  });

  it('未認証のbackup/account/logoutは401', async () => {
    expect((await f('/v1/backup')).status).toBe(401);
    expect((await f('/v1/backup', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await f('/v1/auth/logout', { method: 'POST' })).status).toBe(401);
    expect((await f('/v1/account', { method: 'DELETE' })).status).toBe(401);
  });
});

describe('設定の部分欠落', () => {
  it('Appleの秘密鍵なし: Appleは503、Googleは使える。health表示もfalse', async () => {
    const w = await makeWorld({ apple: 'no-private-key' });
    expect((await call(w, 'GET', '/health')).json.providers).toEqual({ google: true, apple: false });
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'apple' } })).status).toBe(503);
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'google' } })).status).toBe(200);
  });

  it('Appleのトークン暗号鍵なし/長さ違いも503', async () => {
    const w = await makeWorld({ apple: 'no-enc-key' });
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'apple' } })).status).toBe(503);
    const w2 = await makeWorld({ apple: true });
    w2.env.APPLE_TOKEN_ENC_KEY = btoa('too short');
    expect((await call(w2, 'POST', '/v1/auth/challenge', { body: { provider: 'apple' } })).status).toBe(503);
  });

  it('Google設定なしでAppleだけ構成しても、Googleは503', async () => {
    const w = await makeWorld({ google: false, apple: true });
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'google' } })).status).toBe(503);
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'apple' } })).status).toBe(200);
  });
});

describe('入力境界', () => {
  it('不正JSON/Content-Type/配列/未知provider', async () => {
    const w = await makeWorld();
    expect((await call(w, 'POST', '/v1/auth/challenge', { headers: { 'content-type': 'application/json' }, raw: '{not json' })).status).toBe(400);
    expect((await call(w, 'POST', '/v1/auth/challenge', { headers: { 'content-type': 'text/plain' }, raw: '{}' })).status).toBe(415);
    expect((await call(w, 'POST', '/v1/auth/challenge', { headers: { 'content-type': 'application/json' }, raw: '[]' })).status).toBe(400);
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'facebook' } })).status).toBe(400);
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: {} })).status).toBe(400);
  });

  it('大入力: 宣言サイズ超過と、Content-Lengthなしのストリーム実測超過の両方を413で拒否', async () => {
    const w = await makeWorld();
    const big = JSON.stringify({ provider: 'google', pad: 'x'.repeat(20_000) });
    expect((await call(w, 'POST', '/v1/auth/challenge', { headers: { 'content-type': 'application/json' }, raw: big })).status).toBe(413);
    const chunk = new TextEncoder().encode('x'.repeat(8192));
    let sent = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (sent++ < 6) c.enqueue(chunk);
        else c.close();
      },
    });
    const r = await w.handle(req('POST', '/v1/auth/challenge', { headers: { 'content-type': 'application/json' }, raw: stream }));
    expect(r.status).toBe(413);
  });

  it('エラー形は一般化され、tokenや内部情報を含まない', async () => {
    const w = await makeWorld();
    const r = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: 'nope', idToken: 'a.b.c'.padEnd(40, 'x') } });
    expect(r.status).toBe(400);
    expect(Object.keys(r.json)).toEqual(['error']);
    expect(Object.keys(r.json.error).sort()).toEqual(['code', 'message']);
    expect((await call(w, 'GET', '/nowhere')).status).toBe(404);
    const m = await call(w, 'GET', '/v1/auth/refresh');
    expect(m.status).toBe(405);
    expect(m.res.headers.get('allow')).toBe('POST');
  });
});

describe('CORS: 明示allowlistのoriginだけ', () => {
  it('未許可originは403、許可originはヘッダーつき、preflight、Originなし(ネイティブ)は通常', async () => {
    const w = await makeWorld({ origins: 'https://app.example.test,*,https://x.example/path' });
    expect((await call(w, 'GET', '/health', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(w, 'GET', '/health', { headers: { origin: 'null' } })).status).toBe(403);
    const ok = await call(w, 'GET', '/health', { headers: { origin: 'https://app.example.test' } });
    expect(ok.status).toBe(200);
    expect(ok.res.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const pre = await call(w, 'OPTIONS', '/v1/backup', { headers: { origin: 'https://app.example.test' } });
    expect(pre.status).toBe(204);
    expect((await call(w, 'OPTIONS', '/v1/backup', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(w, 'GET', '/health')).res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('レート制限(D1共有)', () => {
  it('challengeは10分31回目から429+Retry-After。新しいhandler(=別instance相当)でもD1の数が効く', async () => {
    const w = await makeWorld();
    const results: number[] = [];
    for (let i = 0; i < 31; i++) results.push((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'google' }, headers: { 'cf-connecting-ip': '203.0.113.9' } })).status);
    expect(results.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(results[30]).toBe(429);
    const w2 = await makeWorld();
    const again = await call(w2, 'POST', '/v1/auth/challenge', { body: { provider: 'google' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
    expect(again.status).toBe(429);
    expect(Number(again.res.headers.get('retry-after'))).toBeGreaterThan(0);
    const other = await call(w2, 'POST', '/v1/auth/challenge', { body: { provider: 'google' }, headers: { 'cf-connecting-ip': '203.0.113.10' } });
    expect(other.status).toBe(200);
  });
});

describe('ログに秘密を出さない', () => {
  it('ログイン〜保存〜失敗の全logにidToken/access/refresh/nonceが含まれない', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const logs: string[] = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    try {
      const ch = await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'google' } });
      const idToken = await signIdToken(w, 'google', { sub: 'log-1', nonce: ch.json.nonce });
      const ex = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.json.challengeId, idToken } });
      const bad = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.json.challengeId, idToken } });
      expect(bad.status).toBe(400);
      const s = ex.json.session;
      await call(w, 'GET', '/v1/backup', { token: s.accessToken });
      await login(w, 'apple', 'log-apple');
      const secrets = [idToken, ch.json.nonce, s.accessToken, s.refreshToken];
      const all = logs.join('\n');
      expect(all.length).toBeGreaterThan(0);
      for (const sec of secrets) expect(all).not.toContain(sec);
      expect(all).not.toContain('log-apple');
    } finally {
      [console.log, console.error, console.warn] = orig;
    }
  });
});

void b64;
