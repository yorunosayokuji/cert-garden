/** Worker binding。vars は公開してよい設定、SECRET は `wrangler secret put` で入れる。 */
export interface AppEnv {
  DB: D1Database;
  // vars（公開可）
  APP_ENV?: string;
  ALLOWED_ORIGINS?: string;
  GOOGLE_CLIENT_IDS?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  ACCESS_TTL_SECONDS?: string;
  REFRESH_TTL_SECONDS?: string;
  // secrets
  APPLE_PRIVATE_KEY?: string;
  APPLE_TOKEN_ENC_KEY?: string;
}

/** テストで差し替えられる外部依存。本番入口(index.ts)は実の fetch / Date.now だけを渡す。 */
export interface Deps {
  now(): number;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
