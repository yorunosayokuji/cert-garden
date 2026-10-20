// Cloudflare Worker (server/) の API クライアント。fetch を注入できる（試験・本番とも実装は同じ）。
// token・nonce・保存内容はログにもエラーにも出さない。エラーは一般化した種類と状態コードだけ。

export type Provider = 'google' | 'apple';

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'badResponse';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly serverRevision?: number;
  constructor(kind: ApiErrorKind, status = 0, code: string = kind, serverRevision?: number) {
    super(`${kind}:${status}:${code}`); // 本文・token は含めない
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    if (serverRevision !== undefined) this.serverRevision = serverRevision;
  }
}

export interface SessionTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

export interface Challenge {
  challengeId: string;
  nonce: string;
  expiresAt: number;
}

export interface BackupGet {
  revision: number;
  updatedAt: number | null;
  backup: { format: string; version: number; entries: Record<string, string> } | null;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface ApiOptions {
  baseUrl: string;
  fetch: FetchLike;
  /** 通常の要求の制限時間 */
  timeoutMs?: number;
  /** バックアップなど大きい本文の制限時間 */
  largeTimeoutMs?: number;
  /** 応答本文の上限（文字数）。サーバーの上限(1MB)より少し大きく */
  maxResponseChars?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseSession(v: unknown): SessionTokens {
  if (!isObj(v) || !isStr(v.accessToken) || !isNum(v.accessExpiresAt) || !isStr(v.refreshToken) || !isNum(v.refreshExpiresAt)) throw new ApiError('badResponse');
  return { accessToken: v.accessToken, accessExpiresAt: v.accessExpiresAt, refreshToken: v.refreshToken, refreshExpiresAt: v.refreshExpiresAt };
}

export class ApiClient {
  private readonly o: Required<ApiOptions>;
  constructor(options: ApiOptions) {
    this.o = { timeoutMs: 15_000, largeTimeoutMs: 40_000, maxResponseChars: 1_300_000, ...options };
  }

  private async call(method: string, path: string, opts: { bearer?: string; body?: unknown; large?: boolean } = {}): Promise<unknown> {
    const ctrl = new AbortController();
    const ms = opts.large ? this.o.largeTimeoutMs : this.o.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
      // fetch の実装によっては abort しても返ってこないことがあるので、abort 自体とも競わせて必ず時間で打ち切る
      const aborted = new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      aborted.catch(() => undefined);
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await Promise.race([this.o.fetch(`${this.o.baseUrl}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : null), signal: ctrl.signal }), aborted]);
      } catch {
        throw new ApiError(timedOut ? 'timeout' : 'network');
      }
      let text: string;
      try {
        text = await Promise.race([res.text(), aborted]);
      } catch {
        throw new ApiError(timedOut ? 'timeout' : 'network', res.status);
      }
      if (text.length > this.o.maxResponseChars) throw new ApiError('badResponse', res.status);
      let json: unknown;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        throw new ApiError('badResponse', res.status);
      }
      if (res.status >= 200 && res.status < 300) return json;
      const e = isObj(json) && isObj(json.error) ? json.error : {};
      const code = isStr(e.code) && /^[a-z_]{1,40}$/.test(e.code) ? e.code : 'error';
      throw new ApiError('http', res.status, code, isNum(e.serverRevision) ? e.serverRevision : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ db: string; providers: { google: boolean; apple: boolean } }> {
    const j = await this.call('GET', '/health');
    if (!isObj(j) || !isObj(j.providers)) throw new ApiError('badResponse');
    return { db: String(j.db), providers: { google: j.providers.google === true, apple: j.providers.apple === true } };
  }

  async challenge(provider: Provider, purpose: 'login' | 'reauth', bearer?: string): Promise<Challenge> {
    const j = await this.call('POST', '/v1/auth/challenge', { body: { provider, purpose }, ...(bearer ? { bearer } : null) });
    if (!isObj(j) || !isStr(j.challengeId) || !isStr(j.nonce) || !isNum(j.expiresAt)) throw new ApiError('badResponse');
    return { challengeId: j.challengeId, nonce: j.nonce, expiresAt: j.expiresAt };
  }

  async exchange(provider: Provider, challengeId: string, idToken: string, authorizationCode?: string): Promise<{ userId: string; session: SessionTokens }> {
    const j = await this.call('POST', '/v1/auth/exchange', { body: { provider, challengeId, idToken, ...(authorizationCode ? { authorizationCode } : null) } });
    if (!isObj(j) || !isObj(j.user) || !isStr(j.user.id)) throw new ApiError('badResponse');
    return { userId: j.user.id, session: parseSession(j.session) };
  }

  async refresh(refreshToken: string): Promise<SessionTokens> {
    const j = await this.call('POST', '/v1/auth/refresh', { body: { refreshToken } });
    if (!isObj(j)) throw new ApiError('badResponse');
    return parseSession(j.session);
  }

  async logout(accessToken: string): Promise<void> {
    await this.call('POST', '/v1/auth/logout', { bearer: accessToken, body: {} });
  }

  async getBackup(accessToken: string): Promise<BackupGet> {
    const j = await this.call('GET', '/v1/backup', { bearer: accessToken, large: true });
    if (!isObj(j) || !isNum(j.revision)) throw new ApiError('badResponse');
    if (j.backup === null) return { revision: j.revision, updatedAt: null, backup: null };
    const b = j.backup;
    if (!isObj(b) || !isStr(b.format) || !isNum(b.version) || !isObj(b.entries)) throw new ApiError('badResponse');
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.entries)) {
      if (!isStr(v)) throw new ApiError('badResponse');
      entries[k] = v;
    }
    return { revision: j.revision, updatedAt: isNum(j.updatedAt) ? j.updatedAt : null, backup: { format: b.format, version: b.version, entries } };
  }

  async putBackup(accessToken: string, baseRevision: number, requestId: string, backup: unknown): Promise<{ revision: number; replayed: boolean }> {
    const j = await this.call('PUT', '/v1/backup', { bearer: accessToken, body: { baseRevision, requestId, backup }, large: true });
    if (!isObj(j) || !isNum(j.revision)) throw new ApiError('badResponse');
    return { revision: j.revision, replayed: j.replayed === true };
  }

  /** DELETE に JSON 本文を付ける（サーバー仕様）。React Native の fetch が実機で本文を送るかは未確認 */
  async deleteAccount(accessToken: string, provider: Provider, challengeId: string, idToken: string, forceWithoutAppleRevocation = false): Promise<{ appleRevocation: string }> {
    const j = await this.call('DELETE', '/v1/account', { bearer: accessToken, body: { confirm: 'DELETE', provider, challengeId, idToken, ...(forceWithoutAppleRevocation ? { forceWithoutAppleRevocation: true } : null) } });
    if (!isObj(j) || j.deleted !== true) throw new ApiError('badResponse');
    return { appleRevocation: isStr(j.appleRevocation) ? j.appleRevocation : 'not_applicable' };
  }
}
