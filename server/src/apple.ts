import { importPKCS8, SignJWT } from 'jose';
import type { AppleConfig } from './config.ts';
import type { Deps } from './env.ts';
import { HttpError } from './http.ts';

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const TIMEOUT_MS = 5000;

/** Appleのclient_secret(ES256 JWT)。有効期限は短く(5分)して毎回作る */
export async function appleClientSecret(cfg: AppleConfig, nowMs: number): Promise<string> {
  const key = await importPKCS8(cfg.privateKeyPem, 'ES256');
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: cfg.keyId })
    .setIssuer(cfg.teamId)
    .setSubject(cfg.clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(key);
}

async function postForm(deps: Deps, url: string, params: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { status: 0, json: null };
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const p = text ? JSON.parse(text) : null;
    json = p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

export interface AppleTokens {
  refreshToken: string;
  idToken: string;
}

/** authorization code → refresh token。失敗や欠落を成功にしない */
export async function exchangeAuthorizationCode(cfg: AppleConfig, deps: Deps, code: string): Promise<AppleTokens> {
  const secret = await appleClientSecret(cfg, deps.now());
  const r = await postForm(deps, APPLE_TOKEN_URL, { client_id: cfg.clientId, client_secret: secret, code, grant_type: 'authorization_code' });
  const refresh = r.json?.refresh_token;
  const idToken = r.json?.id_token;
  if (r.status !== 200 || typeof refresh !== 'string' || refresh.length === 0 || typeof idToken !== 'string') {
    throw new HttpError(401, 'apple_exchange_failed');
  }
  return { refreshToken: refresh, idToken };
}

export type RefreshCheck = { status: 'valid'; newRefreshToken: string | null } | { status: 'revoked' };

/**
 * 日次照合(TN3194): grant_type=refresh_token で token endpoint へ。
 * 200=有効(新しいrefresh tokenが返れば受け取る)。400 invalid_grant=失効済み。
 * それ以外(5xx/429/timeout/通信失敗/invalid_clientなど自社設定の問題)は「失効」と断定せず provider_unavailable(503)。
 */
export async function checkRefreshToken(cfg: AppleConfig, deps: Deps, refreshToken: string): Promise<RefreshCheck> {
  const secret = await appleClientSecret(cfg, deps.now());
  const r = await postForm(deps, APPLE_TOKEN_URL, { client_id: cfg.clientId, client_secret: secret, grant_type: 'refresh_token', refresh_token: refreshToken });
  if (r.status === 200) {
    const next = r.json?.refresh_token;
    return { status: 'valid', newRefreshToken: typeof next === 'string' && next.length > 0 && next !== refreshToken ? next : null };
  }
  if (r.status === 400 && r.json?.error === 'invalid_grant') return { status: 'revoked' };
  throw new HttpError(503, 'provider_unavailable', {}, { 'retry-after': '60' });
}

export type RevokeOutcome = 'revoked' | 'already_invalid' | 'failed_permanent' | 'failed_transient';

/** 失効結果を分類して返す(例外にしない)。transient=5xx/429/通信失敗(再試行で直りうる)、permanent=その他の4xx */
export async function revokeRefreshTokenClassified(cfg: AppleConfig, deps: Deps, refreshToken: string): Promise<RevokeOutcome> {
  const secret = await appleClientSecret(cfg, deps.now());
  const r = await postForm(deps, APPLE_REVOKE_URL, { client_id: cfg.clientId, client_secret: secret, token: refreshToken, token_type_hint: 'refresh_token' });
  if (r.status === 200) return 'revoked';
  if (r.status === 400 && r.json?.error === 'invalid_grant') return 'already_invalid';
  if (r.status === 0 || r.status === 429 || r.status >= 500) return 'failed_transient';
  return 'failed_permanent';
}
