import { beforeEach, describe, expect, it } from 'vitest';
import { call, challenge, db, installAppleTokenServer, login, makeWorld, resetDb, signIdToken, type Session, type World } from './helpers.ts';

beforeEach(resetDb);

const core = JSON.stringify({ schemaVersion: 1, wallet: { fruits: 1, maxFruits: 10 }, points: 1, studySeconds: {}, completedThemes: {}, reviews: {}, mastery: {}, stages: {}, completions: {}, log: [] });
const seed = (w: World, s: Session) => call(w, 'PUT', '/v1/backup', { token: s.accessToken, body: { baseRevision: 0, requestId: 'seed-000001', backup: { format: 'certgarden-backup', version: 1, entries: { 'certgarden:core:v1': core } } } });

async function reauth(w: World, provider: 'google' | 'apple', s: Session, sub: string, over: { sub?: string; useLoginChallenge?: boolean } = {}) {
  const ch = (await challenge(w, provider, over.useLoginChallenge ? 'login' : 'reauth', over.useLoginChallenge ? undefined : s.accessToken)).json;
  const idToken = await signIdToken(w, provider, { sub: over.sub ?? sub, nonce: ch.nonce });
  return { challengeId: ch.challengeId, idToken };
}

async function counts(userId: string) {
  const q = async (sql: string) => (await db.prepare(sql).bind(userId).first<{ n: number }>())!.n;
  return {
    users: await q('SELECT COUNT(*) AS n FROM users WHERE id = ?'),
    identities: await q('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?'),
    families: await q('SELECT COUNT(*) AS n FROM session_families WHERE user_id = ?'),
    access: await q('SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ?'),
    refresh: await q('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?'),
    backups: await q('SELECT COUNT(*) AS n FROM backups WHERE user_id = ?'),
    apple: await q('SELECT COUNT(*) AS n FROM apple_credentials WHERE user_id = ?'),
    challenges: await q('SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id = ?'),
  };
}

