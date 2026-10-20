import { HttpError } from './http.ts';
import { sha256Hex } from './util.ts';

/**
 * クラウド保存は「端末データのバックアップ」であり、課金済み権利・購入レシートの証明ではない。
 * 端末の既存キー(mobile/src/state/*)のうち、学習/箱庭/メモのものだけを許可する。
 * 比較用 compare:v1 や、認証token・購入に関わるキーは受け付けない。
 */
export const ALLOWED_KEYS = [
  'certgarden:core:v1',
  'certgarden:diagnostic:v1',
  'certgarden:roster:v1',
  'certgarden:holds:v1',
  'certgarden:room:v1',
  'certgarden:notebook:v1',
  'certgarden:settings:v1',
  'certgarden:furniture:v1',
  'certgarden:learnprefs:v1',
] as const;

export const BACKUP_FORMAT = 'certgarden-backup';
export const BACKUP_VERSION = 1;
export const MAX_ENTRY_BYTES = 400_000;
export const MAX_TOTAL_BYTES = 900_000;
export const MAX_BODY_BYTES = 1_000_000;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** キー → 端末が保存しているJSON文字列(そのまま) */
  entries: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** 形・キー許可・サイズ・各値がJSONオブジェクトであることを検証する。意味の復元可否は端末側の責務 */
export function validateBackup(raw: unknown): Backup {
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT || raw.version !== BACKUP_VERSION || !isObj(raw.entries)) throw new HttpError(400, 'invalid_request');
  const keys = Object.keys(raw.entries);
  if (keys.length === 0 || keys.length > ALLOWED_KEYS.length) throw new HttpError(400, 'invalid_request');
  // extra top-level fields are rejected so unknown data never persists
  if (Object.keys(raw).some((k) => k !== 'format' && k !== 'version' && k !== 'entries')) throw new HttpError(400, 'invalid_request');
  const entries: Record<string, string> = {};
  let total = 0;
  for (const key of [...keys].sort()) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) throw new HttpError(400, 'invalid_request');
    const v = (raw.entries as Record<string, unknown>)[key];
    if (typeof v !== 'string') throw new HttpError(400, 'invalid_request');
    const n = bytes(v);
    total += n;
    if (n > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new HttpError(413, 'payload_too_large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      throw new HttpError(400, 'invalid_request');
    }
    if (!isObj(parsed)) throw new HttpError(400, 'invalid_request');
    if (key === 'certgarden:core:v1' && parsed.schemaVersion !== 1) throw new HttpError(400, 'invalid_request');
    entries[key] = v;
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, entries };
}

export async function canonical(b: Backup): Promise<{ payload: string; sha: string; size: number }> {
  const payload = JSON.stringify({ format: b.format, version: b.version, entries: b.entries });
  return { payload, sha: await sha256Hex(payload), size: bytes(payload) };
}

export interface BackupRow {
  revision: number;
  payload: string;
  payload_sha256: string;
  last_request_id: string;
  updated_at: number;
}

export type PutResult = { kind: 'ok'; revision: number; replayed: boolean } | { kind: 'conflict'; serverRevision: number };

/**
 * 本人(userId)のバックアップをCASで書く。
 * 「N行更新されたか」を meta.changes で明示確認する（D1 batch は0行更新で失敗扱いにならない）。
 * baseRevision=0 は初回作成: 主キー衝突は ON CONFLICT DO NOTHING で0行になり、敗者は409。
 * 同じ requestId+内容の再送が既に反映済みなら、成功(replayed)として返し二重適用しない。
 */
export async function putBackup(db: D1Database, userId: string, baseRevision: number, requestId: string, b: Backup, nowMs: number): Promise<PutResult> {
  const { payload, sha, size } = await canonical(b);
  let changes: number;
  if (baseRevision === 0) {
    const r = await db
      .prepare('INSERT INTO backups (user_id, revision, payload, payload_sha256, byte_size, last_request_id, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING')
      .bind(userId, payload, sha, size, requestId, nowMs)
      .run();
    changes = r.meta.changes;
  } else {
    const r = await db
      .prepare('UPDATE backups SET payload = ?, payload_sha256 = ?, byte_size = ?, revision = revision + 1, last_request_id = ?, updated_at = ? WHERE user_id = ? AND revision = ?')
      .bind(payload, sha, size, requestId, nowMs, userId, baseRevision)
      .run();
    changes = r.meta.changes;
  }
  if (changes === 1) return { kind: 'ok', revision: baseRevision + 1, replayed: false };
  const cur = await db.prepare('SELECT revision, payload_sha256, last_request_id FROM backups WHERE user_id = ?').bind(userId).first<{ revision: number; payload_sha256: string; last_request_id: string }>();
  if (!cur) return { kind: 'conflict', serverRevision: 0 };
  if (cur.revision === baseRevision + 1 && cur.last_request_id === requestId && cur.payload_sha256 === sha) return { kind: 'ok', revision: cur.revision, replayed: true };
  return { kind: 'conflict', serverRevision: cur.revision };
}

export async function getBackup(db: D1Database, userId: string): Promise<{ revision: number; updatedAt: number; backup: Backup } | null> {
  const row = await db.prepare('SELECT revision, payload, updated_at FROM backups WHERE user_id = ?').bind(userId).first<{ revision: number; payload: string; updated_at: number }>();
  if (!row) return null;
  return { revision: row.revision, updatedAt: row.updated_at, backup: JSON.parse(row.payload) as Backup };
}
