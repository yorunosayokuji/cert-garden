import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/util.ts';
import { APPLE_AUD, call, challenge, db, GOOGLE_AUD, installAppleTokenServer, login, makeWorld, resetDb, signIdToken, type World } from './helpers.ts';

beforeEach(resetDb);

async function exchangeG(w: World, tokenOpts: Parameters<typeof signIdToken>[2] = {}, chOverride?: { challengeId: string; nonce: string }) {
  const ch = chOverride ?? (await challenge(w, 'google')).json;
  const idToken = await signIdToken(w, 'google', { sub: 'u-1', nonce: ch.nonce, ...tokenOpts });
  return { ch, idToken, r: await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.challengeId, idToken } }) };
}

describe('JWT検証(Google): 署名/issuer/audience/期限/alg/kid/nonce', () => {
  it('正しいtokenはセッションを発行し、user idはサーバー生成(sub由来ではない)', async () => {
    const w = await makeWorld();
    const { r } = await exchangeG(w);
    expect(r.status).toBe(200);
    expect(r.json.user.id).toMatch(/^u_/);
    expect(r.json.user.id).not.toContain('u-1');
    expect(r.json.session.accessToken).toMatch(/^cga_/);
    expect(r.json.session.refreshToken).toMatch(/^cgr_/);
  });

  it('issuerは両形式(accounts.google.comも)許可。別issuerは拒否', async () => {
    const w = await makeWorld();
    expect((await exchangeG(w, { iss: 'accounts.google.com' })).r.status).toBe(200);
    expect((await exchangeG(w, { iss: 'https://evil.example' })).r.status).toBe(401);
    expect((await exchangeG(w, { iss: 'https://appleid.apple.com' })).r.status).toBe(401);
  });

  it('別audience・別キーの署名・kidすり替え・期限切れ・発行が未来・古すぎるiatを拒否', async () => {
    const w = await makeWorld();
    expect((await exchangeG(w, { aud: 'other-client' })).r.status).toBe(401);
    expect((await exchangeG(w, { keys: w.rogue })).r.status).toBe(401); // kidは同じだが秘密鍵が違う
    expect((await exchangeG(w, { expOffsetSec: -60, iatOffsetSec: -3600 })).r.status).toBe(401);
    expect((await exchangeG(w, { iatOffsetSec: 3600, expOffsetSec: 600 })).r.status).toBe(401);
    expect((await exchangeG(w, { iatOffsetSec: -4 * 3600, expOffsetSec: 8 * 3600 })).r.status).toBe(401);
  });

  it('alg=HS256(公開鍵を秘密として署名)/alg=none/不明kid/kidなしを拒否', async () => {
    const w = await makeWorld();
    const ch = (await challenge(w, 'google')).json;
    const hs = await new SignJWT({ nonce: ch.nonce })
      .setProtectedHeader({ alg: 'HS256', kid: 'g-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(GOOGLE_AUD)
      .setSubject('u-1')
      .setIssuedAt(Math.floor(w.clock.t / 1000))
      .setExpirationTime(Math.floor(w.clock.t / 1000) + 600)
      .sign(new TextEncoder().encode(JSON.stringify(w.google.jwk)));
    const none = ['{"alg":"none","kid":"g-key-1"}', JSON.stringify({ iss: 'https://accounts.google.com', aud: GOOGLE_AUD, sub: 'u-1', nonce: ch.nonce, iat: Math.floor(w.clock.t / 1000), exp: Math.floor(w.clock.t / 1000) + 600 })]
      .map((s) => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))
      .join('.') + '.';
    for (const idToken of [hs, none, 'garbage.token.value-garbage-garbage']) {
      const r = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.challengeId, idToken } });
      expect(r.status).toBe(401);
    }
    // 未知kidは一度だけJWKSを再取得するが、見つからなければ401。クールダウン内の連打は再取得しない
    const before = w.jwksFetches.google;
    const unknown = await signIdToken(w, 'google', { kid: 'zzz-unknown', nonce: ch.nonce });
    for (let i = 0; i < 5; i++) expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.challengeId, idToken: unknown } })).status).toBe(401);
    expect(w.jwksFetches.google - before).toBeLessThanOrEqual(1);
    // 失敗したtokenでchallengeは消費されない: 正しいtokenでまだ通る
    const good = await signIdToken(w, 'google', { sub: 'u-1', nonce: ch.nonce });
    expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.challengeId, idToken: good } })).status).toBe(200);
  });

  it('JWKSのkidローテーション: 新kidが現れたらクールダウン後に再取得して通る', async () => {
    const w = await makeWorld();
    await exchangeG(w);
    const { generateKeyPair, exportJWK } = await import('jose');
    const kp = await generateKeyPair('RS256', { extractable: true });
    w.extraGoogleKeys.push({ ...(await exportJWK(kp.publicKey)), kid: 'g-key-2', alg: 'RS256' });
    w.clock.t += 31_000; // クールダウン経過
    const keys = { privateKey: kp.privateKey, jwk: {}, kid: 'g-key-2' };
    expect((await exchangeG(w, { keys })).r.status).toBe(200);
  });

  it('JWKS取得が失敗するとfail closed(503)', async () => {
    const w = await makeWorld();
    const orig = w.deps.fetch;
    w.deps.fetch = async () => new Response('err', { status: 500 });
    void orig;
    const ch = (await challenge(w, 'google')).json;
    const idToken = await signIdToken(w, 'google', { nonce: ch.nonce });
    expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.challengeId, idToken } })).status).toBe(503);
  });
});

