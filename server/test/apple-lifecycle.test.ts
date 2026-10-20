import { beforeEach, describe, expect, it } from 'vitest';
import { b64Decode, decryptSecret } from '../src/util.ts';
import { call, challenge, db, installAppleTokenServer, login, makeWorld, resetDb, signIdToken, type Session, type World } from './helpers.ts';

beforeEach(resetDb);

const DAY = 24 * 3600_000;
const refreshWith = (w: World, refreshToken: string) => call(w, 'POST', '/v1/auth/refresh', { body: { refreshToken } });
const checks = (w: World) => w.calls.filter((c) => c.url.endsWith('/auth/token') && c.body.includes('grant_type=refresh_token')).length;

async function stored(w: World, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT enc_refresh_token AS ct, iv, last_checked_at AS lc, version AS v FROM apple_credentials WHERE user_id = ?').bind(userId).first<{ ct: string; iv: string; lc: number; v: number }>();
  if (!row) return null;
  return decryptSecret(b64Decode(w.env.APPLE_TOKEN_ENC_KEY!)!, row.ct, row.iv, userId);
}
const lastChecked = async (userId: string) => (await db.prepare('SELECT last_checked_at AS lc, version AS v FROM apple_credentials WHERE user_id = ?').bind(userId).first<{ lc: number; v: number }>())!;

async function appleWorld() {
  const w = await makeWorld({ apple: true });
  installAppleTokenServer(w);
  return w;
}

