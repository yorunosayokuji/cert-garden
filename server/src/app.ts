import { authenticate, createChallenge, deleteAccount, exchange, logout, refresh, type Ctx } from './auth.ts';
import { getBackup, MAX_BODY_BYTES, putBackup, validateBackup } from './backup.ts';
import { loadConfig } from './config.ts';
import type { AppEnv, Deps } from './env.ts';
import { errorResponse, HttpError, jsonResponse, readJsonBody, str } from './http.ts';
import { hit } from './ratelimit.ts';
import { randomId } from './util.ts';
import { JwksCache } from './verify.ts';

const SMALL_BODY = 16_384;

/** 実装本体。外部依存(now/fetch)は注入。本番入口は index.ts で実物だけを渡す。 */
export function createHandler(deps: Deps) {
  const jwks = new JwksCache(deps);

  return async function handle(request: Request, env: AppEnv): Promise<Response> {
    const started = deps.now();
    const reqId = randomId('r');
    const url = new URL(request.url);
    let status = 500;
    let code = 'ok';
    let res: Response;
    // 許可済みOriginのときだけ埋まる。成功/エラーの両方に付けないと、ブラウザーがAPIエラー(401/409等)を読めない
    const cors: Record<string, string> = {};
    try {
      const cfg = loadConfig(env);
      const origin = request.headers.get('origin');
      if (origin !== null) {
        // ブラウザーは明示allowlistのoriginだけ。ネイティブ(Origin無し)は通常通り
        if (!cfg.allowedOrigins.has(origin)) throw new HttpError(403, 'origin_not_allowed');
        cors['access-control-allow-origin'] = origin;
        cors['vary'] = 'Origin';
        cors['access-control-allow-headers'] = 'authorization, content-type';
        cors['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        cors['access-control-max-age'] = '600';
        cors['access-control-expose-headers'] = 'retry-after, x-request-id';
      }
      if (request.method === 'OPTIONS') {
        res = new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...cors } });
      } else {
        const ctx: Ctx = { env, cfg, deps, jwks, db: env.DB };
        const r = await route(ctx, request, url);
        res = new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...cors } });
      }
      status = res.status;
    } catch (e) {
      if (e instanceof HttpError) {
        code = e.code;
        status = e.status;
        res = errorResponse(e, cors);
      } else {
        // 例外の本文にtoken等が入りうるので名前だけ記録
        code = 'internal_error';
        status = 500;
        res = errorResponse(new HttpError(500, 'internal_error'), cors);
        console.error(JSON.stringify({ evt: 'unhandled', id: reqId, name: e instanceof Error ? e.name : 'unknown' }));
      }
    }
    console.log(JSON.stringify({ evt: 'req', id: reqId, method: request.method, path: url.pathname, status, code, ms: deps.now() - started }));
    const headers = new Headers(res.headers);
    headers.set('x-request-id', reqId);
    if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  };
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'no-ip';
}

function methodOnly(request: Request, method: string): void {
  if (request.method !== method) throw new HttpError(405, 'method_not_allowed', {}, { allow: method });
}

async function route(ctx: Ctx, request: Request, url: URL): Promise<Response> {
  const now = ctx.deps.now();
  const ip = clientIp(request);
  switch (url.pathname) {
    case '/health': {
      methodOnly(request, 'GET');
      let db = 'ok';
      try {
        await ctx.db.prepare('SELECT 1').first();
      } catch {
        db = 'error';
      }
      return jsonResponse(db === 'ok' ? 200 : 503, {
        status: db === 'ok' ? 'ok' : 'degraded',
        service: 'cert-garden-api',
        db,
        // 設定の有無だけ（値は返さない）。falseのproviderは503で拒否される
        providers: { google: ctx.cfg.google !== null, apple: ctx.cfg.apple !== null },
      });
    }
    case '/v1/auth/challenge': {
      methodOnly(request, 'POST');
      await hit(ctx.db, 'challenge', ip, 30, 600, now);
      const body = await readJsonBody(request, SMALL_BODY);
      const authed = body.purpose === 'reauth' ? await authenticate(ctx, request) : null;
      return jsonResponse(200, await createChallenge(ctx, body, authed));
    }
    case '/v1/auth/exchange': {
      methodOnly(request, 'POST');
      await hit(ctx.db, 'exchange', ip, 20, 600, now);
      return jsonResponse(200, await exchange(ctx, await readJsonBody(request, SMALL_BODY)));
    }
    case '/v1/auth/refresh': {
      methodOnly(request, 'POST');
      await hit(ctx.db, 'refresh', ip, 60, 600, now);
      return jsonResponse(200, await refresh(ctx, await readJsonBody(request, SMALL_BODY)));
    }
    case '/v1/auth/logout': {
      methodOnly(request, 'POST');
      const a = await authenticate(ctx, request);
      await hit(ctx.db, 'logout', a.userId, 30, 600, now);
      return jsonResponse(200, await logout(ctx, a));
    }
    case '/v1/account': {
      methodOnly(request, 'DELETE');
      const a = await authenticate(ctx, request);
      await hit(ctx.db, 'account-delete', a.userId, 5, 600, now);
      return jsonResponse(200, await deleteAccount(ctx, a, await readJsonBody(request, SMALL_BODY)));
    }
    case '/v1/backup': {
      if (request.method === 'GET') {
        const a = await authenticate(ctx, request);
        await hit(ctx.db, 'backup-read', a.userId, 120, 600, now);
        const row = await getBackup(ctx.db, a.userId);
        return jsonResponse(200, row ? { revision: row.revision, updatedAt: row.updatedAt, backup: row.backup } : { revision: 0, updatedAt: null, backup: null });
      }
      if (request.method === 'PUT') {
        const a = await authenticate(ctx, request);
        await hit(ctx.db, 'backup-write', a.userId, 60, 600, now);
        const body = await readJsonBody(request, MAX_BODY_BYTES);
        const base = body.baseRevision;
        if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0) throw new HttpError(400, 'invalid_request');
        const requestId = str(body, 'requestId', 64, { min: 8 })!;
        if (!/^[A-Za-z0-9_-]+$/.test(requestId)) throw new HttpError(400, 'invalid_request');
        const backup = validateBackup(body.backup);
        const r = await putBackup(ctx.db, a.userId, base, requestId, backup, now);
        if (r.kind === 'conflict') throw new HttpError(409, 'revision_conflict', { serverRevision: r.serverRevision });
        return jsonResponse(200, { revision: r.revision, replayed: r.replayed });
      }
      throw new HttpError(405, 'method_not_allowed', {}, { allow: 'GET, PUT' });
    }
    default:
      throw new HttpError(404, 'not_found');
  }
}
