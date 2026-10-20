import { checkRefreshToken, exchangeAuthorizationCode, revokeRefreshTokenClassified } from './apple.ts';
import type { Config } from './config.ts';
import { MAX_FAMILY_MS } from './config.ts';
import type { AppEnv, Deps } from './env.ts';
import { HttpError, oneOf, str } from './http.ts';
import { housekeeping } from './ratelimit.ts';
import { decryptSecret, encryptSecret, randomId, randomToken, sha256Hex, timingSafeEqual } from './util.ts';
import { audiencesFor, verifyIdToken, type JwksCache, type Provider } from './verify.ts';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PROVIDER_LIST = ['google', 'apple'] as const;

export interface Ctx {
  env: AppEnv;
  cfg: Config;
  deps: Deps;
  jwks: JwksCache;
  db: D1Database;
}

export interface Authed {
  userId: string;
  familyId: string;
}

function providerReady(ctx: Ctx, p: Provider): void {
  if (audiencesFor(p, ctx.cfg).length === 0) throw new HttpError(503, 'provider_not_configured');
}

/** Authorization: Bearer <access token> → 本人。userIdはここでしか決まらない */
export async function authenticate(ctx: Ctx, request: Request): Promise<Authed> {
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get('authorization') ?? '');
  if (!m) throw new HttpError(401, 'unauthorized', {}, { 'www-authenticate': 'Bearer' });
  const hash = await sha256Hex(m[1]);
  const now = ctx.deps.now();
  const row = await ctx.db
    .prepare(
      'SELECT a.user_id AS userId, a.family_id AS familyId FROM access_tokens a JOIN session_families f ON f.id = a.family_id WHERE a.token_hash = ? AND a.expires_at > ? AND f.revoked_at IS NULL AND f.expires_at > ?',
    )
    .bind(hash, now, now)
    .first<Authed>();
  if (!row) throw new HttpError(401, 'unauthorized', {}, { 'www-authenticate': 'Bearer' });
  return row;
}

// ---- challenge -------------------------------------------------------------------------------

