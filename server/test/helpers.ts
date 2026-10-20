import { env as rawEnv } from 'cloudflare:workers';
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, importJWK, type JWK, type CryptoKey as JoseKey } from 'jose';
import { createHandler } from '../src/app.ts';
import type { AppEnv, Deps } from '../src/env.ts';
import { b64urlEncode, randomBytes } from '../src/util.ts';

export const BASE = 'https://api.test';
export const GOOGLE_AUD = 'test-google-client.apps.googleusercontent.com';
export const APPLE_AUD = 'com.example.certgarden.test';
export const T0 = Date.UTC(2026, 9, 20, 0, 0, 0);

export const db = (rawEnv as unknown as { DB: D1Database }).DB;

const TABLES = ['rate_limits', 'backups', 'apple_credentials', 'refresh_tokens', 'access_tokens', 'session_families', 'auth_challenges', 'identities', 'users'];
export async function resetDb(): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

export interface Keys {
  privateKey: JoseKey;
  jwk: JWK;
  kid: string;
}

async function rsa(kid: string): Promise<Keys> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true, modulusLength: 2048 });
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }, kid };
}

export interface World {
  clock: { t: number };
  env: AppEnv;
  handle: (req: Request) => Promise<Response>;
  google: Keys;
  apple: Keys;
  rogue: Keys;
  appleEc: { jwk: JWK; pem: string };
  calls: { url: string; body: string }[];
  /** Apple /auth/token の応答を差し替える */
  appleToken: { respond: (params: URLSearchParams, world: World) => Promise<{ status: number; json: unknown }> };
  appleRevoke: { respond: (params: URLSearchParams) => { status: number; json: unknown } };
  /** Apple /auth/token の grant_type=refresh_token（日次照合）の応答 */
  appleRefresh: { respond: (params: URLSearchParams) => Promise<{ status: number; json: unknown }> | { status: number; json: unknown } };
  jwksFetches: { google: number; apple: number };
  /** JWKSに載せる追加鍵(kidローテーション試験) */
  extraGoogleKeys: JWK[];
  deps: Deps;
}

export interface WorldOptions {
  google?: boolean;
  apple?: boolean | 'no-private-key' | 'no-enc-key';
  origins?: string;
}

export async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const [google, apple, rogue] = await Promise.all([rsa('g-key-1'), rsa('a-key-1'), rsa('g-key-1')]);
  const ec = await generateKeyPair('ES256', { extractable: true });
  const appleEc = { jwk: { ...(await exportJWK(ec.publicKey)), kid: 'APPLEKEYID1', alg: 'ES256' }, pem: await exportPKCS8(ec.privateKey) };
  const clock = { t: T0 };
  const calls: World['calls'] = [];
  const jwksFetches = { google: 0, apple: 0 };
  const extraGoogleKeys: JWK[] = [];
  const world = {} as World;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const deps: Deps = {
    now: () => clock.t,
    fetch: async (url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url, body });
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        jwksFetches.google++;
        return json(200, { keys: [google.jwk, ...extraGoogleKeys] });
      }
      if (url === 'https://appleid.apple.com/auth/keys') {
        jwksFetches.apple++;
        return json(200, { keys: [apple.jwk] });
      }
      if (url === 'https://appleid.apple.com/auth/token') {
        const r = await world.appleToken.respond(new URLSearchParams(body), world);
        return json(r.status, r.json);
      }
      if (url === 'https://appleid.apple.com/auth/revoke') {
        const r = world.appleRevoke.respond(new URLSearchParams(body));
        return json(r.status, r.json);
      }
      throw new Error(`unexpected outbound fetch: ${url}`);
    },
  };
  const e: AppEnv = {
    DB: db,
    APP_ENV: 'development',
    ALLOWED_ORIGINS: opts.origins ?? 'https://app.example.test',
    GOOGLE_CLIENT_IDS: opts.google === false ? '' : GOOGLE_AUD,
  };
  if (opts.apple !== false && opts.apple !== undefined) {
    e.APPLE_CLIENT_ID = APPLE_AUD;
    e.APPLE_TEAM_ID = 'TEAM123456';
    e.APPLE_KEY_ID = 'APPLEKEYID1';
    if (opts.apple !== 'no-private-key') e.APPLE_PRIVATE_KEY = appleEc.pem;
    if (opts.apple !== 'no-enc-key') e.APPLE_TOKEN_ENC_KEY = btoa(String.fromCharCode(...randomBytes(32)));
  }
  const handler = createHandler(deps);
  Object.assign(world, {
    clock,
    env: e,
    handle: (req: Request) => handler(req, e),
    google,
    apple,
    rogue,
    appleEc,
    calls,
    jwksFetches,
    extraGoogleKeys,
    deps,
    appleToken: { respond: async () => ({ status: 400, json: { error: 'invalid_grant' } }) },
    appleRevoke: { respond: () => ({ status: 200, json: {} }) },
    appleRefresh: { respond: () => ({ status: 200, json: { access_token: 'x' } }) },
  });
  return world;
}