describe('nonce / challenge', () => {
  it('nonceなし/別nonce/別challengeのnonceを拒否。raw nonceとSHA-256 hex形式は許可', async () => {
    const w = await makeWorld();
    expect((await exchangeG(w, { nonce: null })).r.status).toBe(401);
    expect((await exchangeG(w, { nonce: 'n_other' })).r.status).toBe(401);
    const a = (await challenge(w, 'google')).json;
    const b = (await challenge(w, 'google')).json;
    expect((await exchangeG(w, { nonce: b.nonce }, a)).r.status).toBe(401);
    // hash済み形式(iOSでhashを渡す実装)
    const c = (await challenge(w, 'google')).json;
    expect((await exchangeG(w, { nonce: await sha256Hex(c.nonce), sub: 'hashed' }, c)).r.status).toBe(200);
  });

  it('nonce再利用: 同じchallengeの2回目は拒否。別tokenでも同じ', async () => {
    const w = await makeWorld();
    const first = await exchangeG(w);
    expect(first.r.status).toBe(200);
    const replay = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: first.ch.challengeId, idToken: first.idToken } });
    expect(replay.status).toBe(400);
    expect(replay.json.error.code).toBe('invalid_challenge');
    const other = await signIdToken(w, 'google', { sub: 'attacker', nonce: first.ch.nonce });
    expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: first.ch.challengeId, idToken: other } })).status).toBe(400);
  });

  it('challenge期限切れ(5分)と別provider用challengeを拒否', async () => {
    const w = await makeWorld({ apple: true });
    const ch = (await challenge(w, 'google')).json;
    const asApple = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'apple', challengeId: ch.challengeId, idToken: await signIdToken(w, 'apple', { nonce: ch.nonce }), authorizationCode: 'c' } });
    expect(asApple.status).toBe(400);
    w.clock.t += 5 * 60_000 + 1000;
    expect((await exchangeG(w, { nonce: ch.nonce }, ch)).r.status).toBe(400);
  });

  it('並行exchange: 同じchallenge+tokenを8本同時に送っても成功は1つだけ', async () => {
    const w = await makeWorld();
    const ch = (await challenge(w, 'google')).json;
    const idToken = await signIdToken(w, 'google', { sub: 'race-1', nonce: ch.nonce });
    const rs = await Promise.all(Array.from({ length: 8 }, () => call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch.challengeId, idToken } })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(7);
    const fams = await db.prepare('SELECT COUNT(*) AS n FROM session_families').first<{ n: number }>();
    expect(fams!.n).toBe(1);
  });
});