export async function createChallenge(ctx: Ctx, body: Record<string, unknown>, authed: Authed | null) {
  const provider = oneOf(body.provider, PROVIDER_LIST);
  const purpose = body.purpose === undefined ? 'login' : oneOf(body.purpose, ['login', 'reauth'] as const);
  providerReady(ctx, provider);
  if (purpose === 'reauth' && !authed) throw new HttpError(401, 'unauthorized', {}, { 'www-authenticate': 'Bearer' });
  const now = ctx.deps.now();
  const id = randomId('ch');
  const nonce = randomToken('n');
  await ctx.db
    .prepare('INSERT INTO auth_challenges (id, provider, purpose, user_id, nonce_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, provider, purpose, purpose === 'reauth' ? authed!.userId : null, await sha256Hex(nonce), now, now + CHALLENGE_TTL_MS)
    .run();
  // 失敗しても発行自体は成功させる軽い保守
  await housekeeping(ctx.db, now).catch(() => undefined);
  return { challengeId: id, nonce, expiresAt: now + CHALLENGE_TTL_MS };
}

interface ChallengeRow {
  id: string;
  provider: Provider;
  purpose: 'login' | 'reauth';
  user_id: string | null;
  nonce_hash: string;
  expires_at: number;
  consumed_at: number | null;
}

async function loadChallenge(ctx: Ctx, id: string, provider: Provider, purpose: 'login' | 'reauth'): Promise<ChallengeRow> {
  const row = await ctx.db.prepare('SELECT * FROM auth_challenges WHERE id = ?').bind(id).first<ChallengeRow>();
  const now = ctx.deps.now();
  if (!row || row.provider !== provider || row.purpose !== purpose || row.consumed_at !== null || row.expires_at <= now) throw new HttpError(400, 'invalid_challenge');
  return row;
}

/**
 * tokenのnonce claimがchallengeに結び付くことを確認する。
 * claimは生nonce、またはそのSHA-256 hex(iOSのAppleフローでhash済みを渡す実装)のどちらも許す。
 */
async function nonceMatches(ch: ChallengeRow, claim: string | undefined): Promise<boolean> {
  if (!claim) return false;
  const asRaw = timingSafeEqual(await sha256Hex(claim), ch.nonce_hash);
  const asHashed = timingSafeEqual(claim, ch.nonce_hash);
  return asRaw || asHashed;
}

/** 1回消費。UPDATEのWHERE条件で原子的に守り、meta.changes===1のときだけ勝者（並行exchangeの二重成功を防ぐ） */
async function consumeChallenge(ctx: Ctx, id: string): Promise<void> {
  const now = ctx.deps.now();
  const r = await ctx.db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').bind(now, id, now).run();
  if (r.meta.changes !== 1) throw new HttpError(400, 'invalid_challenge');
}

// ---- user / session --------------------------------------------------------------------------

/** (provider, sub) → 本人ID。D1のbatchは1トランザクションなので、条件付きINSERTで並行初回ログインでも1人だけ作る */
async function findOrCreateUser(ctx: Ctx, provider: Provider, sub: string): Promise<string> {
  const now = ctx.deps.now();
  const candidate = randomId('u');
  await ctx.db.batch([
    ctx.db.prepare('INSERT INTO users (id, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND sub = ?)').bind(candidate, now, provider, sub),
    ctx.db.prepare('INSERT INTO identities (provider, sub, user_id, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND sub = ?)').bind(provider, sub, candidate, now, provider, sub),
  ]);
  const row = await ctx.db.prepare('SELECT user_id AS userId FROM identities WHERE provider = ? AND sub = ?').bind(provider, sub).first<{ userId: string }>();
  if (!row) throw new HttpError(500, 'internal_error');
  return row.userId;
}

export interface SessionTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

async function issueTokens(ctx: Ctx, userId: string, familyId: string, familyExpiresAt: number, replaceAccess: boolean, create: boolean): Promise<SessionTokens> {
  const now = ctx.deps.now();
  const accessToken = randomToken('cga');
  const refreshToken = randomToken('cgr');
  const accessExpiresAt = Math.min(now + ctx.cfg.accessTtlMs, familyExpiresAt);
  const refreshExpiresAt = Math.min(now + ctx.cfg.refreshTtlMs, familyExpiresAt);
  const stmts: D1PreparedStatement[] = [];
  // 本人(user)と生きているfamilyが存在するときだけ挿入する。並行した削除/失効で消えた利用者のtokenを作らない
  if (create) {
    stmts.push(
      ctx.db.prepare('INSERT INTO session_families (id, user_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)').bind(familyId, userId, now, familyExpiresAt, userId),
    );
  }
  if (replaceAccess) stmts.push(ctx.db.prepare('DELETE FROM access_tokens WHERE family_id = ? AND EXISTS (SELECT 1 FROM session_families WHERE id = ? AND revoked_at IS NULL)').bind(familyId, familyId));
  const live = 'EXISTS (SELECT 1 FROM session_families WHERE id = ? AND user_id = ? AND revoked_at IS NULL)';
  stmts.push(
    ctx.db.prepare(`INSERT INTO access_tokens (token_hash, family_id, user_id, expires_at) SELECT ?, ?, ?, ? WHERE ${live}`).bind(await sha256Hex(accessToken), familyId, userId, accessExpiresAt, familyId, userId),
    ctx.db.prepare(`INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at) SELECT ?, ?, ?, ? WHERE ${live}`).bind(await sha256Hex(refreshToken), familyId, userId, refreshExpiresAt, familyId, userId),
  );
  const results = await ctx.db.batch(stmts);
  // batchは0行挿入でも失敗にならないので、最後の2文が1行ずつ入ったかを明示確認する
  if (results[results.length - 1]!.meta.changes !== 1 || results[results.length - 2]!.meta.changes !== 1) throw new HttpError(401, 'invalid_refresh_token');
  return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt };
}

// ---- exchange --------------------------------------------------------------------------------

