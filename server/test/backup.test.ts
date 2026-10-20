import { beforeEach, describe, expect, it } from 'vitest';
import { call, db, login, makeWorld, req, resetDb, type World } from './helpers.ts';

beforeEach(resetDb);

const core = (points: number) => JSON.stringify({ schemaVersion: 1, wallet: { fruits: 3, maxFruits: 10 }, points, studySeconds: {}, completedThemes: {}, reviews: {}, mastery: {}, stages: {}, completions: {}, log: [] });
const backupOf = (points: number, extra: Record<string, string> = {}) => ({ format: 'certgarden-backup', version: 1, entries: { 'certgarden:core:v1': core(points), ...extra } });
const put = (w: World, token: string, base: number, requestId: string, backup: unknown = backupOf(1)) => call(w, 'PUT', '/v1/backup', { token, body: { baseRevision: base, requestId, backup } });

describe('本人専用の保存 GET/PUT', () => {
  it('初回は空(revision 0)。作成→更新→取得で内容と版が一致', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json).toEqual({ revision: 0, updatedAt: null, backup: null });
    expect((await put(w, s.accessToken, 0, 'req-00000001', backupOf(1))).json).toEqual({ revision: 1, replayed: false });
    expect((await put(w, s.accessToken, 1, 'req-00000002', backupOf(2, { 'certgarden:room:v1': '{"x":1}' }))).json).toEqual({ revision: 2, replayed: false });
    const got = (await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json;
    expect(got.revision).toBe(2);
    expect(JSON.parse(got.backup.entries['certgarden:core:v1']).points).toBe(2);
    expect(got.backup.entries['certgarden:room:v1']).toBe('{"x":1}');
    expect(got.backup.format).toBe('certgarden-backup');
  });

  it('古いbaseRevisionは409で、別端末の保存を上書きしない', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    await put(w, s.accessToken, 0, 'req-00000001', backupOf(1));
    await put(w, s.accessToken, 1, 'req-00000002', backupOf(2)); // 端末Aが更新
    const stale = await put(w, s.accessToken, 1, 'req-0000000B', backupOf(99)); // 端末Bは古い版から
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('revision_conflict');
    expect(stale.json.error.serverRevision).toBe(2);
    const got = (await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json;
    expect(JSON.parse(got.backup.entries['certgarden:core:v1']).points).toBe(2);
    // 存在しない版・既存があるのに0
    expect((await put(w, s.accessToken, 7, 'req-0000000C')).status).toBe(409);
    expect((await put(w, s.accessToken, 0, 'req-0000000D')).status).toBe(409);
  });

  it('再送(同じrequestId+同じ内容)は成功扱いで二重適用しない。内容違いは409', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    expect((await put(w, s.accessToken, 0, 'retry-0001', backupOf(5))).json.replayed).toBe(false);
    const again = await put(w, s.accessToken, 0, 'retry-0001', backupOf(5));
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ revision: 1, replayed: true });
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json.revision).toBe(1);
    expect((await put(w, s.accessToken, 0, 'retry-0001', backupOf(6))).status).toBe(409);
    expect((await put(w, s.accessToken, 0, 'retry-0002', backupOf(5))).status).toBe(409);
  });

  it('初回作成のrace: baseRevision=0を8本同時 → 成功は1つ、残りは409', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => put(w, s.accessToken, 0, `first-race-${i}`, backupOf(i))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json.revision).toBe(1);
  });

  it('更新のrace: 同じbaseRevisionで8本同時 → 成功は1つ、revisionは+1だけ', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    await put(w, s.accessToken, 0, 'seed-000001');
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => put(w, s.accessToken, 1, `upd-race-${i}`, backupOf(100 + i))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json.revision).toBe(2);
  });

  it('2ユーザー分離: 他人の保存は読めず、書いても自分の分に入る。body内のuserId指定は無視', async () => {
    const w = await makeWorld();
    const a = await login(w, 'google', 'alice');
    const b = await login(w, 'google', 'bob');
    await put(w, a.accessToken, 0, 'alice-00001', backupOf(111));
    expect((await call(w, 'GET', '/v1/backup', { token: b.accessToken })).json).toEqual({ revision: 0, updatedAt: null, backup: null });
    const evil = await call(w, 'PUT', '/v1/backup?userId=' + a.userId, { token: b.accessToken, body: { baseRevision: 1, requestId: 'bob-evil-01', userId: a.userId, backup: backupOf(999) } });
    expect(evil.status).toBe(409); // bobは自分の保存が無いので版1は存在しない
    expect((await put(w, b.accessToken, 0, 'bob-00001', backupOf(222))).status).toBe(200);
    const ga = (await call(w, 'GET', '/v1/backup', { token: a.accessToken })).json;
    expect(JSON.parse(ga.backup.entries['certgarden:core:v1']).points).toBe(111);
    const gb = (await call(w, 'GET', '/v1/backup', { token: b.accessToken })).json;
    expect(JSON.parse(gb.backup.entries['certgarden:core:v1']).points).toBe(222);
  });

  it('許可外キー(購入/権利/比較用)・非JSON・core版違い・未知フィールド・形違いは400', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    const bad: unknown[] = [
      backupOf(1, { 'certgarden:entitlement:v1': '{"premium":true}' }),
      backupOf(1, { 'compare:v1': '{}' }),
      backupOf(1, { 'certgarden:room:v1': 'not json' }),
      backupOf(1, { 'certgarden:room:v1': '[1]' }),
      { format: 'certgarden-backup', version: 1, entries: { 'certgarden:core:v1': JSON.stringify({ schemaVersion: 2 }) } },
      { ...backupOf(1), extra: 1 },
      { format: 'certgarden-backup', version: 2, entries: {} },
      { format: 'certgarden-backup', version: 1, entries: {} },
      { format: 'certgarden-backup', version: 1, entries: { 'certgarden:core:v1': { schemaVersion: 1 } } },
    ];
    for (const b of bad) expect((await put(w, s.accessToken, 0, 'bad-request-1', b)).status).toBe(400);
    const badBase = await call(w, 'PUT', '/v1/backup', { token: s.accessToken, body: { baseRevision: -1, requestId: 'bad-request-2', backup: backupOf(1) } });
    expect(badBase.status).toBe(400);
    const badId = await call(w, 'PUT', '/v1/backup', { token: s.accessToken, body: { baseRevision: 0, requestId: 'bad id!!!!', backup: backupOf(1) } });
    expect(badId.status).toBe(400);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json.revision).toBe(0);
  });

  it('大入力: 1MB超のbody、項目400KB超、合計900KB超は413。ストリーム実測でも拒否。保存は変わらない', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    await put(w, s.accessToken, 0, 'seed-000001');
    const huge = JSON.stringify({ k: 'x'.repeat(401_000) });
    expect((await put(w, s.accessToken, 1, 'big-0000001', backupOf(1, { 'certgarden:notebook:v1': huge }))).status).toBe(413);
    const mid = JSON.stringify({ k: 'x'.repeat(350_000) });
    const sum = backupOf(1, { 'certgarden:notebook:v1': mid, 'certgarden:room:v1': mid, 'certgarden:roster:v1': mid });
    expect((await put(w, s.accessToken, 1, 'big-0000002', sum)).status).toBe(413);
    const over = await call(w, 'PUT', '/v1/backup', { token: s.accessToken, headers: { 'content-type': 'application/json' }, raw: 'x'.repeat(1_100_000) });
    expect(over.status).toBe(413);
    const chunk = new TextEncoder().encode('x'.repeat(65_536));
    let n = 0;
    const stream = new ReadableStream({ pull(c) { if (n++ < 20) c.enqueue(chunk); else c.close(); } });
    const r = await w.handle(req('PUT', '/v1/backup', { token: s.accessToken, headers: { 'content-type': 'application/json' }, raw: stream }));
    expect(r.status).toBe(413);
    expect((await call(w, 'GET', '/v1/backup', { token: s.accessToken })).json.revision).toBe(1);
  });

  it('SQLはprepared: SQL風の値を入れても保存されるだけで他表に影響しない', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', "u1'; DROP TABLE users;--");
    const r = await put(w, s.accessToken, 0, "req-'; DROP--", backupOf(1));
    expect(r.status).toBe(400); // requestIdの形式違い
    expect((await put(w, s.accessToken, 0, 'req-ok-0001', backupOf(1, { 'certgarden:notebook:v1': JSON.stringify({ n: "'; DROP TABLE backups;--" }) }))).status).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())!.n).toBe(1);
  });
});