describe('Apple日次照合（TN3194）', () => {
  it('24h未満はAppleへ問い合わせず、24h経過後に1回だけ照合して鮮度を更新する', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-1');
    expect((await lastChecked(s.userId)).lc).toBe(w.clock.t); // 認証時に鮮度を記録
    w.clock.t += 20 * 60_000;
    const r1 = await refreshWith(w, s.refreshToken);
    expect(r1.status).toBe(200);
    expect(checks(w)).toBe(0);
    w.clock.t += DAY;
    const r2 = await refreshWith(w, r1.json.session.refreshToken);
    expect(r2.status).toBe(200);
    expect(checks(w)).toBe(1);
    expect((await lastChecked(s.userId)).lc).toBe(w.clock.t);
    const call1 = w.calls.find((c) => c.body.includes('grant_type=refresh_token'))!;
    expect(new URLSearchParams(call1.body).get('refresh_token')).toBe('apple-refresh-ap-1');
    w.clock.t += 60_000;
    expect((await refreshWith(w, r2.json.session.refreshToken)).status).toBe(200);
    expect(checks(w)).toBe(1); // 同日2回目は問い合わせない
  });

  it('Apple側で連携解除(invalid_grant): 401で全sessionを失効、古いaccessも使えない。Google利用者は無影響でAppleへ問い合わせない', async () => {
    const w = await appleWorld();
    const a1 = await login(w, 'apple', 'ap-2');
    const a2 = await login(w, 'apple', 'ap-2'); // 別端末
    const g = await login(w, 'google', 'g-1');
    w.clock.t += DAY + 1000;
    w.appleRefresh.respond = () => ({ status: 400, json: { error: 'invalid_grant' } });
    expect((await refreshWith(w, a1.refreshToken)).status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: a1.accessToken })).status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: a2.accessToken })).status).toBe(401);
    expect((await refreshWith(w, a2.refreshToken)).status).toBe(401);
    const before = checks(w);
    const gr = await refreshWith(w, g.refreshToken);
    expect(gr.status).toBe(200);
    expect(checks(w)).toBe(before);
    expect((await call(w, 'GET', '/v1/backup', { token: gr.json.session.accessToken })).status).toBe(200);
  });

  it('一時障害(5xx/429/通信失敗)と自社設定不備(invalid_client)は失効と偽らず503。refresh tokenは消費されず、回復後に同じtokenで続けられる', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-3');
    w.clock.t += DAY + 1000;
    for (const mode of ['500', '429', 'throw', 'invalid_client']) {
      w.appleRefresh.respond = () => {
        if (mode === 'throw') throw new Error('network');
        if (mode === 'invalid_client') return { status: 400, json: { error: 'invalid_client' } };
        return { status: Number(mode), json: {} };
      };
      const r = await refreshWith(w, s.refreshToken);
      expect(r.status, mode).toBe(503);
      expect(r.json.error.code).toBe('provider_unavailable');
      expect(r.res.headers.get('retry-after')).toBe('60');
    }
    expect((await db.prepare('SELECT COUNT(*) AS n FROM session_families WHERE user_id = ? AND revoked_at IS NULL').bind(s.userId).first<{ n: number }>())!.n).toBe(1); // 失効していない
    expect((await db.prepare('SELECT used_at FROM refresh_tokens WHERE used_at IS NOT NULL').first())).toBeNull(); // 消費されていない
    w.appleRefresh.respond = () => ({ status: 200, json: {} });
    expect((await refreshWith(w, s.refreshToken)).status).toBe(200); // 消費されていない
  });

  it('新しいrefresh tokenが返ったら暗号化して更新(version+1)。平文はDBに無く、退会時は新tokenで失効', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-4');
    w.clock.t += DAY + 1000;
    w.appleRefresh.respond = () => ({ status: 200, json: { refresh_token: 'rotated-refresh-ap-4' } });
    const r = await refreshWith(w, s.refreshToken);
    expect(r.status).toBe(200);
    expect(await stored(w, s.userId)).toBe('rotated-refresh-ap-4');
    const lc = await lastChecked(s.userId);
    expect(lc.v).toBe(2);
    expect(JSON.stringify((await db.prepare('SELECT * FROM apple_credentials').all()).results)).not.toContain('rotated-refresh');
    const revoked: URLSearchParams[] = [];
    w.appleRevoke.respond = (p) => (revoked.push(p), { status: 200, json: {} });
    const ch = (await challenge(w, 'apple', 'reauth', r.json.session.accessToken)).json;
    const idToken = await signIdToken(w, 'apple', { sub: 'ap-4', nonce: ch.nonce });
    const del = await call(w, 'DELETE', '/v1/account', { token: r.json.session.accessToken, body: { confirm: 'DELETE', provider: 'apple', challengeId: ch.challengeId, idToken } });
    expect(del.json.appleRevocation).toBe('revoked');
    expect(revoked[0]!.get('token')).toBe('rotated-refresh-ap-4');
  });

  it('照合中に退会が走っても、削除済み利用者のcredentialもsessionも作り直さない', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-5');
    w.clock.t += DAY + 1000;
    w.appleRefresh.respond = async () => {
      // Appleへの問い合わせ中に、別リクエストの退会が完了した状況
      const u = s.userId;
      await db.batch(['backups', 'apple_credentials', 'access_tokens', 'refresh_tokens', 'session_families', 'auth_challenges', 'identities'].map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(u)).concat(db.prepare('DELETE FROM users WHERE id = ?').bind(u)));
      return { status: 200, json: { refresh_token: 'late-rotated-token' } };
    };
    const r = await refreshWith(w, s.refreshToken);
    expect(r.status).toBe(401);
    const n = await db.prepare('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM apple_credentials) c, (SELECT COUNT(*) FROM session_families) f, (SELECT COUNT(*) FROM access_tokens) a, (SELECT COUNT(*) FROM refresh_tokens) r').first();
    expect(n).toEqual({ u: 0, c: 0, f: 0, a: 0, r: 0 });
  });

  it('refreshの並行(同じtoken 6本)＋日次照合: 成功は1つ。既存の回転の安全性は保たれる', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-6');
    w.clock.t += DAY + 1000;
    const rs = await Promise.all(Array.from({ length: 6 }, () => refreshWith(w, s.refreshToken)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('保存欠損/復号不能なApple利用者は全session失効(401)。再ログインでcredentialが作り直されて回復する', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-7');
    w.clock.t += DAY + 1000;
    await db.prepare("UPDATE apple_credentials SET enc_refresh_token = 'AAAA' WHERE user_id = ?").bind(s.userId).run();
    expect((await refreshWith(w, s.refreshToken)).status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(401);
    const again = await login(w, 'apple', 'ap-7');
    expect(again.userId).toBe(s.userId);
    expect(await stored(w, s.userId)).toBe('apple-refresh-ap-7');
    // 行そのものが無い場合も同様
    await db.prepare('DELETE FROM apple_credentials WHERE user_id = ?').bind(s.userId).run();
    w.clock.t += DAY + 1000;
    expect((await refreshWith(w, again.refreshToken)).status).toBe(401);
    expect(await stored(w, (await login(w, 'apple', 'ap-7')).userId)).toBe('apple-refresh-ap-7');
  });

  it('Apple設定が欠けた状態のrefreshは503で、tokenは消費されず失効もしない', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-8');
    w.clock.t += DAY + 1000;
    const key = w.env.APPLE_PRIVATE_KEY;
    delete w.env.APPLE_PRIVATE_KEY;
    expect((await refreshWith(w, s.refreshToken)).status).toBe(503);
    w.env.APPLE_PRIVATE_KEY = key;
    expect((await refreshWith(w, s.refreshToken)).status).toBe(200);
  });

  it('未知/期限切れ/使用済みtokenではAppleへ問い合わせない（未認証の呼び出しでApple APIを叩かせない）', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'ap-9');
    w.clock.t += DAY + 1000;
    expect((await refreshWith(w, 'cgr_' + 'B'.repeat(43))).status).toBe(401);
    expect(checks(w)).toBe(0);
    w.clock.t += 40 * DAY;
    expect((await refreshWith(w, s.refreshToken)).status).toBe(401);
    expect(checks(w)).toBe(0);
  });

  it('ログにrefresh token/Appleのtokenを出さない', async () => {
    const w = await appleWorld();
    const logs: string[] = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    let s: Session;
    try {
      s = await login(w, 'apple', 'ap-10');
      w.clock.t += DAY + 1000;
      w.appleRefresh.respond = () => ({ status: 200, json: { refresh_token: 'rotated-secret-ap-10' } });
      const r = await refreshWith(w, s.refreshToken);
      w.appleRefresh.respond = () => ({ status: 400, json: { error: 'invalid_grant' } });
      w.clock.t += DAY + 1000;
      await refreshWith(w, r.json.session.refreshToken);
    } finally {
      [console.log, console.error, console.warn] = orig;
    }
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const sec of ['apple-refresh-ap-10', 'rotated-secret-ap-10', s.refreshToken, s.accessToken]) expect(all).not.toContain(sec);
  });
});