export async function exchange(ctx: Ctx, body: Record<string, unknown>) {
  const provider = oneOf(body.provider, PROVIDER_LIST);
  const challengeId = str(body, 'challengeId', 100)!;
  const idToken = str(body, 'idToken', 8192, { min: 20 })!;
  const code = str(body, 'authorizationCode', 2048, { optional: true });
  providerReady(ctx, provider);
  if (provider === 'apple' && !ctx.cfg.apple) throw new HttpError(503, 'provider_not_configured');
  if (provider === 'apple' && !code) throw new HttpError(400, 'invalid_request');

  const ch = await loadChallenge(ctx, challengeId, provider, 'login');
  const id = await verifyIdToken(provider, idToken, ctx.cfg, ctx.jwks, ctx.deps);
  if (!(await nonceMatches(ch, id.nonce))) throw new HttpError(401, 'invalid_token');
  // 署名・nonceが通ってから消費。並行して来た同じchallengeは changes===0 で失敗
  await consumeChallenge(ctx, ch.id);

  let appleRefresh: string | null = null;
  if (provider === 'apple') {
    const t = await exchangeAuthorizationCode(ctx.cfg.apple!, ctx.deps, code!);
    // Appleが返したid_tokenのsubが、クライアント提示のtokenのsubと一致すること（別人のcodeを混ぜられない）
    const back = await verifyIdToken('apple', t.idToken, ctx.cfg, ctx.jwks, ctx.deps, { requireNonce: false });
    if (back.sub !== id.sub) throw new HttpError(401, 'invalid_token');
    appleRefresh = t.refreshToken;
  }

  const userId = await findOrCreateUser(ctx, provider, id.sub);
  if (appleRefresh) {
    const { ct, iv } = await encryptSecret(ctx.cfg.apple!.tokenKey, appleRefresh, userId);
    const now = ctx.deps.now();
    const w = await ctx.db
      .prepare(
        'INSERT INTO apple_credentials (user_id, enc_refresh_token, iv, created_at, last_checked_at, version) SELECT ?, ?, ?, ?, ?, 1 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?) ON CONFLICT (user_id) DO UPDATE SET enc_refresh_token = excluded.enc_refresh_token, iv = excluded.iv, created_at = excluded.created_at, last_checked_at = excluded.last_checked_at, version = apple_credentials.version + 1',
      )
      .bind(userId, ct, iv, now, now, userId)
      .run();
    if (w.meta.changes !== 1) throw new HttpError(401, 'invalid_token');
  }
  const familyId = randomId('f');
  const tokens = await issueTokens(ctx, userId, familyId, ctx.deps.now() + MAX_FAMILY_MS, false, true);
  return { provider, user: { id: userId }, session: tokens };
}

// ---- refresh / logout ------------------------------------------------------------------------

export async function refresh(ctx: Ctx, body: Record<string, unknown>) {
  const token = str(body, 'refreshToken', 200, { min: 20 })!;
  const hash = await sha256Hex(token);
  const now = ctx.deps.now();
  // Apple利用者は日次でAppleのrefresh tokenを照合する。失敗(一時障害)で503にしてもrefresh tokenは消費しない
  const pending = await ctx.db
    .prepare(
      'SELECT user_id AS userId FROM refresh_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND family_id IN (SELECT id FROM session_families WHERE revoked_at IS NULL AND expires_at > ?)',
    )
    .bind(hash, now, now)
    .first<{ userId: string }>();
  if (pending) await appleDailyCheck(ctx, pending.userId);
  // 「未使用 かつ 有効 かつ familyが生きている」ときだけ使用済みにする。勝者は changes===1 の1人だけ
  const claim = await ctx.db
    .prepare(
      'UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND family_id IN (SELECT id FROM session_families WHERE revoked_at IS NULL AND expires_at > ?)',
    )
    .bind(now, hash, now, now)
    .run();
  if (claim.meta.changes !== 1) {
    // 使用済みtokenの再提示 = 盗用/二重使用の疑い。familyごと失効する
    const row = await ctx.db.prepare('SELECT family_id AS familyId, used_at AS usedAt FROM refresh_tokens WHERE token_hash = ?').bind(hash).first<{ familyId: string; usedAt: number | null }>();
    if (row && row.usedAt !== null) await revokeFamily(ctx, row.familyId, 'refresh_reuse');
    throw new HttpError(401, 'invalid_refresh_token');
  }
  const info = await ctx.db
    .prepare('SELECT r.user_id AS userId, r.family_id AS familyId, f.expires_at AS familyExpiresAt FROM refresh_tokens r JOIN session_families f ON f.id = r.family_id WHERE r.token_hash = ?')
    .bind(hash)
    .first<{ userId: string; familyId: string; familyExpiresAt: number }>();
  if (!info) throw new HttpError(401, 'invalid_refresh_token');
  const tokens = await issueTokens(ctx, info.userId, info.familyId, info.familyExpiresAt, true, false);
  return { session: tokens };
}