describe('D1 batchは0行更新で自動失敗しない(設計前提の確認)', () => {
  it('条件に合わないUPDATEをbatchに入れても例外にならず changes=0。だからアプリ側で meta.changes を検査している', async () => {
    const w = await makeWorld();
    const s = await login(w, 'google', 'u1');
    await put(w, s.accessToken, 0, 'seed-000001');
    const res = await db.batch([
      db.prepare('UPDATE backups SET revision = revision + 1 WHERE user_id = ? AND revision = ?').bind(s.userId, 999),
      db.prepare('SELECT 1 AS ok'),
    ]);
    expect(res[0].meta.changes).toBe(0);
    expect(res[0].success).toBe(true);
    // 実装側のCASは同じ条件で409を返す
    expect((await put(w, s.accessToken, 999, 'cas-fail-001')).status).toBe(409);
  });

  it('batch内の制約違反は全体がrollbackされる(原子性)', async () => {
    await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind('u_atomic', 1).run();
    await expect(
      db.batch([
        db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind('u_atomic2', 1),
        db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind('u_atomic', 1), // PK衝突
      ]),
    ).rejects.toThrow();
    expect(await db.prepare('SELECT id FROM users WHERE id = ?').bind('u_atomic2').first()).toBeNull();
  });
});