describe('アカウント削除（隔離テストユーザー、再認証必須）', () => {
  it('再認証なし/確認語なし/loginのchallenge/別人のtoken/他人宛てchallengeは拒否し、何も消えない', async () => {
    const w = await makeWorld();
    const a = await login(w, 'google', 'alice');
    const b = await login(w, 'google', 'bob');
    await seed(w, a);
    // reauth challengeは認証なしでは作れない
    expect((await call(w, 'POST', '/v1/auth/challenge', { body: { provider: 'google', purpose: 'reauth' } })).status).toBe(401);
    expect((await call(w, 'DELETE', '/v1/account', { token: a.accessToken, body: { confirm: 'DELETE' } })).status).toBe(400);
    const ok = await reauth(w, 'google', a, 'alice');
    expect((await call(w, 'DELETE', '/v1/account', { token: a.accessToken, body: { confirm: 'yes', provider: 'google', ...ok } })).status).toBe(400);
    // loginのchallengeは再認証に使えない
    const wrongPurpose = await reauth(w, 'google', a, 'alice', { useLoginChallenge: true });
    expect((await call(w, 'DELETE', '/v1/account', { token: a.accessToken, body: { confirm: 'DELETE', provider: 'google', ...wrongPurpose } })).status).toBe(400);
    // 別人(bob)のtokenでaliceを削除しようとする
    const bobsToken = await reauth(w, 'google', a, 'alice', { sub: 'bob' });
    expect((await call(w, 'DELETE', '/v1/account', { token: a.accessToken, body: { confirm: 'DELETE', provider: 'google', ...bobsToken } })).status).toBe(401);
    // bob宛てのreauth challengeをaliceのセッションで使う
    const bobCh = (await challenge(w, 'google', 'reauth', b.accessToken)).json;
    const idToken = await signIdToken(w, 'google', { sub: 'alice', nonce: bobCh.nonce });
    expect((await call(w, 'DELETE', '/v1/account', { token: a.accessToken, body: { confirm: 'DELETE', provider: 'google', challengeId: bobCh.challengeId, idToken } })).status).toBe(400);
    expect((await counts(a.userId)).users).toBe(1);
    expect((await call(w, 'GET', '/v1/backup', { token: a.accessToken })).json.revision).toBe(1);
  });

  it('Google: 正しい再認証で本人の全データとセッションが消える。他ユーザーは無傷。再ログインは別の新規ユーザー', async () => {
    const w = await makeWorld();
    const a = await login(w, 'google', 'alice');
    const b = await login(w, 'google', 'bob');
    await seed(w, a);
    await seed(w, b);
    const before = await counts(b.userId);
    const body = { confirm: 'DELETE', provider: 'google', ...(await reauth(w, 'google', a, 'alice')) };
    const r = await call(w, 'DELETE', '/v1/account', { token: a.accessToken, body });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: true, appleRevocation: 'not_applicable' });
    expect(await counts(a.userId)).toEqual({ users: 0, identities: 0, families: 0, access: 0, refresh: 0, backups: 0, apple: 0, challenges: 0 });
    expect((await call(w, 'GET', '/v1/backup', { token: a.accessToken })).status).toBe(401);
    expect((await call(w, 'POST', '/v1/auth/refresh', { body: { refreshToken: a.refreshToken } })).status).toBe(401);
    expect(await counts(b.userId)).toEqual(before);
    expect((await call(w, 'GET', '/v1/backup', { token: b.accessToken })).json.revision).toBe(1);
    const again = await login(w, 'google', 'alice');
    expect(again.userId).not.toBe(a.userId);
    expect((await call(w, 'GET', '/v1/backup', { token: again.accessToken })).json.revision).toBe(0);
    // 同じ再認証challengeは再利用できない
    expect((await call(w, 'DELETE', '/v1/account', { token: again.accessToken, body })).status).toBe(400);
  });

  it('Apple: refresh tokenを復号してAppleへ失効要求を送り、成功後に全消去。client_secretはES256署名', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const revoked: URLSearchParams[] = [];
    w.appleRevoke.respond = (p) => (revoked.push(p), { status: 200, json: {} });
    const s = await login(w, 'apple', 'apple-alice');
    await seed(w, s);
    const body = { confirm: 'DELETE', provider: 'apple', ...(await reauth(w, 'apple', s, 'apple-alice')) };
    const r = await call(w, 'DELETE', '/v1/account', { token: s.accessToken, body });
    expect(r.status).toBe(200);
    expect(r.json.appleRevocation).toBe('revoked');
    expect(revoked).toHaveLength(1);
    expect(revoked[0].get('token')).toBe('apple-refresh-apple-alice');
    expect(revoked[0].get('token_type_hint')).toBe('refresh_token');
    expect(revoked[0].get('client_id')).toBe('com.example.certgarden.test');
    expect(revoked[0].get('client_secret')!.split('.')).toHaveLength(3);
    expect(await counts(s.userId)).toEqual({ users: 0, identities: 0, families: 0, access: 0, refresh: 0, backups: 0, apple: 0, challenges: 0 });
  });

  it('Apple失効が失敗したら成功を偽らず502で何も消さない。再試行(新しい再認証)で完了', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const s = await login(w, 'apple', 'apple-bob');
    await seed(w, s);
    w.appleRevoke.respond = () => ({ status: 500, json: {} });
    const fail = await call(w, 'DELETE', '/v1/account', { token: s.accessToken, body: { confirm: 'DELETE', provider: 'apple', ...(await reauth(w, 'apple', s, 'apple-bob')) } });
    expect(fail.status).toBe(502);
    expect(fail.json.error.code).toBe('apple_revoke_failed');
    const c = await counts(s.userId);
    expect(c.users).toBe(1);
    expect(c.backups).toBe(1);
    expect(c.apple).toBe(1);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(200);
    // 既に無効(invalid_grant)は失効済みとして完了
    w.appleRevoke.respond = () => ({ status: 400, json: { error: 'invalid_grant' } });
    const ok = await call(w, 'DELETE', '/v1/account', { token: s.accessToken, body: { confirm: 'DELETE', provider: 'apple', ...(await reauth(w, 'apple', s, 'apple-bob')) } });
    expect(ok.status).toBe(200);
    expect(ok.json.appleRevocation).toBe('already_invalid');
    expect((await counts(s.userId)).users).toBe(0);
  });

  it('Apple設定が後から欠けた場合、失効できないので削除せず503', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const s = await login(w, 'apple', 'apple-carol');
    const body = { confirm: 'DELETE', provider: 'apple', ...(await reauth(w, 'apple', s, 'apple-carol')) };
    delete w.env.APPLE_PRIVATE_KEY;
    const r = await call(w, 'DELETE', '/v1/account', { token: s.accessToken, body });
    expect(r.status).toBe(503);
    expect((await counts(s.userId)).users).toBe(1);
  });

  it('Apple暗号文を別ユーザー行へ差し替えても復号できない(AADにuser id)。失効は偽らず、削除は手動失効案内つきで完了', async () => {
    const w = await makeWorld({ apple: true });
    installAppleTokenServer(w);
    const a = await login(w, 'apple', 'apple-a');
    const b = await login(w, 'apple', 'apple-b');
    const rowA = await db.prepare('SELECT enc_refresh_token, iv FROM apple_credentials WHERE user_id = ?').bind(a.userId).first<{ enc_refresh_token: string; iv: string }>();
    await db.prepare('UPDATE apple_credentials SET enc_refresh_token = ?, iv = ? WHERE user_id = ?').bind(rowA!.enc_refresh_token, rowA!.iv, b.userId).run();
    const revoked: unknown[] = [];
    w.appleRevoke.respond = (p) => (revoked.push(p), { status: 200, json: {} });
    const r = await call(w, 'DELETE', '/v1/account', { token: b.accessToken, body: { confirm: 'DELETE', provider: 'apple', ...(await reauth(w, 'apple', b, 'apple-b')) } });
    expect(r.status).toBe(200);
    expect(r.json.appleRevocation).toBe('manual_required');
    expect(revoked).toHaveLength(0); // 復号できないtokenをAppleへ送らない
    expect((await counts(b.userId)).users).toBe(0);
  });
});