const APPLE_CHECK_INTERVAL_MS = 24 * 3600 * 1000;

/** その利用者の全sessionを即失効(accessも削除)。Appleでの連携解除など、providerが認証を取り消した場合に使う */
async function revokeAllSessionsOfUser(ctx: Ctx, userId: string, reason: string): Promise<void> {
  await ctx.db.batch([
    ctx.db.prepare('UPDATE session_families SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL').bind(ctx.deps.now(), reason, userId),
    ctx.db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId),
  ]);
}

/**
 * TN3194: Apple利用者のrefresh tokenを少なくとも1日1回照合する。Google利用者は何もしない。
 * - 照合が新しい(24h未満)ならAppleへ問い合わせない
 * - invalid_grant(連携解除済み) / 保存欠損 / 復号不可 → 全session失効→401（再ログインでcredentialが作り直される）
 * - 一時障害/自社設定不備 → 失効扱いにせず503（refresh tokenは消費されない）
 * - 新しいrefresh tokenが返れば暗号化して、versionのCASで更新（行が無ければ更新されず、削除済み利用者を作り直さない）
 */
async function appleDailyCheck(ctx: Ctx, userId: string): Promise<void> {
  const now = ctx.deps.now();
  const r = await ctx.db
    .prepare(
      `SELECT i.provider AS provider, c.enc_refresh_token AS ct, c.iv AS iv, c.last_checked_at AS lc, c.version AS v
       FROM identities i LEFT JOIN apple_credentials c ON c.user_id = i.user_id WHERE i.user_id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<{ provider: Provider; ct: string | null; iv: string | null; lc: number | null; v: number | null }>();
  if (!r || r.provider !== 'apple') return;
  if (r.ct && r.lc !== null && now - r.lc >= 0 && now - r.lc < APPLE_CHECK_INTERVAL_MS) return;
  const apple = ctx.cfg.apple;
  if (!apple) throw new HttpError(503, 'provider_not_configured');
  let token: string | null = null;
  if (r.ct && r.iv) {
    try {
      token = await decryptSecret(apple.tokenKey, r.ct, r.iv, userId);
    } catch {
      token = null;
    }
  }
  if (!token) {
    await revokeAllSessionsOfUser(ctx, userId, 'apple_credential_unusable');
    throw new HttpError(401, 'invalid_refresh_token');
  }
  const res = await checkRefreshToken(apple, ctx.deps, token);
  if (res.status === 'revoked') {
    await revokeAllSessionsOfUser(ctx, userId, 'apple_revoked');
    throw new HttpError(401, 'invalid_refresh_token');
  }
  if (res.newRefreshToken) {
    const { ct, iv } = await encryptSecret(apple.tokenKey, res.newRefreshToken, userId);
    await ctx.db
      .prepare('UPDATE apple_credentials SET enc_refresh_token = ?, iv = ?, last_checked_at = ?, version = version + 1 WHERE user_id = ? AND version = ?')
      .bind(ct, iv, now, userId, r.v)
      .run();
  } else {
    await ctx.db.prepare('UPDATE apple_credentials SET last_checked_at = MAX(last_checked_at, ?) WHERE user_id = ?').bind(now, userId).run();
  }
}

async function revokeFamily(ctx: Ctx, familyId: string, reason: string): Promise<void> {
  await ctx.db.batch([
    ctx.db.prepare('UPDATE session_families SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL').bind(ctx.deps.now(), reason, familyId),
    ctx.db.prepare('DELETE FROM access_tokens WHERE family_id = ?').bind(familyId),
  ]);
}

export async function logout(ctx: Ctx, a: Authed) {
  await revokeFamily(ctx, a.familyId, 'logout');
  return { ok: true };
}

// ---- account deletion ------------------------------------------------------------------------

export async function deleteAccount(ctx: Ctx, a: Authed, body: Record<string, unknown>) {
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'invalid_request');
  const provider = oneOf(body.provider, PROVIDER_LIST);
  const challengeId = str(body, 'challengeId', 100)!;
  const idToken = str(body, 'idToken', 8192, { min: 20 })!;
  providerReady(ctx, provider);

  // 再認証: 本人宛て(reauth)のchallenge + 同じ(provider, sub)の署名付きtoken
  const ch = await loadChallenge(ctx, challengeId, provider, 'reauth');
  if (ch.user_id !== a.userId) throw new HttpError(400, 'invalid_challenge');
  const id = await verifyIdToken(provider, idToken, ctx.cfg, ctx.jwks, ctx.deps);
  if (!(await nonceMatches(ch, id.nonce))) throw new HttpError(401, 'invalid_token');
  const owner = await ctx.db.prepare('SELECT user_id AS userId FROM identities WHERE provider = ? AND sub = ?').bind(provider, id.sub).first<{ userId: string }>();
  if (!owner || owner.userId !== a.userId) throw new HttpError(401, 'invalid_token');
  await consumeChallenge(ctx, ch.id);

  // Apple失効の方針（TN3194: 退会要求はtokenを持っていなくても満たす。ただし失効の成否は偽らない）
  //  - 失効成功 / 既に無効            → 削除して 'revoked' / 'already_invalid'
  //  - Apple側の一時障害(5xx/429/通信) → 502で何も消さず再試行。利用者が明示(forceWithoutAppleRevocation)したら削除し 'skipped_manual_required'
  //  - token欠損/復号不可/Appleの恒久4xx → 再試行しても直らないので削除し 'manual_required'（端末の設定→Apple ID→サインインとセキュリティ→Appleでサインイン から手動解除を案内）
  type Rev = 'revoked' | 'already_invalid' | 'not_applicable' | 'manual_required' | 'skipped_manual_required';
  let appleRevocation: Rev = 'not_applicable';
  const cred = await ctx.db.prepare('SELECT enc_refresh_token AS ct, iv FROM apple_credentials WHERE user_id = ?').bind(a.userId).first<{ ct: string; iv: string }>();
  if (provider === 'apple') {
    let refreshToken: string | null = null;
    if (cred && ctx.cfg.apple) {
      try {
        refreshToken = await decryptSecret(ctx.cfg.apple.tokenKey, cred.ct, cred.iv, a.userId);
      } catch {
        refreshToken = null;
      }
    }
    if (!refreshToken || !ctx.cfg.apple) appleRevocation = 'manual_required';
    else {
      const out = await revokeRefreshTokenClassified(ctx.cfg.apple, ctx.deps, refreshToken);
      if (out === 'revoked' || out === 'already_invalid') appleRevocation = out;
      else if (out === 'failed_permanent') appleRevocation = 'manual_required';
      else if (body.forceWithoutAppleRevocation === true) appleRevocation = 'skipped_manual_required';
      else throw new HttpError(502, 'apple_revoke_failed', { retryable: true });
    }
  }

  // 無条件DELETEなので0行でも問題ない。FKのCASCADEに依存せず子から明示的に消す
  const u = a.userId;
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM backups WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM apple_credentials WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM session_families WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM auth_challenges WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM identities WHERE user_id = ?').bind(u),
    ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(u),
  ]);
  return { deleted: true, appleRevocation };
}
