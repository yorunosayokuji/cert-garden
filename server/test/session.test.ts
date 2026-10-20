import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/util.ts';
import { call, db, login, makeWorld, resetDb } from './helpers.ts';

beforeEach(resetDb);

const refreshWith = (w: Awaited<ReturnType<typeof makeWorld>>, refreshToken: string) => call(w, 'POST', '/v1/auth/refresh', { body: { refreshToken } });

describe('session', () => {
  it('access tokenで保存APIに入れ、DBにはtokenの平文が無い(ハッシュのみ)', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(200);
    const dump = JSON.stringify([
      (await db.prepare('SELECT * FROM access_tokens').all()).results,
      (await db.prepare('SELECT * FROM refresh_tokens').all()).results,
      (await db.prepare('SELECT * FROM auth_challenges').all()).results,
    ]);
    expect(dump).not.toContain(s.accessToken);
    expect(dump).not.toContain(s.refreshToken);
    expect(dump).toContain(await sha256Hex(s.accessToken));
  });

  it('access tokenの期限切れ(15分)で401、改ざん・別形式も401', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken + 'x' })).status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: 'short' })).status).toBe(401);
    w.clock.t += 15 * 60_000 + 1;
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(401);
  });

  it('refresh回転: 新access/refreshが使え、古いaccessは即無効', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    w.clock.t += 20 * 60_000;
    const r = await refreshWith(w, s.refreshToken);
    expect(r.status).toBe(200);
    const n = r.json.session;
    expect(n.accessToken).not.toBe(s.accessToken);
    expect(n.refreshToken).not.toBe(s.refreshToken);
    expect((await call(w, 'GET', '/v1/backup', { token: n.accessToken })).status).toBe(200);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(401);
    const r2 = await refreshWith(w, n.refreshToken);
    expect(r2.status).toBe(200);
  });

  it('使用済みrefreshの再提示(replay)は401で、familyごと失効(正規の最新tokenも死ぬ)', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    const n = (await refreshWith(w, s.refreshToken)).json.session;
    const replay = await refreshWith(w, s.refreshToken);
    expect(replay.status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: n.accessToken })).status).toBe(401);
    expect((await refreshWith(w, n.refreshToken)).status).toBe(401);
  });

  it('同じrefresh tokenを並行8本で回転しても成功は1つ。以後familyは失効', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    const rs = await Promise.all(Array.from({ length: 8 }, () => refreshWith(w, s.refreshToken)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 401)).toHaveLength(7);
    const live = await db.prepare('SELECT COUNT(*) AS n FROM access_tokens').first<{ n: number }>();
    // replay検知後はfamilyのaccessも消えている（成功した1本のaccessも含め使えない）
    expect(live!.n).toBe(0);
  });

  it('refreshの期限切れ(30日)・未知token・形式違いは401', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    expect((await refreshWith(w, 'cgr_' + 'A'.repeat(43))).status).toBe(401);
    expect((await call(w, 'POST', '/v1/auth/refresh', { body: { refreshToken: 12 } })).status).toBe(400);
    w.clock.t += 31 * 24 * 3600_000;
    expect((await refreshWith(w, s.refreshToken)).status).toBe(401);
  });

  it('familyの絶対上限(90日): 回転し続けても超えられない', async () => {
    const w = await makeWorld();
    let s = await login(w, 'google', 'u1');
    for (let i = 0; i < 3; i++) {
      w.clock.t += 25 * 24 * 3600_000;
      const r = await refreshWith(w, s.refreshToken);
      expect(r.status).toBe(200);
      s = r.json.session;
    }
    w.clock.t += 25 * 24 * 3600_000; // 経過 > 90日
    expect((await refreshWith(w, s.refreshToken)).status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(401);
  });

  it('logout: そのセッションのaccess/refreshが失効し、別端末のセッションは生きる', async () => {
    const w = await makeWorld();
    const s1 = await login(w, 'google', 'u1');
    const s2 = await login(w, 'google', 'u1');
    expect((await call(w, 'POST', '/v1/auth/logout', { token: s1.accessToken })).status).toBe(200);
    expect((await call(w, 'GET', '/v1/backup', { token: s1.accessToken })).status).toBe(401);
    expect((await refreshWith(w, s1.refreshToken)).status).toBe(401);
    expect((await call(w, 'POST', '/v1/auth/logout', { token: s1.accessToken })).status).toBe(401);
    expect((await call(w, 'GET', '/v1/backup', { token: s2.accessToken })).status).toBe(200);
  });
});
