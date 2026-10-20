import type { AppEnv } from './env.ts';
import { b64Decode } from './util.ts';

export interface AppleConfig {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  tokenKey: Uint8Array;
}

export interface Config {
  production: boolean;
  allowedOrigins: Set<string>;
  accessTtlMs: number;
  refreshTtlMs: number;
  /** null = 未設定。そのproviderのログインは503で拒否(fail closed) */
  google: { audiences: string[] } | null;
  apple: AppleConfig | null;
}

/** 1つのログイン系列(family)の絶対上限。refresh回転で延びるがここは超えない */
export const MAX_FAMILY_MS = 90 * 24 * 3600 * 1000;

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const clampInt = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

export function loadConfig(env: AppEnv): Config {
  const audiences = list(env.GOOGLE_CLIENT_IDS);
  const keyBytes = env.APPLE_TOKEN_ENC_KEY ? b64Decode(env.APPLE_TOKEN_ENC_KEY.trim()) : null;
  const pem = (env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  const apple: AppleConfig | null =
    env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && pem.includes('BEGIN PRIVATE KEY') && keyBytes && keyBytes.length === 32
      ? { clientId: env.APPLE_CLIENT_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKeyPem: pem, tokenKey: keyBytes }
      : null;
  return {
    production: env.APP_ENV === 'production',
    // '*' は許可しない（認証付きAPIを任意originへ開かない）
    allowedOrigins: new Set(list(env.ALLOWED_ORIGINS).filter((o) => o !== '*' && /^https?:\/\/[^/*]+$/.test(o))),
    accessTtlMs: clampInt(env.ACCESS_TTL_SECONDS, 900, 60, 3600) * 1000,
    refreshTtlMs: clampInt(env.REFRESH_TTL_SECONDS, 30 * 24 * 3600, 3600, 90 * 24 * 3600) * 1000,
    google: audiences.length > 0 ? { audiences } : null,
    apple,
  };
}