describe('本人ID: (provider, sub)で結合。メール一致・provider違いでは結合しない', () => {
  it('同じsubは同じ本人(再ログイン)、別subは別人、Googleとappleで同じsub文字列でも別人', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const a1 = await login(w, 'google', 'same-sub');
    const a2 = await login(w, 'google', 'same-sub');
    const b = await login(w, 'google', 'other-sub');
    const c = await login(w, 'apple', 'same-sub');
    expect(a1.userId).toBe(a2.userId);
    expect(b.userId).not.toBe(a1.userId);
    expect(c.userId).not.toBe(a1.userId);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(rows!.n).toBe(3);
  });

  it('emailがtokenに含まれていても保存せず、結合にも使わない', async () => {
    const w = await makeWorld();
    const ch1 = (await challenge(w, 'google')).json;
    const t1 = await new SignJWT({ nonce: ch1.nonce, email: 'same@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'g-key-1' })
      .setIssuer('https://accounts.google.com').setAudience(GOOGLE_AUD).setSubject('sub-A')
      .setIssuedAt(Math.floor(w.clock.t / 1000)).setExpirationTime(Math.floor(w.clock.t / 1000) + 600)
      .sign(w.google.privateKey);
    const r1 = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch1.challengeId, idToken: t1 } });
    const ch2 = (await challenge(w, 'google')).json;
    const t2 = await new SignJWT({ nonce: ch2.nonce, email: 'same@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'g-key-1' })
      .setIssuer('https://accounts.google.com').setAudience(GOOGLE_AUD).setSubject('sub-B')
      .setIssuedAt(Math.floor(w.clock.t / 1000)).setExpirationTime(Math.floor(w.clock.t / 1000) + 600)
      .sign(w.google.privateKey);
    const r2 = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'google', challengeId: ch2.challengeId, idToken: t2 } });
    expect(r1.json.user.id).not.toBe(r2.json.user.id);
    const dump = JSON.stringify(await db.prepare('SELECT * FROM identities').all());
    expect(dump).not.toContain('same@example.com');
  });

  it('同じ本人の初回ログインを並行しても、ユーザー行は1つ', async () => {
    const w = await makeWorld();
    const results = await Promise.all(Array.from({ length: 6 }, () => login(w, 'google', 'parallel-first')));
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    const n = await db.prepare('SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM identities) AS i').first<{ u: number; i: number }>();
    expect(n).toEqual({ u: 1, i: 1 });
  });
});

describe('Apple: code交換・refresh token暗号化保管', () => {
  it('codeを交換し、refresh tokenは暗号文だけDBに残る(平文なし)。client_secretはES256で検証された', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const s = await login(w, 'apple', 'apple-sub-1');
    const row = await db.prepare('SELECT * FROM apple_credentials WHERE user_id = ?').bind(s.userId).first<{ enc_refresh_token: string; iv: string }>();
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('apple-refresh-apple-sub-1');
    expect(w.calls.some((c) => c.url.endsWith('/auth/token'))).toBe(true);
  });

  it('authorizationCodeなし/Appleが拒否/refresh token欠落/別subのid_tokenはセッションを作らない', async () => {
    const w = await makeWorld({ apple: true });
    const ch = async () => (await challenge(w, 'apple')).json;
    let c = await ch();
    const tok = (sub: string, nonce: string) => signIdToken(w, 'apple', { sub, nonce });
    const noCode = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'apple', challengeId: c.challengeId, idToken: await tok('s1', c.nonce) } });
    expect(noCode.status).toBe(400);
    // Appleが拒否
    c = await ch();
    const rej = await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'apple', challengeId: c.challengeId, idToken: await tok('s1', c.nonce), authorizationCode: 'bad' } });
    expect(rej.status).toBe(401);
    expect(rej.json.error.code).toBe('apple_exchange_failed');
    // refresh tokenなし
    w.appleToken.respond = async (_p, world) => ({ status: 200, json: { id_token: await signIdToken(world, 'apple', { sub: 's1', nonce: null }) } });
    c = await ch();
    expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'apple', challengeId: c.challengeId, idToken: await tok('s1', c.nonce), authorizationCode: 'x' } })).status).toBe(401);
    // 別subのid_token
    w.appleToken.respond = async (_p, world) => ({ status: 200, json: { refresh_token: 'r', id_token: await signIdToken(world, 'apple', { sub: 'someone-else', nonce: null }) } });
    c = await ch();
    expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'apple', challengeId: c.challengeId, idToken: await tok('s1', c.nonce), authorizationCode: 'x' } })).status).toBe(401);
    const n = await db.prepare('SELECT (SELECT COUNT(*) FROM session_families) AS f, (SELECT COUNT(*) FROM apple_credentials) AS a').first<{ f: number; a: number }>();
    expect(n).toEqual({ f: 0, a: 0 });
  });

  it('Appleのaudience(bundle ID)違い/Apple鍵以外の署名を拒否', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    for (const o of [{ aud: 'com.other.app' }, { keys: w.rogue, kid: 'a-key-1' }]) {
      const c = (await challenge(w, 'apple')).json;
      const idToken = await signIdToken(w, 'apple', { nonce: c.nonce, ...o });
      expect((await call(w, 'POST', '/v1/auth/exchange', { body: { provider: 'apple', challengeId: c.challengeId, idToken, authorizationCode: 'code-x' } })).status).toBe(401);
    }
    void APPLE_AUD;
  });
});
