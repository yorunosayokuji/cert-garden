// アカウント機能の設定。値は公開してよいもの（API の URL と Google の iOS クライアント ID）だけ。秘密は一切持たない。
// 秘密（Apple の秘密鍵・暗号鍵）は Cloudflare の Worker secret で、アプリにもリポジトリにも置かない。

export interface AccountEnv {
  /** EXPO_PUBLIC_API_BASE_URL */
  apiBaseUrl: string | undefined;
  /** EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID（公開してよい識別子。秘密ではない） */
  googleIosClientId: string | undefined;
  /** 開発実行(__DEV__)か。http の localhost を許すのは開発の明示だけ */
  isDev: boolean;
}

export type AccountConfig =
  | { status: 'ready'; apiBaseUrl: string; googleIosClientId: string }
  | { status: 'unconfigured'; reasons: string[]; apiBaseUrl: string | null; googleIosClientId: string | null };

const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/** HTTPS 固定。開発の明示 localhost だけ http を許す。資格情報・クエリ・ハッシュ付きや相対パスは拒否。末尾の / は除く */
export function normalizeApiBase(raw: string | undefined, isDev: boolean): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol === 'https:') {
    if (loopback && !isDev) return null; // 署名ビルドで localhost を向けない
  } else if (u.protocol === 'http:') {
    if (!(isDev && loopback)) return null;
  } else {
    return null;
  }
  if (u.pathname !== '/' && !/^\/[A-Za-z0-9._~/-]*$/.test(u.pathname)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Google の iOS クライアント ID（<数字>-<英数>.apps.googleusercontent.com）。形だけ検査する */
export const GOOGLE_IOS_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

export function resolveAccountConfig(env: AccountEnv): AccountConfig {
  const reasons: string[] = [];
  const base = normalizeApiBase(env.apiBaseUrl, env.isDev);
  if (!env.apiBaseUrl) reasons.push('EXPO_PUBLIC_API_BASE_URL が未設定');
  else if (!base) reasons.push('EXPO_PUBLIC_API_BASE_URL が HTTPS の URL ではありません（開発の localhost だけ http を許可）');
  const gid = env.googleIosClientId?.trim() ?? '';
  if (!gid) reasons.push('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID が未設定');
  else if (!GOOGLE_IOS_CLIENT_ID.test(gid)) reasons.push('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID の形が正しくありません');
  if (reasons.length === 0 && base) return { status: 'ready', apiBaseUrl: base, googleIosClientId: gid };
  return { status: 'unconfigured', reasons, apiBaseUrl: base, googleIosClientId: GOOGLE_IOS_CLIENT_ID.test(gid) ? gid : null };
}

export type RuntimeKind = 'web' | 'platform' | 'expoGo' | 'native';

/**
 * ログインを使える実行環境か。使えるのは iOS の開発ビルド(expo-dev-client)・署名ビルド・ネイティブプロジェクトだけ。
 * Expo Go は独自の URL スキームを登録できず、Keychain も共有されるため未対応（通信もしない）。
 * expo-constants: executionEnvironment は Expo Go と開発ビルドがどちらも storeClient なので、appOwnership==='expo'（Expo Go）で見分ける。
 */
export function classifyRuntime(i: { platform: string; executionEnvironment: string | undefined; appOwnership: string | null | undefined }): RuntimeKind {
  if (i.platform === 'web') return 'web';
  if (i.platform !== 'ios') return 'platform';
  if (i.executionEnvironment === 'standalone' || i.executionEnvironment === 'bare') return 'native';
  if (i.executionEnvironment === 'storeClient') return i.appOwnership === 'expo' ? 'expoGo' : 'native';
  return 'platform'; // 判定できない環境は使えるものとして扱わない
}

/** session の接続先の組。公開してよい識別子だけ（origin・Google クライアントID・bundle ID）。旧 Bearer を別の接続先へ送らないための目印 */
export function sessionScope(parts: { apiBaseUrl: string | null; googleIosClientId: string | null; bundleId: string | null }): string {
  return [parts.apiBaseUrl ?? '-', parts.googleIosClientId ?? '-', parts.bundleId ?? '-'].join('|');
}

/** com.googleusercontent.apps.<id> の形（クライアントIDのドット区切りを逆順にしたもの）。Google の iOS 向け案内の URL スキーム */
export function reversedClientId(clientId: string): string {
  return clientId.split('.').reverse().join('.');
}

/** Google の iOS クライアントのリダイレクト URI（逆順クライアントIDのスキーム） */
export function googleRedirectUri(clientId: string): string {
  return `${reversedClientId(clientId)}:/oauthredirect`;
}

export const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
} as const;

/** 最小の scope。メールやプロフィールは求めない（本人IDはサーバーが (provider, sub) で決める） */
export const GOOGLE_SCOPES = ['openid'] as const;
