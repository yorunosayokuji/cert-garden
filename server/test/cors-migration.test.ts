import { env as rawEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { call, db, login, makeWorld, resetDb } from './helpers.ts';

const ORIGIN = 'https://app.example.test';
const ACAO = 'access-control-allow-origin';

describe('CORS: 許可Originには成功にもエラーにも許可ヘッダーを付ける', () => {
  beforeEach(resetDb);

  it('401/400/404/405/409/413/429/503/退会エラーのすべてに付き、読めるヘッダーも公開される', async () => {
    const w = await makeWorld({ apple: false });
    const h = { origin: ORIGIN };
    const s = await login(w, 'google', 'cors-1');
    const results: Record<string, Awaited<ReturnType<typeof call>>> = {
      '401': await call(w, 'GET', '/v1/backup', { headers: h }),
      '400': await call(w, 'POST', '/v1/auth/challenge', { headers: { ...h, 'content-type': 'application/json' }, raw: '{bad' }),
      '404': await call(w, 'GET', '/nowhere', { headers: h }),
      '405': await call(w, 'GET', '/v1/auth/refresh', { headers: h }),
      '409': await call(w, 'PUT', '/v1/backup', { token: s.accessToken, headers: h, body: { baseRevision: 5, requestId: 'cors-req-001', backup: { format: 'certgarden-backup', version: 1, entries: { 'certgarden:core:v1': '{"schemaVersion":1}' } } } }),
      '413': await call(w, 'POST', '/v1/auth/challenge', { headers: { ...h, 'content-type': 'application/json' }, raw: 'x'.repeat(20_000) }),
      '503': await call(w, 'POST', '/v1/auth/challenge', { headers: h, body: { provider: 'apple' } }),
      '200': await call(w, 'GET', '/v1/backup', { token: s.accessToken, headers: h }),
    };
    for (const [status, r] of Object.entries(results)) {
      expect(r.status, status).toBe(Number(status));
      expect(r.res.headers.get(ACAO), status).toBe(ORIGIN);
      expect(r.res.headers.get('vary'), status).toContain('Origin');
      expect(r.res.headers.get('access-control-expose-headers'), status).toContain('retry-after');
    }
    for (let i = 0; i < 31; i++) await call(w, 'POST', '/v1/auth/challenge', { headers: { ...h, 'cf-connecting-ip': '198.51.100.7' }, body: { provider: 'google' } });
    const limited = await call(w, 'POST', '/v1/auth/challenge', { headers: { ...h, 'cf-connecting-ip': '198.51.100.7' }, body: { provider: 'google' } });
    expect(limited.status).toBe(429);
    expect(limited.res.headers.get(ACAO)).toBe(ORIGIN);
  });

  it('不正Originには成功でもエラーでも許可ヘッダーを付けず403。Origin無し(ネイティブ)は付かない', async () => {
    const w = await makeWorld();
    for (const origin of ['https://evil.example', 'null', 'http://app.example.test']) {
      const r = await call(w, 'GET', '/health', { headers: { origin } });
      expect(r.status).toBe(403);
      expect(r.res.headers.get(ACAO)).toBeNull();
      expect(r.res.headers.get('access-control-allow-credentials')).toBeNull();
    }
    const native = await call(w, 'GET', '/v1/backup');
    expect(native.status).toBe(401);
    expect(native.res.headers.get(ACAO)).toBeNull();
  });
});

describe('migration 0002: 初期DBと、0001だけ適用済みの既存ローカルDBの両方', () => {
  const MIG = (rawEnv as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }).TEST_MIGRATIONS;
  const run = (queries: string[]) => db.batch(queries.map((q) => db.prepare(q)));
  const wipe = async () => {
    // 子 → 親の順に落とす（FK有効でも失敗しない）
    const order = ['rate_limits', 'backups', 'apple_credentials', 'refresh_tokens', 'access_tokens', 'session_families', 'auth_challenges', 'identities', 'users'];
    await db.batch(order.map((n) => db.prepare(`DROP TABLE IF EXISTS "${n}"`)));
  };

  it('名前と順序の確認 + 初期DB(0001→0002)に新カラムとdefaultがある', async () => {
    expect(MIG.map((m) => m.name)).toEqual(['0001_init.sql', '0002_apple_token_freshness.sql']);
    const cols = (await db.prepare("SELECT name, dflt_value AS d, [notnull] AS nn FROM pragma_table_info('apple_credentials')").all<{ name: string; d: string | null; nn: number }>()).results;
    expect(cols.find((c) => c.name === 'last_checked_at')).toMatchObject({ d: '0', nn: 1 });
    expect(cols.find((c) => c.name === 'version')).toMatchObject({ d: '1', nn: 1 });
  });

  it('0001のみのDBに実データがある状態から0002を適用 → 既存行は保持され「次のrefreshで照合」になり、全機能が動く', async () => {
    try {
      await wipe();
      await run(MIG[0]!.queries);
      await db.batch([
        db.prepare("INSERT INTO users (id, created_at) VALUES ('u_legacy', 1)"),
        db.prepare("INSERT INTO identities (provider, sub, user_id, created_at) VALUES ('apple', 'legacy-sub', 'u_legacy', 1)"),
        db.prepare("INSERT INTO apple_credentials (user_id, enc_refresh_token, iv, created_at) VALUES ('u_legacy', 'ct-legacy', 'iv-legacy', 1)"),
        db.prepare("INSERT INTO backups (user_id, revision, payload, payload_sha256, byte_size, last_request_id, updated_at) VALUES ('u_legacy', 3, '{}', 'x', 2, 'req-legacy', 1)"),
      ]);
      await run(MIG[1]!.queries);
      const row = await db.prepare('SELECT * FROM apple_credentials WHERE user_id = ?').bind('u_legacy').first<Record<string, unknown>>();
      expect(row).toMatchObject({ enc_refresh_token: 'ct-legacy', iv: 'iv-legacy', created_at: 1, last_checked_at: 0, version: 1 });
      expect((await db.prepare("SELECT revision FROM backups WHERE user_id = 'u_legacy'").first<{ revision: number }>())!.revision).toBe(3);
      // 新しいschemaでアプリが動く（0002適用後のDBで通しログイン→保存）
      const w = await makeWorld();
      const s = await login(w, 'google', 'after-migration');
      expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).status).toBe(200);
    } finally {
      await wipe();
      for (const m of MIG) await run(m.queries);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('apple_credentials')").first<{ n: number }>())!.n).toBe(6);
  });
});
