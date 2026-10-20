/** 失敗はこの形に統一。messageは一般化し、tokenや外部providerの本文を載せない */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

export const MESSAGES: Record<string, string> = {
  invalid_json: 'リクエスト本文がJSONではありません',
  invalid_request: 'リクエストの形式が正しくありません',
  unsupported_media_type: 'Content-Typeはapplication/jsonにしてください',
  payload_too_large: '送信サイズが上限を超えています',
  unauthorized: 'ログインが必要です',
  invalid_token: '認証情報を確認できませんでした',
  invalid_challenge: '認証の手順が無効か期限切れです。最初からやり直してください',
  invalid_refresh_token: 'ログインの更新ができません。もう一度ログインしてください',
  provider_not_configured: 'このログイン方法は現在使えません',
  rate_limited: 'しばらく待ってからやり直してください',
  revision_conflict: '別の端末で保存が更新されています',
  origin_not_allowed: 'このoriginは許可されていません',
  not_found: '見つかりません',
  method_not_allowed: '許可されていないメソッドです',
  apple_exchange_failed: 'Appleとの確認に失敗しました',
  apple_revoke_failed: 'Appleの連携解除に失敗しました。時間をおいてやり直してください',
  provider_unavailable: 'ログイン提供元の確認が一時的にできません。時間をおいてやり直してください',
  internal_error: 'サーバーでエラーが起きました',
};

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function errorResponse(e: HttpError, extraHeaders: Record<string, string> = {}): Response {
  return jsonResponse(e.status, { error: { code: e.code, message: MESSAGES[e.code] ?? MESSAGES.internal_error, ...e.extra } }, { ...e.headers, ...extraHeaders });
}

/** Content-Lengthだけでなく実際に読んだバイト数で上限を守る（ヘッダー偽装対策） */
export async function readJsonBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  const ct = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(ct)) throw new HttpError(415, 'unsupported_media_type');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, 'payload_too_large');
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'invalid_request');
  return parsed as Record<string, unknown>;
}

export function str(body: Record<string, unknown>, key: string, max: number, opts: { optional?: boolean; min?: number } = {}): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.optional) return undefined;
    throw new HttpError(400, 'invalid_request');
  }
  if (typeof v !== 'string' || v.length > max || v.length < (opts.min ?? 1)) throw new HttpError(400, 'invalid_request');
  return v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new HttpError(400, 'invalid_request');
  return v as T;
}
