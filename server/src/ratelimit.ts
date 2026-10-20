import { HttpError } from './http.ts';
import { sha256Hex } from './util.ts';

/**
 * D1の固定窓カウンタ。isolate間で共有されるのでinstanceメモリだけに頼らない。
 * 1文のUPSERT...RETURNINGで加算と取得を原子的に行う。
 * 注意: 大量攻撃の遮断はCloudflare側(WAF/Rate Limiting rules)の役目で、ここは濫用の抑止。
 */
export async function hit(db: D1Database, route: string, who: string, limit: number, windowSec: number, nowMs: number): Promise<void> {
  const windowStart = Math.floor(nowMs / 1000 / windowSec) * windowSec;
  const bucket = `${route}:${(await sha256Hex(who)).slice(0, 24)}`;
  const row = await db
    .prepare('INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count')
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  if (!row || row.count > limit) {
    const retryAfter = Math.max(1, windowStart + windowSec - Math.floor(nowMs / 1000));
    throw new HttpError(429, 'rate_limited', {}, { 'retry-after': String(retryAfter) });
  }
}

/** 期限切れの行を掃除する（challenge発行時に呼ぶ軽い保守） */
export async function housekeeping(db: D1Database, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(nowMs / 1000) - 86400),
    db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').bind(nowMs - 3600_000),
    db.prepare('DELETE FROM access_tokens WHERE expires_at < ?').bind(nowMs),
    db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').bind(nowMs),
    db.prepare('DELETE FROM session_families WHERE expires_at < ?').bind(nowMs - 86400_000),
  ]);
}