export interface TokenOpts {
  keys?: Keys;
  kid?: string;
  iss?: string;
  aud?: string;
  sub?: string;
  nonce?: string | null;
  iatOffsetSec?: number;
  expOffsetSec?: number;
  alg?: string;
}

export async function signIdToken(w: World, provider: 'google' | 'apple', o: TokenOpts = {}): Promise<string> {
  const keys = o.keys ?? (provider === 'google' ? w.google : w.apple);
  const iat = Math.floor(w.clock.t / 1000) + (o.iatOffsetSec ?? 0);
  const claims: Record<string, unknown> = {};
  if (o.nonce !== null) claims.nonce = o.nonce;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: (o.alg ?? 'RS256') as 'RS256', kid: o.kid ?? keys.kid })
    .setIssuer(o.iss ?? (provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com'))
    .setAudience(o.aud ?? (provider === 'google' ? GOOGLE_AUD : APPLE_AUD))
    .setSubject(o.sub ?? 'sub-1')
    .setIssuedAt(iat)
    .setExpirationTime(iat + (o.expOffsetSec ?? 600))
    .sign(keys.privateKey);
}

export function req(method: string, path: string, init: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: BodyInit | null } = {}): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: BodyInit | null | undefined = init.raw;
  if (init.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(init.body);
  }
  const r: RequestInit & { duplex?: string } = { method, headers, body };
  if (body instanceof ReadableStream) r.duplex = 'half';
  return new Request(BASE + path, r);
}

export async function call(w: World, method: string, path: string, init: Parameters<typeof req>[2] = {}): Promise<{ status: number; json: any; res: Response }> {
  const res = await w.handle(req(method, path, init));
  const text = await res.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = text;
  }
  return { status: res.status, json: j as any, res };
}

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export async function challenge(w: World, provider: 'google' | 'apple', purpose: 'login' | 'reauth' = 'login', token?: string) {
  const r = await call(w, 'POST', '/v1/auth/challenge', { body: { provider, purpose }, token });
  return r;
}

/** Google/Appleの通しログイン。Appleはtoken endpointが応答する前提(appleTokenを設定済みであること) */
export async function login(w: World, provider: 'google' | 'apple', sub: string, extra: Partial<TokenOpts> = {}): Promise<Session> {
  const ch = await challenge(w, provider);
  if (ch.status !== 200) throw new Error(`challenge failed ${ch.status}`);
  const idToken = await signIdToken(w, provider, { sub, nonce: ch.json.nonce, ...extra });
  const body: Record<string, unknown> = { provider, challengeId: ch.json.challengeId, idToken };
  if (provider === 'apple') body.authorizationCode = 'code-' + sub;
  const r = await call(w, 'POST', '/v1/auth/exchange', { body });
  if (r.status !== 200) throw new Error(`exchange failed ${r.status} ${JSON.stringify(r.json)}`);
  return { userId: r.json.user.id, ...r.json.session };
}

/** Appleのtoken endpointを「正しいclient_secretを検証して、同じsubのid_tokenとrefresh tokenを返す」実装にする */
export function installAppleTokenServer(w: World, refreshTokenFor: (sub: string) => string = (s) => `apple-refresh-${s}`): void {
  w.appleToken.respond = async (params, world) => {
    if (params.get('grant_type') === 'refresh_token') return world.appleRefresh.respond(params);
    const secret = params.get('client_secret') ?? '';
    const pub = await importJWK(world.appleEc.jwk, 'ES256');
    await jwtVerify(secret, pub, { issuer: 'TEAM123456', subject: APPLE_AUD, audience: 'https://appleid.apple.com', algorithms: ['ES256'], currentDate: new Date(world.clock.t) });
    if (params.get('client_id') !== APPLE_AUD || params.get('grant_type') !== 'authorization_code') return { status: 400, json: { error: 'invalid_request' } };
    const code = params.get('code') ?? '';
    const sub = code.replace(/^code-/, '');
    return { status: 200, json: { refresh_token: refreshTokenFor(sub), id_token: await signIdToken(world, 'apple', { sub, nonce: null }) } };
  };
}

export const b64 = b64urlEncode;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
