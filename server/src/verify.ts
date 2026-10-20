import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import type { Config } from './config.ts';
import type { Deps } from './env.ts';
import { HttpError } from './http.ts';

export type Provider = 'google' | 'apple';

/** 公式の固定URL・issuer（クライアント申告やconfigで差し替えない） */
export const PROVIDERS = {
  google: { jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] },
  apple: { jwksUrl: 'https://appleid.apple.com/auth/keys', issuers: ['https://appleid.apple.com'] },
} as const;

const JWKS_TTL_MS = 3600_000;
const JWKS_REFETCH_COOLDOWN_MS = 30_000;
const FETCH_TIMEOUT_MS = 5000;

interface CacheEntry {
  set: JSONWebKeySet;
  fetchedAt: number;
}

/** isolate内のJWKSキャッシュ。未知kidのときだけ(クールダウン付きで)再取得する */
export class JwksCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  private async fetchSet(url: string): Promise<JSONWebKeySet> {
    let res: Response;
    try {
      res = await this.deps.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
    } catch {
      throw new HttpError(503, 'provider_not_configured');
    }
    if (!res.ok) throw new HttpError(503, 'provider_not_configured');
    const text = await res.text();
    if (text.length > 200_000) throw new HttpError(503, 'provider_not_configured');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(503, 'provider_not_configured');
    }
    const keys = (parsed as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) throw new HttpError(503, 'provider_not_configured');
    return { keys: keys as JSONWebKeySet['keys'] };
  }

  async get(url: string, kid: string): Promise<JSONWebKeySet> {
    const now = this.deps.now();
    const cached = this.entries.get(url);
    const hasKid = cached?.set.keys.some((k) => k.kid === kid) ?? false;
    const fresh = cached !== undefined && now - cached.fetchedAt < JWKS_TTL_MS;
    if (cached && fresh && hasKid) return cached.set;
    // 未知kid or 期限切れ: クールダウン外のときだけ再取得（不正kid連打でGoogle/Appleへ増幅しない）
    if (cached && now - cached.fetchedAt < JWKS_REFETCH_COOLDOWN_MS) return cached.set;
    const set = await this.fetchSet(url);
    this.entries.set(url, { set, fetchedAt: now });
    return set;
  }
}

export interface VerifiedIdentity {
  sub: string;
  nonce: string | undefined;
}

export interface VerifyOptions {
  /** Apple token endpoint が返す id_token など、nonce を要求しない検証 */
  requireNonce: boolean;
}

export function audiencesFor(provider: Provider, cfg: Config): string[] {
  if (provider === 'google') return cfg.google?.audiences ?? [];
  return cfg.apple ? [cfg.apple.clientId] : [];
}

/**
 * 署名(JWKS)・alg固定(RS256)・issuer固定・audience(設定値)・期限・必須claimを検証する。
 * 失敗理由はクライアントへ区別して返さない(invalid_token)。
 */
export async function verifyIdToken(provider: Provider, idToken: string, cfg: Config, cache: JwksCache, deps: Deps, opts: VerifyOptions = { requireNonce: true }): Promise<VerifiedIdentity> {
  const audiences = audiencesFor(provider, cfg);
  if (audiences.length === 0) throw new HttpError(503, 'provider_not_configured');
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(idToken);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('bad header');
    kid = header.kid;
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
  const set = await cache.get(PROVIDERS[provider].jwksUrl, kid);
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(set), {
      issuer: [...PROVIDERS[provider].issuers],
      audience: audiences,
      algorithms: ['RS256'],
      currentDate: new Date(deps.now()),
      clockTolerance: 5,
      maxTokenAge: '2 hours',
      requiredClaims: opts.requireNonce ? ['exp', 'iat', 'sub', 'nonce'] : ['exp', 'iat', 'sub'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) throw new Error('bad sub');
    if (opts.requireNonce && typeof payload.nonce !== 'string') throw new Error('bad nonce');
    return { sub: payload.sub, nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined };
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
}