describe('Apple退会: tokenが無い/失効できない場合の扱い', () => {
  async function del(w: World, s: Session, sub: string, extra: Record<string, unknown> = {}) {
    const ch = (await challenge(w, 'apple', 'reauth', s.accessToken)).json;
    const idToken = await signIdToken(w, 'apple', { sub, nonce: ch.nonce });
    return call(w, 'DELETE', '/v1/account', { token: s.accessToken, body: { confirm: 'DELETE', provider: 'apple', challengeId: ch.challengeId, idToken, ...extra } });
  }
  const users = async () => (await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())!.n;

  it('credential行が無い(欠損): 利用者データは削除し、手動失効が必要と正直に返す（成功を偽らない）', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'd-1');
    await db.prepare('DELETE FROM apple_credentials WHERE user_id = ?').bind(s.userId).run();
    let called = 0;
    w.appleRevoke.respond = () => (called++, { status: 200, json: {} });
    const r = await del(w, s, 'd-1');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ deleted: true, appleRevocation: 'manual_required' });
    expect(called).toBe(0);
    expect(await users()).toBe(0);
  });

  it('Appleの恒久エラー(invalid_client等の4xx)は再試行しても直らないので、削除して手動失効を案内', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'd-2');
    w.appleRevoke.respond = () => ({ status: 400, json: { error: 'invalid_client' } });
    const r = await del(w, s, 'd-2');
    expect(r.json.appleRevocation).toBe('manual_required');
    expect(await users()).toBe(0);
  });

  it('一時障害(5xx/通信失敗)は502+retryableで無削除。利用者が明示した場合のみ削除し、手動失効を案内', async () => {
    const w = await appleWorld();
    const s = await login(w, 'apple', 'd-3');
    for (const mode of ['500', 'throw']) {
      w.appleRevoke.respond = () => {
        if (mode === 'throw') throw new Error('net');
        return { status: 503, json: {} };
      };
      const r = await del(w, s, 'd-3');
      expect(r.status, mode).toBe(502);
      expect(r.json.error.retryable).toBe(true);
      expect(await users()).toBe(1);
    }
    const forced = await del(w, s, 'd-3', { forceWithoutAppleRevocation: true });
    expect(forced.status).toBe(200);
    expect(forced.json.appleRevocation).toBe('skipped_manual_required');
    expect(await users()).toBe(0);
    // 強制フラグがあっても、成功する失効は通常どおり行う
    const w2 = await appleWorld();
    const s2 = await login(w2, 'apple', 'd-4');
    const ok = await del(w2, s2, 'd-4', { forceWithoutAppleRevocation: true });
    expect(ok.json.appleRevocation).toBe('revoked');
  });
});
