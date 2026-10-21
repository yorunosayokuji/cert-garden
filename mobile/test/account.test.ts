// アカウント（ログイン・セッション・クラウド保存/復元・退会）の試験。
// 注意: ここで使うサーバーは server/ の仕様を写した「偽のサーバー」、ID token は署名のない偽の文字列。
// 実際の Google/Apple/Cloudflare/Keychain/実機の成功を示すものではない（server/ 側はローカルの workerd で別に試験済み）。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { StudyCore, BitPatternsContent } from '../../src/mobile.ts';
import { ApiClient, ApiError, type FetchLike, type Provider } from '../src/account/api.ts';
import { BACKUP_KEYS, GenerationKv, collectBundle, fromTransport, toTransport, validateBundle, BackupError, GEN_POINTER_KEY } from '../src/account/backup.ts';
import { GOOGLE_IOS_CLIENT_ID, classifyRuntime, googleRedirectUri, normalizeApiBase, resolveAccountConfig, reversedClientId } from '../src/account/config.ts';
import { createAccountService } from '../src/account/factory.ts';
import { idTokenNonce } from '../src/account/jwt.ts';
import { FAIL_TEXT, deleteDoneText } from '../src/account/messages.ts';
import { SKELETON_KINDS, parsePin, withPin } from '../src/ios/compare.ts';
import type { AccountService, CredentialState, FailKind, IdpOutcome, IdpPort } from '../src/account/service.ts';
import type { RuntimeKind } from '../src/account/config.ts';
import { INSTALL_MARKER_KEY, MemorySecureKv, SESSION_KEY, SessionStore } from '../src/account/session.ts';
import { MemoryKv, type KeyValue } from '../src/state/kv.ts';
import { KvStorage } from '../src/state/kvStorage.ts';
import { NOTEBOOK_KEY, NotebookStore } from '../src/state/notebook.ts';
import { CORE_KEY } from '../src/state/kvStorage.ts';
import { missingForBuild, problems } from '../scripts/iosConfigCheck.mjs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const T0 = Date.parse('2026-10-20T09:00:00+09:00');

// ---- 偽のサーバー（server/ の契約を写したもの） ----
interface Failure {
  match: (method: string, path: string) => boolean;
  mode: 'network' | 'status' | 'hang';
  status?: number;
  code?: string;
  /** network のとき、サーバーは処理済みで応答だけ失う */
  afterApply?: boolean;
  once?: boolean;
}

class FakeServer {
  clock = T0;
  identities = new Map<string, string>();
  challenges = new Map<string, { provider: string; purpose: string; userId: string | null; nonce: string; used: boolean }>();
  access = new Map<string, { userId: string; family: string; exp: number }>();
  refreshTokens = new Map<string, { userId: string; family: string; used: boolean; exp: number }>();
  revoked = new Set<string>();
  backups = new Map<string, { revision: number; payload: string; lastReq: string }>();
  users = new Set<string>();
  calls: string[] = [];
  failures: Failure[] = [];
  n = 0;
  accessTtl = 15 * 60_000;
  refreshUnavailable = false;
  appleRevoke: 'ok' | 'manual' | 'transient' = 'ok';
  deleteBodies: Record<string, unknown>[] = [];
  private id(p: string) {
    this.n += 1;
    return `${p}${String(this.n).padStart(8, '0')}${'x'.repeat(24)}`;
  }
  count(match: string) {
    return this.calls.filter((c) => c === match).length;
  }
  private json(status: number, body: unknown) {
    return { status, text: async () => JSON.stringify(body) };
  }
  private err(status: number, code: string, extra: Record<string, unknown> = {}) {
    return this.json(status, { error: { code, message: 'x', ...extra } });
  }
  private session(userId: string) {
    const family = this.id('f');
    return this.issue(userId, family);
  }
  private issue(userId: string, family: string) {
    const a = this.id('cga');
    const r = this.id('cgr');
    this.access.set(a, { userId, family, exp: this.clock + this.accessTtl });
    this.refreshTokens.set(r, { userId, family, used: false, exp: this.clock + 30 * 86400_000 });
    return { accessToken: a, accessExpiresAt: this.clock + this.accessTtl, refreshToken: r, refreshExpiresAt: this.clock + 30 * 86400_000 };
  }
  private auth(headers: Record<string, string>): { userId: string; family: string } | null {
    const m = /^Bearer (.+)$/.exec(headers.authorization ?? '');
    const a = m ? this.access.get(m[1]!) : undefined;
    if (!a || a.exp <= this.clock || this.revoked.has(a.family)) return null;
    return a;
  }
  fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const key = `${init.method} ${path}`;
    this.calls.push(key);
    const f = this.failures.find((x) => x.match(init.method, path));
    let lostAfterApply = false;
    if (f) {
      if (f.once !== false) this.failures.splice(this.failures.indexOf(f), 1);
      if (f.mode === 'network' && !f.afterApply) throw new Error('network down');
      if (f.mode === 'hang') return new Promise(() => undefined);
      if (f.mode === 'status') return this.err(f.status ?? 500, f.code ?? 'internal_error');
      lostAfterApply = true;
    }
    const res = this.handle(init.method, path, init.headers, init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    if (lostAfterApply) throw new Error('response lost');
    return res;
  };
  private handle(method: string, path: string, headers: Record<string, string>, body: Record<string, unknown>) {
    if (path === '/v1/auth/challenge') {
      const authed = body.purpose === 'reauth' ? this.auth(headers) : null;
      if (body.purpose === 'reauth' && !authed) return this.err(401, 'unauthorized');
      const id = this.id('ch');
      const nonce = this.id('n');
      this.challenges.set(id, { provider: String(body.provider), purpose: String(body.purpose), userId: authed?.userId ?? null, nonce, used: false });
      return this.json(200, { challengeId: id, nonce, expiresAt: this.clock + 300_000 });
    }
    if (path === '/v1/auth/exchange') {
      const ch = this.challenges.get(String(body.challengeId));
      const m = /^fake\.(google|apple)\.([^.]+)\.(.+)$/.exec(String(body.idToken));
      if (!ch || ch.used || !m || m[1] !== body.provider || m[3] !== ch.nonce) return this.err(401, 'invalid_token');
      ch.used = true;
      const k = `${m[1]}:${m[2]}`;
      let uid = this.identities.get(k);
      if (!uid) {
        uid = this.id('u');
        this.identities.set(k, uid);
        this.users.add(uid);
      }
      return this.json(200, { provider: m[1], user: { id: uid }, session: this.session(uid) });
    }
    if (path === '/v1/auth/refresh') {
      // Apple の一時障害: サーバーは更新 token を消費しないと保証する 503
      if (this.refreshUnavailable) return this.err(503, 'provider_unavailable');
      const t = this.refreshTokens.get(String(body.refreshToken));
      if (!t || t.exp <= this.clock || this.revoked.has(t.family)) return this.err(401, 'invalid_refresh_token');
      if (t.used) {
        this.revoked.add(t.family);
        return this.err(401, 'invalid_refresh_token');
      }
      t.used = true;
      for (const [k, v] of this.access) if (v.family === t.family) this.access.delete(k);
      return this.json(200, { session: this.issue(t.userId, t.family) });
    }
    if (path === '/v1/auth/logout') {
      const a = this.auth(headers);
      if (!a) return this.err(401, 'unauthorized');
      this.revoked.add(a.family);
      return this.json(200, { ok: true });
    }
    if (path === '/v1/backup') {
      const a = this.auth(headers);
      if (!a) return this.err(401, 'unauthorized');
      const cur = this.backups.get(a.userId);
      if (method === 'GET') return this.json(200, cur ? { revision: cur.revision, updatedAt: this.clock, backup: JSON.parse(cur.payload) } : { revision: 0, updatedAt: null, backup: null });
      const b = body.backup as { format?: string; version?: number; entries?: Record<string, string> } | undefined;
      // server/src/backup.ts と同じ: 許可キーのみ、各値は JSON「オブジェクト」(配列は不可)
      if (!b || b.format !== 'certgarden-backup' || b.version !== 1 || !b.entries) return this.err(400, 'invalid_request');
      for (const [k, v] of Object.entries(b.entries)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch {
          return this.err(400, 'invalid_request');
        }
        if (!(BACKUP_KEYS as readonly string[]).includes(k) || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return this.err(400, 'invalid_request');
      }
      const base = body.baseRevision as number;
      const payload = JSON.stringify(b);
      if (base === 0 ? cur !== undefined : cur?.revision !== base) {
        if (cur && cur.revision === base + 1 && cur.lastReq === body.requestId && cur.payload === payload) return this.json(200, { revision: cur.revision, replayed: true });
        return this.err(409, 'revision_conflict', { serverRevision: cur?.revision ?? 0 });
      }
      const rev = base + 1;
      this.backups.set(a.userId, { revision: rev, payload, lastReq: String(body.requestId) });
      return this.json(200, { revision: rev, replayed: false });
    }
    if (path === '/v1/account') {
      const a = this.auth(headers);
      if (!a) return this.err(401, 'unauthorized');
      const ch = this.challenges.get(String(body.challengeId));
      const m = /^fake\.(google|apple)\.([^.]+)\.(.+)$/.exec(String(body.idToken));
      if (body.confirm !== 'DELETE' || !ch || ch.used || ch.purpose !== 'reauth' || ch.userId !== a.userId || !m || m[3] !== ch.nonce || this.identities.get(`${m[1]}:${m[2]}`) !== a.userId) return this.err(401, 'invalid_token');
      ch.used = true;
      this.deleteBodies.push(body);
      let rev = m[1] === 'apple' ? 'revoked' : 'not_applicable';
      if (m[1] === 'apple' && this.appleRevoke === 'manual') rev = 'manual_required';
      if (m[1] === 'apple' && this.appleRevoke === 'transient') {
        if (body.forceWithoutAppleRevocation === true) rev = 'skipped_manual_required';
        else return this.err(502, 'apple_revoke_failed', { retryable: true }); // 何も消さない
      }
      this.users.delete(a.userId);
      this.backups.delete(a.userId);
      for (const [k, v] of this.identities) if (v === a.userId) this.identities.delete(k);
      for (const [k, v] of this.access) if (v.userId === a.userId) this.access.delete(k);
      return this.json(200, { deleted: true, appleRevocation: rev });
    }
    return this.err(404, 'not_found');
  }
}

// ---- 偽の IdP（署名のない偽 token。サーバーから受けた nonce を載せる） ----
class FakeIdp implements IdpPort {
  who = 'sub-A';
  provider: Provider;
  next: IdpOutcome | 'ok' | 'throw' | 'hang' = 'ok';
  nonces: string[] = [];
  constructor(provider: Provider) {
    this.provider = provider;
  }
  async isAvailable() {
    return true;
  }
  async signIn(nonce: string): Promise<IdpOutcome> {
    this.nonces.push(nonce);
    if (this.next === 'hang') return new Promise(() => undefined);
    if (this.next === 'throw') throw new Error('boom');
    if (this.next !== 'ok') return this.next;
    return { kind: 'success', idToken: `fake.${this.provider}.${this.who}.${nonce}`, ...(this.provider === 'apple' ? { authorizationCode: 'code-1', appleUser: `apple-user-${this.who}` } : null) };
  }
  // Apple の資格情報の状態（OS の照会）と失効通知
  state: CredentialState | 'throw' | 'slow' = 'authorized';
  stateCalls = 0;
  gate: (() => void) | null = null;
  async credentialState(_user: string): Promise<CredentialState> {
    this.stateCalls += 1;
    if (this.state === 'throw') throw new Error('os unavailable');
    if (this.state === 'slow') await new Promise<void>((res) => (this.gate = res));
    return this.state === 'slow' ? 'revoked' : this.state;
  }
  revokeListeners = new Set<() => void>();
  onRevoked(cb: () => void) {
    this.revokeListeners.add(cb);
    return () => this.revokeListeners.delete(cb);
  }
  fireRevoked() {
    for (const l of [...this.revokeListeners]) l();
  }
}

class FakeLifecycle {
  cbs = new Set<() => void>();
  onActive(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  foreground() {
    for (const c of [...this.cbs]) c();
  }
}

let idSeq = 0; // rig をまたいで一意（再起動の試験で session id が衝突しない）

class FlakyKv implements KeyValue {
  sets = 0;
  failAtSet = -1;
  readonly inner: KeyValue;
  constructor(inner: KeyValue) {
    this.inner = inner;
  }
  getItem(k: string) {
    return this.inner.getItem(k);
  }
  async setItem(k: string, v: string) {
    this.sets += 1;
    if (this.sets === this.failAtSet) throw new Error('disk full');
    return this.inner.setItem(k, v);
  }
  removeItem(k: string) {
    return this.inner.removeItem(k);
  }
}

const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const READY_ENV = { apiBaseUrl: 'https://api.example.test', googleIosClientId: CLIENT_ID, isDev: false };

interface Rig {
  server: FakeServer;
  account: AccountService;
  base: MemoryKv; // 端末のデータの土台
  data: GenerationKv;
  meta: KeyValue;
  secure: MemorySecureKv;
  marker: MemoryKv;
  google: FakeIdp;
  apple: FakeIdp;
  life: FakeLifecycle;
}

function rig(opts: { server?: FakeServer; base?: MemoryKv; secure?: MemorySecureKv; marker?: MemoryKv; env?: { apiBaseUrl: string | undefined; googleIosClientId: string | undefined; isDev: boolean }; runtime?: RuntimeKind; bundleId?: string; idpTimeoutMs?: number } = {}): Rig {
  const server = opts.server ?? new FakeServer();
  const base = opts.base ?? new MemoryKv();
  const data = new GenerationKv(base);
  const secure = opts.secure ?? new MemorySecureKv();
  const marker = opts.marker ?? new MemoryKv();
  const google = new FakeIdp('google');
  const apple = new FakeIdp('apple');
  const life = new FakeLifecycle();
  const account = createAccountService({
    runtime: opts.runtime ?? 'native',
    env: opts.env ?? READY_ENV,
    bundleId: opts.bundleId ?? 'com.example.certgarden',
    fetch: server.fetch,
    secure,
    installMarker: marker,
    data,
    meta: data,
    idp: { google, apple },
    lifecycle: life,
    now: () => server.clock,
    newId: () => `id-${++idSeq}-${'z'.repeat(12)}`,
    ...(opts.idpTimeoutMs ? { idpTimeoutMs: opts.idpTimeoutMs } : null),
  });
  return { server, account, base, data, meta: data, secure, marker, google, apple, life };
}

async function signedIn(r: Rig, provider: Provider = 'google') {
  await r.account.init();
  const res = await r.account.signIn(provider);
  assert.equal(res.ok, true);
}

/** 実際の保存部品で、学習が途中の端末データを作る */
async function seedLocal(kv: KeyValue, memo = '比較メモ') {
  const core = await StudyCore.open({ storage: new KvStorage(kv), content: new BitPatternsContent(), clock: { now: () => T0 } });
  const v = await core.startStage('it-passport', 'bit-patterns');
  await core.interrupt(v.stageId);
  await new NotebookStore(kv).save([{ id: 'n1', name: 'ITパスポート', date: '', memo }]);
  return v.stageId;
}

// ================= 設定 =================

test('設定: API は HTTPS 固定。開発の明示 localhost だけ http。資格情報・クエリ・相対・署名ビルドの localhost は不可', () => {
  assert.equal(normalizeApiBase('https://api.example.test/', false), 'https://api.example.test');
  assert.equal(normalizeApiBase('https://api.example.test/v1/', false), 'https://api.example.test/v1');
  assert.equal(normalizeApiBase('http://api.example.test', false), null);
  assert.equal(normalizeApiBase('http://api.example.test', true), null);
  assert.equal(normalizeApiBase('http://localhost:8799', true), 'http://localhost:8799');
  assert.equal(normalizeApiBase('http://127.0.0.1:8799', true), 'http://127.0.0.1:8799');
  assert.equal(normalizeApiBase('http://localhost:8799', false), null);
  assert.equal(normalizeApiBase('https://localhost:8799', false), null);
  for (const bad of ['https://u:p@api.example.test', 'https://api.example.test?x=1', 'https://api.example.test#h', '/relative', 'ftp://a.b', '', undefined]) assert.equal(normalizeApiBase(bad as string | undefined, true), null, String(bad));
});

test('設定: 未設定は理由つきの unconfigured。成功を偽らない。Google の redirect は逆順クライアントIDのスキーム', () => {
  const none = resolveAccountConfig({ apiBaseUrl: undefined, googleIosClientId: undefined, isDev: false });
  assert.equal(none.status, 'unconfigured');
  assert.equal(none.status === 'unconfigured' && none.reasons.length, 2);
  assert.equal(resolveAccountConfig({ ...READY_ENV, googleIosClientId: 'nope' }).status, 'unconfigured');
  assert.equal(resolveAccountConfig({ ...READY_ENV, apiBaseUrl: 'http://x.test' }).status, 'unconfigured');
  assert.equal(resolveAccountConfig(READY_ENV).status, 'ready');
  assert.ok(GOOGLE_IOS_CLIENT_ID.test(CLIENT_ID));
  assert.equal(reversedClientId(CLIENT_ID), 'com.googleusercontent.apps.123456789012-abcdefghijklmnop');
  assert.equal(googleRedirectUri(CLIENT_ID), 'com.googleusercontent.apps.123456789012-abcdefghijklmnop:/oauthredirect');
});

test('状態: Web は未対応、native でも設定が足りなければ未設定。どちらも通信せず、ログインは invalidState', async () => {
  const web = rig({ runtime: 'web' });
  await web.account.init();
  assert.deepEqual(web.account.getState(), { phase: 'unsupported', reason: 'web' });
  assert.deepEqual(await web.account.signIn('google'), { ok: false, kind: 'invalidState' });
  const un = rig({ env: { apiBaseUrl: undefined, googleIosClientId: undefined, isDev: false } });
  await un.account.init();
  assert.equal(un.account.getState().phase, 'unconfigured');
  assert.deepEqual(await un.account.signIn('apple'), { ok: false, kind: 'invalidState' });
  assert.equal(web.server.calls.length + un.server.calls.length, 0);
  const android = rig({ runtime: classifyRuntime({ platform: 'android', executionEnvironment: 'standalone', appOwnership: null }) });
  assert.deepEqual(android.account.getState(), { phase: 'unsupported', reason: 'platform' });
  // Expo Go は未対応表示で、通信も session の読み書きもしない
  const go = rig({ runtime: classifyRuntime({ platform: 'ios', executionEnvironment: 'storeClient', appOwnership: 'expo' }) });
  await go.account.init();
  assert.deepEqual(go.account.getState(), { phase: 'unsupported', reason: 'expoGo' });
  assert.deepEqual(await go.account.signIn('apple'), { ok: false, kind: 'invalidState' });
  assert.equal(go.server.calls.length, 0);
  assert.equal(go.secure.map.size, 0);
});

test('実行環境: iOS の開発ビルド(storeClient で Expo Go でない)・署名ビルド(standalone)・bare だけ native。Expo Go・判定不能・Web・Android は未対応', () => {
  const k = (platform: string, executionEnvironment: string | undefined, appOwnership: string | null) => classifyRuntime({ platform, executionEnvironment, appOwnership });
  assert.equal(k('ios', 'standalone', null), 'native');
  assert.equal(k('ios', 'bare', null), 'native');
  assert.equal(k('ios', 'storeClient', null), 'native'); // 開発ビルド
  assert.equal(k('ios', 'storeClient', 'expo'), 'expoGo');
  assert.equal(k('ios', undefined, null), 'platform');
  assert.equal(k('ios', 'weird', null), 'platform');
  assert.equal(k('web', 'standalone', null), 'web');
  assert.equal(k('android', 'standalone', null), 'platform');
  const native = read('../src/account/native.ts');
  assert.match(native, /classifyRuntime\(\{ platform: Platform\.OS, executionEnvironment: Constants\.executionEnvironment, appOwnership: Constants\.appOwnership \}\)/);
  assert.doesNotMatch(read('../src/account/native.web.ts'), /expo-constants/);
});

// ================= API クライアント =================

test('API: timeout・通信失敗・本文が壊れている/大きすぎる・http エラーを区別し、エラーに token や本文を含めない', async () => {
  const mk = (fetch: FetchLike, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) => new ApiClient({ baseUrl: 'https://api.example.test', fetch, ...extra });
  const secret = 'SECRET-TOKEN-VALUE';
  await assert.rejects(mk(() => new Promise(() => undefined), { timeoutMs: 20 }).health(), (e: unknown) => e instanceof ApiError && e.kind === 'timeout');
  await assert.rejects(mk(async () => { throw new Error(secret); }).health(), (e: unknown) => e instanceof ApiError && e.kind === 'network' && !e.message.includes(secret));
  await assert.rejects(mk(async () => ({ status: 200, text: async () => '<html>' })).health(), (e: unknown) => e instanceof ApiError && e.kind === 'badResponse');
  await assert.rejects(mk(async () => ({ status: 200, text: async () => 'x'.repeat(50) }), { maxResponseChars: 10 }).health(), (e: unknown) => e instanceof ApiError && e.kind === 'badResponse');
  await assert.rejects(
    mk(async () => ({ status: 409, text: async () => JSON.stringify({ error: { code: 'revision_conflict', message: secret, serverRevision: 7 } }) })).putBackup('a'.repeat(30), 1, 'r'.repeat(10), {}),
    (e: unknown) => e instanceof ApiError && e.kind === 'http' && e.status === 409 && e.code === 'revision_conflict' && e.serverRevision === 7 && !e.message.includes(secret),
  );
  await assert.rejects(mk(async () => ({ status: 500, text: async () => JSON.stringify({ error: { code: 'WEIRD CODE!' } }) })).health(), (e: unknown) => e instanceof ApiError && e.code === 'error');
});

test('API: 認証は Authorization だけ（cookie・Origin なし）、本文は JSON、DELETE にも本文を付ける。base URL は一度組み立てたものだけ', async () => {
  const seen: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const api = new ApiClient({ baseUrl: 'https://api.example.test/v1', fetch: async (url, init) => { seen.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : null) }); return { status: 200, text: async () => JSON.stringify({ deleted: true, appleRevocation: 'revoked' }) }; } });
  await api.deleteAccount('A'.repeat(30), 'apple', 'ch1', 'tok');
  assert.equal(seen[0]!.url, 'https://api.example.test/v1/v1/account');
  assert.equal(seen[0]!.method, 'DELETE');
  assert.equal(seen[0]!.headers.authorization, `Bearer ${'A'.repeat(30)}`);
  assert.equal(seen[0]!.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0]!.body!), { confirm: 'DELETE', provider: 'apple', challengeId: 'ch1', idToken: 'tok' });
  assert.equal(Object.keys(seen[0]!.headers).some((h) => /^(cookie|origin)$/i.test(h)), false);
});

// ================= セッションの保存 =================

test('セッション: 新しい install では Keychain に残っていた前の session を捨てる。同じ install なら読める。別 install・期限切れ・壊れた値は捨てる', async () => {
  const secure = new MemorySecureKv();
  const marker = new MemoryKv();
  const SC = 'https://api.example.test|' + CLIENT_ID + '|com.example.certgarden';
  const rec = (installId: string, refreshExpiresAt = T0 + 86400_000, sid = 'sid-x', scope = SC) => JSON.stringify({ userId: 'u1', provider: 'google', installId, sid, scope, tokens: { accessToken: 'a'.repeat(30), accessExpiresAt: T0 + 1000, refreshToken: 'r'.repeat(30), refreshExpiresAt } });
  // 再 install: Keychain にだけ前の session が残る
  secure.map.set(SESSION_KEY, rec('old-install'));
  const s1 = new SessionStore(secure, marker, () => 'install-1', SC);
  assert.deepEqual(await s1.load(T0), { kind: 'none', reason: 'newInstall' });
  assert.equal(secure.map.has(SESSION_KEY), false, '前の install の session は消える');
  assert.equal(await marker.getItem(INSTALL_MARKER_KEY), 'install-1');
  // 同じ install
  await s1.save({ userId: 'u1', provider: 'google', installId: s1.currentInstallId(), sid: 'sid-1', scope: SC, tokens: { accessToken: 'a'.repeat(30), accessExpiresAt: T0, refreshToken: 'r'.repeat(30), refreshExpiresAt: T0 + 1000 } });
  const s2 = new SessionStore(secure, marker, () => 'never', SC);
  assert.equal((await s2.load(T0)).kind, 'ok');
  // 期限切れ
  assert.deepEqual(await new SessionStore(secure, marker, () => 'never', SC).load(T0 + 5000), { kind: 'expired' });
  assert.equal(secure.map.has(SESSION_KEY), false);
  // 別 install の印
  secure.map.set(SESSION_KEY, rec('other'));
  assert.deepEqual(await new SessionStore(secure, marker, () => 'never', SC).load(T0), { kind: 'none', reason: 'otherInstall' });
  // 壊れた値
  secure.map.set(SESSION_KEY, '{broken');
  assert.deepEqual(await new SessionStore(secure, marker, () => 'never', SC).load(T0), { kind: 'none', reason: 'unreadable' });
  assert.equal(secure.map.has(SESSION_KEY), false);
  // 旧形式（sid/scope が無い）は使わない
  secure.map.set(SESSION_KEY, JSON.stringify({ userId: 'u1', provider: 'google', installId: 'install-1', tokens: { accessToken: 'a'.repeat(30), accessExpiresAt: 1, refreshToken: 'r'.repeat(30), refreshExpiresAt: T0 + 9999 } }));
  assert.equal((await new SessionStore(secure, marker, () => 'never', SC).load(T0)).kind, 'none');
});

test('セッション: 接続先(API origin・Google クライアントID・bundle ID)が変わったら旧 Bearer を新しい接続先へ送らず捨てる', async () => {
  const a = rig();
  await signedIn(a);
  assert.ok(a.secure.map.has(SESSION_KEY));
  for (const change of [
    { env: { ...READY_ENV, apiBaseUrl: 'https://api2.example.test' } },
    { env: { ...READY_ENV, googleIosClientId: '999999999999-zzzzzzzz.apps.googleusercontent.com' } },
    { bundleId: 'com.other.certgarden' },
  ]) {
    const callsBefore = a.server.calls.length;
    const b = rig({ server: a.server, base: a.base, secure: a.secure, marker: a.marker, ...change });
    await b.account.init();
    assert.deepEqual(b.account.getState(), { phase: 'signedOut', notice: null }, JSON.stringify(change));
    assert.equal(a.server.calls.length, callsBefore, '旧 Bearer をどこへも送っていない');
    // 次の変更の確認のために、元の接続先で入り直す
    const again = rig({ server: a.server, base: a.base, secure: a.secure, marker: a.marker });
    await again.account.init();
    assert.equal((await again.account.signIn('google')).ok, true);
  }
  // 同じ接続先なら復帰する
  const same = rig({ server: a.server, base: a.base, secure: a.secure, marker: a.marker });
  await same.account.init();
  assert.equal(same.account.getState().phase, 'signedIn');
});

test('ログアウト後に Keychain の削除が失敗し、サーバーも落ちていても、再起動で元の session は復活しない（閉じた印で fail closed）。両方失敗したら成功を偽らない', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r);
  r.secure.failRemoves = true;
  r.server.failures.push({ match: (_m, p) => p === '/v1/auth/logout', mode: 'network' });
  assert.deepEqual(await r.account.logout(), { ok: true }); // 閉じた印が書けたので、再起動後も使われない
  assert.equal(r.account.getState().phase, 'signedOut');
  assert.ok(r.secure.map.has(SESSION_KEY), 'Keychain の値は残っている（削除失敗）');
  const callsBefore = r.server.calls.length;
  const restarted = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  await restarted.account.init();
  assert.deepEqual(restarted.account.getState(), { phase: 'signedOut', notice: null });
  assert.equal(r.server.calls.length, callsBefore, '復活した session でサーバーを呼んでいない');
  // 削除が直れば次の起動で本当に消える。新しいログインは別の session id なので使える
  r.secure.failRemoves = false;
  const again = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  await again.account.init();
  assert.equal(r.secure.map.has(SESSION_KEY), false);
  assert.equal((await again.account.signIn('google')).ok, true);
  // 閉じた印も書けず削除も失敗: 閉じたと言わない
  const bad = rig();
  await signedIn(bad);
  bad.secure.failRemoves = true;
  const markerSet = bad.marker.setItem.bind(bad.marker);
  bad.marker.setItem = async (k: string, v: string) => {
    if (k.includes('revoked-sid')) throw new Error('disk full');
    return markerSet(k, v);
  };
  assert.deepEqual(await bad.account.logout(), { ok: false, kind: 'storage' });
  assert.equal(bad.account.getState().phase, 'signedOut', 'メモリ上は閉じる');
});

test('閉じた印が読めない/壊れている時は fail closed: Keychain の削除失敗＋印の読込失敗＋再起動でも元の session を使わず、token の API は0回。印が無い正常な初回と、記憶域の回復後は使える', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r);
  r.secure.failRemoves = true;
  assert.deepEqual(await r.account.logout(), { ok: true }); // 閉じた印は書けた。Keychain の値は残る
  assert.ok(r.secure.map.has(SESSION_KEY));
  const calls = r.server.calls.length;
  // 再起動: 閉じた印の読み取りだけ失敗する
  const realGet = r.marker.getItem.bind(r.marker);
  let failing = true;
  r.marker.getItem = async (k: string) => {
    if (failing && k.includes('revoked-sid')) throw new Error('io error');
    return realGet(k);
  };
  const a = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  await a.account.init();
  assert.deepEqual(a.account.getState(), { phase: 'signedOut', notice: null });
  assert.equal(r.server.calls.length, calls, '元の session で token の API を呼んでいない');
  // 壊れた印（空文字）も「未失効」とは判断しない
  failing = false;
  r.marker.map.set('certgarden-account:revoked-sid:v1', '');
  const b = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  await b.account.init();
  assert.equal(b.account.getState().phase, 'signedOut');
  assert.equal(r.server.calls.length, calls);
  // 記憶域が回復（印が正しく読める）すると、閉じた session だと分かって捨てられる。新しいログインは使える
  r.marker.map.set('certgarden-account:revoked-sid:v1', JSON.parse(r.secure.map.get(SESSION_KEY)!).sid);
  r.secure.failRemoves = false;
  const c = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  await c.account.init();
  assert.equal(c.account.getState().phase, 'signedOut');
  assert.equal(r.secure.map.has(SESSION_KEY), false);
  assert.equal((await c.account.signIn('google')).ok, true);
  // 印がそもそも無い（正常な初回・一度もログアウトしていない）なら、保存された session は普通に使える
  const fresh = rig();
  await signedIn(fresh);
  const again = rig({ server: fresh.server, base: fresh.base, secure: fresh.secure, marker: fresh.marker });
  await again.account.init();
  assert.equal(again.account.getState().phase, 'signedIn');
});

// ================= ログイン =================

test('ログイン: サーバーの nonce をそのまま IdP へ渡し、成功したら session を Keychain にだけ保存する（AsyncStorage 側には token を置かない）', async () => {
  const r = rig();
  await r.account.init();
  assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: null });
  const res = await r.account.signIn('google');
  assert.deepEqual(res, { ok: true });
  assert.equal(r.account.getState().phase, 'signedIn');
  assert.equal(r.google.nonces.length, 1);
  assert.match(r.google.nonces[0]!, /^n/);
  const stored = r.secure.map.get(SESSION_KEY)!;
  assert.ok(stored.includes('"accessToken"'));
  for (const kv of [r.base.map, r.marker.map]) for (const [k, v] of kv) assert.ok(!v.includes(JSON.parse(stored).tokens.accessToken), `token が ${k} にある`);
  // 再起動後も復帰
  const again = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  await again.account.init();
  assert.equal(again.account.getState().phase, 'signedIn');
});

test('ログイン: Apple は identityToken と authorizationCode の両方が要る。コードが無ければ送らない', async () => {
  const r = rig();
  await r.account.init();
  r.apple.next = { kind: 'success', idToken: `fake.apple.s.nonce`, };
  const res = await r.account.signIn('apple');
  assert.deepEqual(res, { ok: false, kind: 'unknown' });
  assert.equal(r.server.count('POST /v1/auth/exchange'), 0);
  r.apple.next = 'ok';
  assert.deepEqual(await r.account.signIn('apple'), { ok: true });
});

test('ログイン: 取り消し・拒否・時間切れ・未対応・例外・サーバー拒否は普通の状態として返り、成功を偽らず session を作らない', async () => {
  const cases: { next: IdpOutcome | 'throw'; kind: FailKind }[] = [
    { next: { kind: 'cancelled' }, kind: 'cancelled' },
    { next: { kind: 'denied' }, kind: 'denied' },
    { next: { kind: 'timeout' }, kind: 'timeout' },
    { next: { kind: 'unavailable' }, kind: 'unavailable' },
    { next: { kind: 'error' }, kind: 'unknown' },
    { next: 'throw', kind: 'unknown' },
  ];
  for (const c of cases) {
    const r = rig();
    await r.account.init();
    r.google.next = c.next;
    assert.deepEqual(await r.account.signIn('google'), { ok: false, kind: c.kind });
    assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: null });
    assert.equal(r.secure.map.size, 0);
    assert.equal(r.server.count('POST /v1/auth/exchange'), 0);
    assert.equal(r.account.isBusy(), false);
    r.google.next = 'ok';
    assert.deepEqual(await r.account.signIn('google'), { ok: true }, 'やり直せる');
  }
  const t = rig({ idpTimeoutMs: 30 });
  await t.account.init();
  t.google.next = 'hang';
  assert.deepEqual(await t.account.signIn('google'), { ok: false, kind: 'timeout' });
  const off = rig();
  await off.account.init();
  off.server.failures.push({ match: (_m, p) => p === '/v1/auth/challenge', mode: 'network' });
  assert.deepEqual(await off.account.signIn('google'), { ok: false, kind: 'offline' });
  const nc = rig();
  await nc.account.init();
  nc.server.failures.push({ match: (_m, p) => p === '/v1/auth/challenge', mode: 'status', status: 503, code: 'provider_not_configured' });
  assert.deepEqual(await nc.account.signIn('google'), { ok: false, kind: 'notConfigured' });
});

test('ログイン: 連続タップ・実行中の別操作は busy で断り、二重に challenge を作らない。保存に失敗した session は使わない', async () => {
  const r = rig();
  await r.account.init();
  const a = r.account.signIn('google');
  const b = r.account.signIn('google');
  assert.deepEqual(await b, { ok: false, kind: 'busy' });
  assert.deepEqual(await a, { ok: true });
  assert.equal(r.server.count('POST /v1/auth/challenge'), 1);
  const s = rig();
  await s.account.init();
  s.secure.failNextWrites = 1;
  assert.deepEqual(await s.account.signIn('google'), { ok: false, kind: 'storage' });
  assert.equal(s.account.getState().phase, 'signedOut');
  assert.equal(s.server.count('POST /v1/auth/logout'), 1, 'サーバー側の session も閉じる');
});

// ================= セッションの更新 =================

test('更新: 期限間近の access で複数の呼び出しが同時に来ても、refresh は1本だけ（single-flight）で全員成功', async () => {
  const r = rig();
  await signedIn(r);
  r.server.clock += 14.5 * 60_000; // access の期限の直前
  const calls = await Promise.all([1, 2, 3, 4, 5].map(() => r.account.withSession((a) => new ApiClient({ baseUrl: 'https://api.example.test', fetch: r.server.fetch }).getBackup(a))));
  assert.equal(calls.length, 5);
  assert.equal(r.server.count('POST /v1/auth/refresh'), 1);
  assert.equal(r.account.getState().phase, 'signedIn');
  assert.equal(r.server.revoked.size, 0, 'family を失効させていない');
});

test('更新: 401 は1回だけ更新して再実行。更新後も 401 なら安全に再ログインへ（session を消す）', async () => {
  const r = rig();
  await signedIn(r);
  let n = 0;
  const out = await r.account.withSession(async (a) => {
    n += 1;
    if (n === 1) throw new ApiError('http', 401, 'unauthorized');
    return a.length;
  });
  assert.ok(out > 0);
  assert.equal(r.server.count('POST /v1/auth/refresh'), 1);
  await assert.rejects(r.account.withSession(async () => { throw new ApiError('http', 401, 'unauthorized'); }));
  assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: 'sessionExpired' });
  assert.equal(r.secure.map.has(SESSION_KEY), false);
});

test('更新: 通信失敗・5xx・401（盗用/失効）は更新 token の行方が分からないので再試行せず、安全に再ログインへ。端末のデータは消さない。429 だけ session を残す', async () => {
  for (const f of [{ mode: 'network' as const }, { mode: 'status' as const, status: 500 }, { mode: 'status' as const, status: 401, code: 'invalid_refresh_token' }]) {
    const r = rig();
    await signedIn(r);
    await seedLocal(r.data);
    const before = JSON.stringify([...r.base.map.entries()]);
    r.server.clock += 14.9 * 60_000;
    r.server.failures.push({ match: (_m, p) => p === '/v1/auth/refresh', ...f });
    const res = await r.account.upload();
    assert.deepEqual(res, { ok: false, kind: 'sessionLost' });
    assert.equal(r.server.count('POST /v1/auth/refresh'), 1, '再試行しない');
    assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: 'sessionExpired' });
    assert.equal(JSON.stringify([...r.base.map.entries()]), before, '端末のデータは変わらない');
  }
  const r = rig();
  await signedIn(r);
  r.server.clock += 14.9 * 60_000;
  r.server.failures.push({ match: (_m, p) => p === '/v1/auth/refresh', mode: 'status', status: 429, code: 'rate_limited' });
  assert.equal((await r.account.upload()).ok, false);
  assert.equal(r.account.getState().phase, 'signedIn', '429 は session を残す');
  assert.ok(r.secure.map.has(SESSION_KEY));
});

test('更新: 更新で新しい token を受け取ったら Keychain の session も入れ替わる（古い token は残らない）', async () => {
  const r = rig();
  await signedIn(r);
  const old = JSON.parse(r.secure.map.get(SESSION_KEY)!).tokens.refreshToken as string;
  r.server.clock += 14.9 * 60_000;
  await r.account.withSession(async () => 1);
  const now = JSON.parse(r.secure.map.get(SESSION_KEY)!).tokens.refreshToken as string;
  assert.notEqual(now, old);
});

// ================= クラウド保存 =================

test('保存: 現在の端末データ9項目を集め、手帳は送受信の形（オブジェクト）に包んで送る。購入・権利・比較設定は含まない。送信後は「変更なし」と分かる', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r);
  const res = await r.account.upload();
  assert.deepEqual(res, { ok: true, revision: 1, replayed: false });
  const uid = (r.account.getState() as { userId: string }).userId;
  const sent = JSON.parse(r.server.backups.get(uid)!.payload) as { entries: Record<string, string> };
  assert.deepEqual(Object.keys(sent.entries).sort(), [...BACKUP_KEYS].sort());
  assert.deepEqual(JSON.parse(sent.entries[NOTEBOOK_KEY]!), { v: 1, entries: [{ id: 'n1', name: 'ITパスポート', date: '', memo: '比較メモ' }] });
  assert.ok(!Object.keys(sent.entries).some((k) => /compare|purchase|entitle|session|token/.test(k)));
  const st = await r.account.localStatus();
  assert.deepEqual({ dirty: st.dirty, rev: st.revision }, { dirty: false, rev: 1 });
  await new NotebookStore(r.data).save([]);
  assert.equal((await r.account.localStatus()).dirty, true, '未送信の変更が分かる');
});

test('保存: 手帳の送受信の形は往復で元に戻り、形が違えば拒否する', () => {
  const raw = JSON.stringify([{ id: 'a', name: 'x', date: '', memo: '' }]);
  assert.equal(fromTransport(NOTEBOOK_KEY, toTransport(NOTEBOOK_KEY, raw)), raw);
  assert.throws(() => fromTransport(NOTEBOOK_KEY, '[]'));
  assert.throws(() => fromTransport(NOTEBOOK_KEY, JSON.stringify({ v: 2, entries: [] })));
  assert.throws(() => fromTransport(NOTEBOOK_KEY, JSON.stringify({ v: 1, entries: [], extra: 1 })));
  assert.equal(toTransport(CORE_KEY, '{"a":1}'), '{"a":1}');
});

test('保存: 端末のデータが壊れている・学習がまだ無い時は送らず、何も変えない', async () => {
  const bad = rig();
  await seedLocal(bad.data);
  await signedIn(bad);
  await bad.base.setItem(NOTEBOOK_KEY, '{broken');
  const before = JSON.stringify([...bad.base.map.entries()]);
  const res = await bad.account.upload();
  assert.equal(res.ok, false);
  assert.deepEqual(res.ok === false && 'keys' in res ? res.keys : null, [NOTEBOOK_KEY]);
  assert.equal(bad.server.count('PUT /v1/backup'), 0);
  assert.equal(JSON.stringify([...bad.base.map.entries()]), before);
  const empty = rig();
  await signedIn(empty);
  const e = await empty.account.upload();
  assert.equal(e.ok === false && e.kind, 'nothing');
  assert.equal(empty.server.count('PUT /v1/backup'), 0);
  const coreBad = rig();
  await seedLocal(coreBad.data);
  await signedIn(coreBad);
  await coreBad.base.setItem(CORE_KEY, JSON.stringify({ schemaVersion: 2 }));
  const c = await coreBad.account.upload();
  assert.equal(c.ok === false && c.kind, 'invalidLocal');
});

test('保存: クラウドに保存があり、この端末が結び付いていない時は自動で上書きしない（本人の選択が要る）。選んだ後は現在の版を基準に送る', async () => {
  const first = rig();
  await seedLocal(first.data, '端末1');
  await signedIn(first);
  assert.equal((await first.account.upload()).ok, true);
  // 別の端末（同じアカウント）
  const second = rig({ server: first.server });
  await seedLocal(second.data, '端末2');
  await signedIn(second);
  const r = await second.account.upload();
  assert.deepEqual(r.ok === false && r.kind === 'needsChoice' ? { reason: r.reason, rev: r.serverRevision } : r, { reason: 'cloudHasData', rev: 1 });
  assert.equal(second.server.count('PUT /v1/backup'), 1, '2回目のPUTはしていない（最初の端末の1回だけ）');
  const forced = await second.account.upload({ overwrite: true });
  assert.deepEqual(forced, { ok: true, revision: 2, replayed: false });
});

test('保存: 409（別の端末が先に更新）は conflict を返し、自動で上書きもせず、端末のデータも変えない', async () => {
  const a = rig();
  await seedLocal(a.data, 'A');
  await signedIn(a);
  assert.equal((await a.account.upload()).ok, true);
  const b = rig({ server: a.server });
  await signedIn(b);
  assert.equal((await b.account.restore({ confirmed: true })).ok, true);
  await new NotebookStore(a.data).save([{ id: 'n2', name: 'Aの変更', date: '', memo: '' }]);
  assert.equal((await a.account.upload()).ok, true); // revision 2
  await new NotebookStore(b.data).save([{ id: 'n3', name: 'Bの変更', date: '', memo: '' }]);
  const localB = await b.data.getItem(NOTEBOOK_KEY);
  const cloud = a.server.backups.get((a.account.getState() as { userId: string }).userId)!.payload;
  const res = await b.account.upload();
  assert.deepEqual(res, { ok: false, kind: 'conflict', serverRevision: 2 });
  assert.equal(await b.data.getItem(NOTEBOOK_KEY), localB);
  assert.equal(a.server.backups.get((b.account.getState() as { userId: string }).userId)!.payload, cloud, 'クラウドは変わっていない');
});

test('保存: 応答だけ失った送信を再試行しても、同じ requestId で二重適用にならず revision は1つだけ進む。通信失敗では端末のデータは変わらない', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r);
  r.server.failures.push({ match: (m, p) => m === 'PUT' && p === '/v1/backup', mode: 'network', afterApply: true });
  const first = await r.account.upload();
  assert.deepEqual(first, { ok: false, kind: 'offline' });
  const second = await r.account.upload();
  assert.deepEqual(second, { ok: true, revision: 1, replayed: true });
  const uid = (r.account.getState() as { userId: string }).userId;
  assert.equal(r.server.backups.get(uid)!.revision, 1);
  const third = await r.account.upload(); // 変更なしでもう一度送るのは新しい版
  assert.equal(third.ok, true);
});

test('保存: アカウントA/Bの保存は混ざらない。Aの端末データをBが使うときは確認が要り、Bのクラウドは別', async () => {
  const r = rig();
  await seedLocal(r.data, 'Aのメモ');
  r.google.who = 'sub-A';
  await signedIn(r);
  assert.equal((await r.account.upload()).ok, true);
  const aId = (r.account.getState() as { userId: string }).userId;
  await r.account.logout();
  r.google.who = 'sub-B';
  assert.deepEqual(await r.account.signIn('google'), { ok: true });
  const bId = (r.account.getState() as { userId: string }).userId;
  assert.notEqual(aId, bId);
  const choice = await r.account.upload();
  assert.equal(choice.ok === false && choice.kind === 'needsChoice' && choice.reason, 'otherAccount');
  assert.equal(r.server.backups.has(bId), false, '確認前にBへ送っていない');
  assert.equal((await r.account.restore({ confirmed: true })).ok === false, true, 'Bのクラウドは空');
  assert.equal(r.server.backups.get(aId)!.revision, 1, 'Aのクラウドは変わっていない');
  const sent = await r.account.upload({ overwrite: true });
  assert.deepEqual(sent, { ok: true, revision: 1, replayed: false });
  assert.equal(r.server.backups.get(aId)!.revision, 1);
});

// ================= 復元 =================

async function cloudWith(memo: string): Promise<Rig> {
  const src = rig();
  await seedLocal(src.data, memo);
  await signedIn(src);
  assert.equal((await src.account.upload()).ok, true);
  return src;
}

test('復元: 確認なしでは何もしない。確認後は全9項目を検査し、新しい世代に書き切ってから切り替える。元の内容は旧世代に残り、元に戻せる', async () => {
  const src = await cloudWith('クラウドのメモ');
  const dst = rig({ server: src.server });
  await seedLocal(dst.data, '端末のメモ');
  await signedIn(dst);
  const legacy = await dst.base.getItem(NOTEBOOK_KEY);
  const gets = dst.server.count('GET /v1/backup');
  assert.deepEqual(await dst.account.restore({ confirmed: false }), { ok: false, kind: 'invalidState' });
  assert.equal(dst.server.count('GET /v1/backup'), gets, '確認なしでは取得もしない');
  const stale = dst.data.view(); // 復元前に画面へ渡した窓口
  const res = await dst.account.restore({ confirmed: true });
  assert.equal(res.ok, true);
  const nb = await new NotebookStore(dst.data).load();
  assert.equal(nb[0]!.memo, 'クラウドのメモ');
  assert.equal(await dst.base.getItem(NOTEBOOK_KEY), legacy, '元のキーは消していない');
  const uid = (dst.account.getState() as { userId: string }).userId;
  assert.deepEqual(await dst.data.currentGeneration(), { gen: 1, prev: null, owner: uid });
  // 古い画面の状態が、復元した内容を書き戻して壊さない
  await assert.rejects(stale.setItem(NOTEBOOK_KEY, '[]'));
  assert.equal((await new NotebookStore(dst.data).load())[0]!.memo, 'クラウドのメモ');
  // 元に戻す（初めての復元なので、復元前のゲストのデータへ）
  assert.equal(await dst.account.undoKind(), 'toGuest');
  assert.deepEqual(await dst.account.undoRestore(), { ok: true });
  assert.equal((await new NotebookStore(dst.data).load())[0]!.memo, '端末のメモ');
  assert.deepEqual(await dst.data.currentGeneration(), { gen: 0, prev: null, owner: 'guest' });
  assert.equal(await dst.account.undoKind(), 'none');
});

test('取り消し: 画面を作り直しても・再起動しても、世代の記録から「戻せる」と分かり、実際に戻る。別のアカウントの世代へは戻せない', async () => {
  const src = await cloudWith('クラウドA');
  const dst = rig({ server: src.server });
  await seedLocal(dst.data, 'ゲスト');
  await signedIn(dst);
  assert.equal(await dst.account.undoKind(), 'none');
  assert.equal((await dst.account.restore({ confirmed: true })).ok, true);
  assert.equal(await dst.account.undoKind(), 'toGuest');
  // 2回目の復元（クラウドを更新してから）→ 直前の世代へ戻せる
  await new NotebookStore(dst.data).save([{ id: 'n9', name: '復元後の手帳', date: '', memo: 'A2' }]);
  assert.equal((await dst.account.upload()).ok, true);
  await new NotebookStore(dst.data).save([{ id: 'n9', name: '復元後の手帳', date: '', memo: 'ローカル変更' }]);
  assert.equal((await dst.account.restore({ confirmed: true })).ok, true);
  assert.equal(await dst.account.undoKind(), 'previous');
  // 再起動（別の Service・別の GenerationKv。メモリ状態なし）でも分かる
  const again = rig({ server: src.server, base: dst.base, secure: dst.secure, marker: dst.marker });
  await again.account.init();
  assert.equal(again.account.getState().phase, 'signedIn');
  assert.equal(await again.account.undoKind(), 'previous');
  assert.deepEqual(await again.account.undoRestore(), { ok: true });
  assert.equal((await new NotebookStore(again.data).load())[0]!.memo, 'ローカル変更');
  assert.equal(await again.account.undoKind(), 'toGuest', '最初の復元の状態に戻った。さらに戻すとゲストの原本');
  // ログアウトすると誰の世代にも戻せない（ゲスト側では undo 不可）
  await again.account.logout();
  assert.equal(await again.account.undoKind(), 'none');
  assert.deepEqual(await again.account.undoRestore(), { ok: false });
});

// ================= 世代の所有者（アカウントごとの端末内コピー） =================

test('所有者: guest→A→Aで復元→ログアウト→guest→B。Aの手帳等はゲストにもBにも出ない。A再ログインで本人分が再開し、ゲストの原本は保全される', async () => {
  const server = new FakeServer();
  const A = rig({ server });
  A.google.who = 'sub-A';
  await seedLocal(A.data, 'Aのクラウド内容');
  await signedIn(A);
  assert.equal((await A.account.upload()).ok, true);
  // 同じ端末: ゲストの原本は別の内容
  const d = rig({ server });
  await seedLocal(d.data, 'ゲストの原本');
  d.google.who = 'sub-A';
  await signedIn(d);
  const guestRaw = await d.base.getItem(NOTEBOOK_KEY);
  assert.equal((await d.account.restore({ confirmed: true })).ok, true);
  assert.equal((await new NotebookStore(d.data).load())[0]!.memo, 'Aのクラウド内容');
  // Aとして端末内で変更
  await new NotebookStore(d.data).save([{ id: 'a1', name: 'Aだけの記録', date: '', memo: 'Aの秘密' }]);
  const aOnly = d.base.map.get('g1/' + NOTEBOOK_KEY)!;
  assert.ok(aOnly.includes('Aの秘密'));
  // ログアウト → ゲストに戻る（Aの内容は見えない）
  assert.deepEqual(await d.account.logout(), { ok: true });
  const seenGuest = JSON.stringify(await new NotebookStore(d.data).load());
  assert.ok(!seenGuest.includes('Aの秘密') && !seenGuest.includes('Aのクラウド内容'));
  assert.equal(await d.base.getItem(NOTEBOOK_KEY), guestRaw, 'ゲストの原本は一切変わっていない');
  // B がログイン（B のクラウドは空・A の内容は見えない）
  d.google.who = 'sub-B';
  assert.deepEqual(await d.account.signIn('google'), { ok: true });
  const seenB = JSON.stringify(await new NotebookStore(d.data).load());
  assert.ok(!seenB.includes('Aの秘密') && !seenB.includes('Aのクラウド内容') && seenB.includes('ゲストの原本'));
  assert.equal((await d.data.currentGeneration()).owner, 'guest');
  // B が A のコピーを送ってしまう経路が無い: ゲストのデータを送ると確認が要る（別アカウントに結び付いていた）
  // A に戻る
  await d.account.logout();
  d.google.who = 'sub-A';
  assert.deepEqual(await d.account.signIn('google'), { ok: true });
  const back = JSON.stringify(await new NotebookStore(d.data).load());
  assert.ok(back.includes('Aの秘密'), '再ログインで本人分が再開');
  assert.equal(await d.base.getItem(NOTEBOOK_KEY), guestRaw);
});

test('所有者: 退会するとそのアカウントの端末内コピー・元に戻す用の残り・結び付け・保留中の送信が消え、ゲストは無傷。別のアカウントのコピーは残る', async () => {
  const server = new FakeServer();
  const src = rig({ server });
  await seedLocal(src.data, 'クラウド1');
  src.google.who = 'sub-A';
  await signedIn(src);
  assert.equal((await src.account.upload()).ok, true);
  const d = rig({ server });
  await seedLocal(d.data, 'ゲスト');
  d.google.who = 'sub-A';
  await signedIn(d);
  const guestRaw = await d.base.getItem(NOTEBOOK_KEY);
  assert.equal((await d.account.restore({ confirmed: true })).ok, true);
  await new NotebookStore(d.data).save([{ id: 'a2', name: '変更', date: '', memo: 'A2' }]);
  assert.equal((await d.account.upload()).ok, true);
  assert.equal((await d.account.restore({ confirmed: true })).ok, true); // 元に戻す用の世代ができる
  const gens = [...d.base.map.keys()].filter((k) => /^g\d+\//.test(k));
  assert.ok(gens.length >= 18, '2世代分');
  // 別のアカウント B の端末内コピーも作っておく
  const b = rig({ server });
  b.google.who = 'sub-B';
  await seedLocal(b.data, 'Bのクラウド');
  await signedIn(b);
  assert.equal((await b.account.upload()).ok, true);
  const res = await d.account.deleteAccount();
  assert.deepEqual(res, { ok: true, appleRevocation: 'not_applicable', localCleanup: 'done' });
  assert.deepEqual([...d.base.map.keys()].filter((k) => /^g\d+\//.test(k)), [], 'A の世代はすべて消えた');
  assert.equal([...d.base.map.keys()].some((k) => k.startsWith('account-binding') || k.startsWith('account-pending')), false);
  assert.equal(await d.base.getItem(NOTEBOOK_KEY), guestRaw, 'ゲストは無傷');
  assert.equal((await d.data.currentGeneration()).owner, 'guest');
  assert.equal((await new NotebookStore(d.data).load())[0]!.memo, 'ゲスト');
  // 再起動しても A のコピーは見えない・残骸もない
  const again = rig({ server, base: d.base, secure: d.secure, marker: d.marker });
  await again.account.init();
  assert.equal(again.account.getState().phase, 'signedOut');
  assert.deepEqual([...again.base.map.keys()].filter((k) => /^g\d+\//.test(k)), []);
});

test('所有者: 退会後の端末内の後始末が途中で止まっても（消去の失敗・電源断）、そのコピーは誰にも見えず、成功とは言わず、次の起動で消える', async () => {
  const server = new FakeServer();
  const src = rig({ server });
  await seedLocal(src.data, 'クラウド');
  src.google.who = 'sub-A';
  await signedIn(src);
  assert.equal((await src.account.upload()).ok, true);
  const d = rig({ server });
  await seedLocal(d.data, 'ゲスト');
  d.google.who = 'sub-A';
  await signedIn(d);
  assert.equal((await d.account.restore({ confirmed: true })).ok, true);
  // 世代のキー削除だけ失敗させる（ストレージ障害）
  const realRemove = d.base.removeItem.bind(d.base);
  let failing = true;
  d.base.removeItem = async (k: string) => {
    if (failing && /^g\d+\//.test(k)) throw new Error('io error');
    return realRemove(k);
  };
  const res = await d.account.deleteAccount();
  assert.equal(res.ok && res.localCleanup, 'pending', '消し切れていないことを正直に返す');
  assert.ok([...d.base.map.keys()].some((k) => /^g\d+\//.test(k)), '残骸はある');
  assert.equal((await d.data.currentGeneration()).owner, 'guest', 'でもポインターからは外れ、見えない');
  assert.equal((await new NotebookStore(d.data).load())[0]!.memo, 'ゲスト');
  // 別のアカウントがログインしても A のコピーは見えない
  d.google.who = 'sub-B';
  assert.deepEqual(await d.account.signIn('google'), { ok: true });
  assert.equal((await new NotebookStore(d.data).load())[0]!.memo, 'ゲスト');
  // 再起動（まだ失敗する）→ 残る。直れば消える
  const r1 = rig({ server, base: d.base, secure: d.secure, marker: d.marker });
  await r1.account.init();
  assert.ok([...d.base.map.keys()].some((k) => /^g\d+\//.test(k)));
  failing = false;
  const r2 = rig({ server, base: d.base, secure: d.secure, marker: d.marker });
  await r2.account.init();
  assert.deepEqual([...d.base.map.keys()].filter((k) => /^g\d+\//.test(k)), []);
});

test('所有者: ログアウト直後に世代の記録を書けなくても、メモリ上はゲストに切り替わり、再起動後も session が無ければゲスト（前のアカウントのデータを見せない）', async () => {
  const server = new FakeServer();
  const src = rig({ server });
  await seedLocal(src.data, 'クラウド');
  await signedIn(src);
  assert.equal((await src.account.upload()).ok, true);
  const d = rig({ server });
  await seedLocal(d.data, 'ゲスト');
  await signedIn(d);
  assert.equal((await d.account.restore({ confirmed: true })).ok, true);
  const realSet = d.base.setItem.bind(d.base);
  d.base.setItem = async (k: string, v: string) => {
    if (k === GEN_POINTER_KEY) throw new Error('disk full');
    return realSet(k, v);
  };
  await d.account.logout();
  assert.equal((await d.data.currentGeneration()).owner, 'guest');
  assert.equal((await new NotebookStore(d.data).load())[0]!.memo, 'ゲスト');
  d.base.setItem = realSet;
  const r = rig({ server, base: d.base, secure: d.secure, marker: d.marker });
  await r.account.init();
  assert.equal(r.account.getState().phase, 'signedOut');
  assert.equal((await new NotebookStore(r.data).load())[0]!.memo, 'ゲスト');
});

test('世代の記録: 旧形式 {gen, prev} は guest 空間として引き継ぎ、壊れた v2 は拒否する', async () => {
  const base = new MemoryKv();
  base.map.set(GEN_POINTER_KEY, JSON.stringify({ gen: 3, prev: 2 }));
  base.map.set('g3/' + NOTEBOOK_KEY, '[]');
  const g = new GenerationKv(base);
  assert.deepEqual(await g.currentGeneration(), { gen: 3, prev: 2, owner: 'guest' });
  assert.equal(await g.getItem(NOTEBOOK_KEY), '[]');
  for (const bad of [{ v: 2, active: 'x', spaces: {}, next: 1, garbage: [] }, { v: 2, active: 'guest', spaces: { guest: { gen: -1, prev: null } }, next: 1, garbage: [] }, { v: 3 }]) {
    const b = new MemoryKv();
    b.map.set(GEN_POINTER_KEY, JSON.stringify(bad));
    await assert.rejects(new GenerationKv(b).getItem(NOTEBOOK_KEY));
  }
});

test('復元: 中断した学習もクラウドの内容に置き換わるが、再起動後も新しい世代を使い続ける', async () => {
  const src = await cloudWith('x');
  const dst = rig({ server: src.server });
  const stageId = await seedLocal(dst.data, 'local');
  await signedIn(dst);
  assert.equal((await dst.account.restore({ confirmed: true })).ok, true);
  const reopened = new GenerationKv(dst.base); // 再起動相当
  assert.deepEqual(await reopened.currentGeneration(), { gen: 1, prev: null, owner: (dst.account.getState() as { userId: string }).userId });
  const core = await StudyCore.open({ storage: new KvStorage(reopened), content: new BitPatternsContent(), clock: { now: () => T0 } });
  assert.ok(core.findResumable(), 'クラウドの学習が復帰');
  assert.notEqual(stageId, undefined);
});

test('復元: 欠けた項目・余分な項目・壊れた項目・版違い・手帳の包み違いは受け付けず、端末は1バイトも変えない', async () => {
  const src = await cloudWith('x');
  const uid = (src.account.getState() as { userId: string }).userId;
  const good = JSON.parse(src.server.backups.get(uid)!.payload) as { format: string; version: number; entries: Record<string, string> };
  const mutate = (fn: (b: typeof good) => void) => {
    const b = JSON.parse(JSON.stringify(good)) as typeof good;
    fn(b);
    return b;
  };
  const bundles: { name: string; bundle: typeof good; kind: string }[] = [
    { name: '項目が欠けた', bundle: mutate((b) => delete b.entries['certgarden:furniture:v1']), kind: 'incomplete' },
    { name: '未知の項目', bundle: mutate((b) => { b.entries['certgarden:purchases:v1'] = '{}'; }), kind: 'incomplete' },
    { name: '核が別の版', bundle: mutate((b) => { b.entries[CORE_KEY] = JSON.stringify({ schemaVersion: 2 }); }), kind: 'invalid' },
    { name: '部屋が不正', bundle: mutate((b) => { b.entries['certgarden:room:v1'] = JSON.stringify({ room: 'moon' }); }), kind: 'invalid' },
    { name: '手帳の包み違い', bundle: mutate((b) => { b.entries[NOTEBOOK_KEY] = '[]'; }), kind: 'invalid' },
    { name: '手帳の中身が不正', bundle: mutate((b) => { b.entries[NOTEBOOK_KEY] = JSON.stringify({ v: 1, entries: [{ id: 1 }] }); }), kind: 'invalid' },
    { name: '設定が不正', bundle: mutate((b) => { b.entries['certgarden:settings:v1'] = JSON.stringify({ companion: 'x', reduceMotion: 1 }); }), kind: 'invalid' },
    { name: '家具が不正', bundle: mutate((b) => { b.entries['certgarden:furniture:v1'] = JSON.stringify({ version: 1, placed: [{ id: 'nope', x: 0, y: 0 }] }); }), kind: 'invalid' },
    { name: '形式が違う', bundle: mutate((b) => { b.version = 2; }), kind: 'invalid' },
    { name: 'JSONでない', bundle: mutate((b) => { b.entries[CORE_KEY] = 'oops'; }), kind: 'invalid' },
  ];
  for (const c of bundles) {
    await assert.rejects(validateBundle(c.bundle), (e: unknown) => e instanceof BackupError && e.kind === c.kind, c.name);
  }
  // サービス経由: サーバーが壊れた束を返しても端末は変わらない
  const dst = rig({ server: src.server });
  await seedLocal(dst.data, 'local');
  await signedIn(dst);
  const before = JSON.stringify([...dst.base.map.entries()]);
  const duid = (dst.account.getState() as { userId: string }).userId;
  assert.equal(duid, uid);
  const rec = src.server.backups.get(uid)!;
  src.server.backups.set(uid, { ...rec, payload: JSON.stringify(bundles[0]!.bundle) });
  const res = await dst.account.restore({ confirmed: true });
  assert.equal(res.ok === false && res.kind, 'incompleteCloud');
  assert.equal(JSON.stringify([...dst.base.map.entries()]), before);
  assert.deepEqual(await dst.data.currentGeneration(), { gen: 0, prev: null, owner: 'guest' });
});

test('復元: 途中の書き込みが失敗しても旧世代のまま（ポインターは動かず、書きかけは片付く）。再起動後も旧データを使う', async () => {
  const src = await cloudWith('クラウド');
  for (const failAt of [1, 5, 9, 10]) {
    const flaky = new FlakyKv(new MemoryKv());
    const dst = rig({ server: src.server, base: flaky.inner as MemoryKv });
    // FlakyKv を土台に差し替え: rig は MemoryKv を前提にするので、書き込み失敗は GenerationKv の内側に差し込む
    const gkv = new GenerationKv(flaky);
    await seedLocal(gkv, '端末');
    const account = createAccountService({
      runtime: 'native', env: READY_ENV, fetch: src.server.fetch, secure: new MemorySecureKv(), installMarker: new MemoryKv(), data: gkv, meta: gkv,
      idp: { google: dst.google, apple: dst.apple }, now: () => src.server.clock, newId: () => `id-${++idSeq}-${'q'.repeat(12)}`,
    });
    await account.init();
    assert.deepEqual(await account.signIn('google'), { ok: true });
    const before = JSON.stringify([...(flaky.inner as MemoryKv).map.entries()]);
    flaky.sets = 0;
    flaky.failAtSet = failAt;
    const res = await account.restore({ confirmed: true });
    assert.deepEqual(res, { ok: false, kind: 'writeFailed' }, `失敗位置 ${failAt}`);
    flaky.failAtSet = -1;
    assert.equal(JSON.stringify([...(flaky.inner as MemoryKv).map.entries()]), before, `書きかけが残らない/元が変わらない (${failAt})`);
    assert.equal(await (flaky.inner as MemoryKv).getItem(GEN_POINTER_KEY), null);
    assert.equal((await new NotebookStore(new GenerationKv(flaky.inner)).load())[0]!.memo, '端末');
    // やり直せば成功する
    assert.equal((await account.restore({ confirmed: true })).ok, true);
  }
});

test('復元: 書き込みは成功を返したが読み戻すと違う場合は切り替えない', async () => {
  const base = new MemoryKv();
  const gkv = new GenerationKv({
    getItem: (k) => base.getItem(k),
    setItem: async (k, v) => base.setItem(k, k.endsWith(NOTEBOOK_KEY) && k.startsWith('g') ? v + ' ' : v),
    removeItem: (k) => base.removeItem(k),
  });
  const src = await cloudWith('x');
  const uid = (src.account.getState() as { userId: string }).userId;
  const entries = await validateBundle(JSON.parse(src.server.backups.get(uid)!.payload));
  await assert.rejects(gkv.commit(entries, 'u-test'));
  assert.deepEqual(await gkv.currentGeneration(), { gen: 0, prev: null, owner: 'guest' });
  assert.equal([...base.map.keys()].some((k) => k.startsWith('g1/')), false);
});

test('世代: 世代0は従来のキーのまま読み書きできる。世代の記録が壊れていれば読み書きを止める（別データを黙って見せない）', async () => {
  const base = new MemoryKv();
  const g = new GenerationKv(base);
  await g.setItem(NOTEBOOK_KEY, '[]');
  assert.equal(base.map.get(NOTEBOOK_KEY), '[]');
  await g.setItem('compare:v1', 'x');
  assert.equal(base.map.get('compare:v1'), 'x');
  base.map.set(GEN_POINTER_KEY, '{broken');
  const bad = new GenerationKv(base);
  await assert.rejects(bad.getItem(NOTEBOOK_KEY));
  await assert.rejects(bad.setItem(NOTEBOOK_KEY, '[1]'));
  assert.equal(base.map.get(NOTEBOOK_KEY), '[]');
});

// ================= ログアウト / 退会 =================

test('ログアウト: サーバーへ通知できなくても端末の session は消え、端末のデータは残る', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r);
  const before = JSON.stringify([...r.base.map.entries()]);
  r.server.failures.push({ match: (_m, p) => p === '/v1/auth/logout', mode: 'network' });
  assert.deepEqual(await r.account.logout(), { ok: true });
  assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: null });
  assert.equal(r.secure.map.size, 0);
  assert.equal(JSON.stringify([...r.base.map.entries()]), before);
});

test('退会: 再ログインして確認した後だけ削除。成功で session と結び付けを消し、端末のデータ（ゲスト保存）は残す。実ユーザーではなく偽サーバーだけ', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r, 'apple');
  assert.equal((await r.account.upload()).ok, true);
  const uid = (r.account.getState() as { userId: string }).userId;
  const before = JSON.stringify([...r.base.map.entries()].filter(([k]) => !k.includes('account-binding')));
  const res = await r.account.deleteAccount();
  assert.deepEqual(res, { ok: true, appleRevocation: 'revoked', localCleanup: 'done' });
  assert.equal(r.server.users.has(uid), false);
  assert.equal(r.server.backups.has(uid), false);
  assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: 'deleted' });
  assert.equal(r.secure.map.size, 0);
  assert.equal(await r.data.getItem('account-binding:v1:guest'), null);
  assert.equal(JSON.stringify([...r.base.map.entries()]), before, 'ゲストの保存は残る');
  assert.equal(r.apple.nonces.length, 2, 'ログインと再認証でそれぞれ新しい nonce');
  assert.notEqual(r.apple.nonces[0], r.apple.nonces[1]);
});

test('退会: 再認証の取り消しでは何も削除せず、session も残る。Appleの連携解除が失敗(502)なら何も消えず、再試行で完了する', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r, 'apple');
  const uid = (r.account.getState() as { userId: string }).userId;
  r.apple.next = { kind: 'cancelled' };
  assert.deepEqual(await r.account.deleteAccount(), { ok: false, kind: 'cancelled' });
  assert.equal(r.server.count('DELETE /v1/account'), 0);
  assert.equal(r.server.users.has(uid), true);
  r.apple.next = 'ok';
  r.server.failures.push({ match: (m, p) => m === 'DELETE' && p === '/v1/account', mode: 'status', status: 502, code: 'apple_revoke_failed' });
  assert.deepEqual(await r.account.deleteAccount(), { ok: false, kind: 'revokeFailed' });
  assert.equal(r.server.users.has(uid), true, '何も削除していない');
  assert.equal(r.account.getState().phase, 'signedIn', 'session は残り、再試行できる');
  assert.equal((await r.account.deleteAccount()).ok, true);
  assert.equal(r.server.users.has(uid), false);
});

// ================= 補助・契約・ソース =================

test('契約: 9キーはサーバーの許可キーと一致する。手帳は配列なのでサーバーの「値はオブジェクト」に合わせて包む（サーバー側は変更していない）', () => {
  const src = read('../../server/src/backup.ts');
  const block = /ALLOWED_KEYS = \[([\s\S]*?)\] as const/.exec(src)![1]!;
  const server = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  assert.deepEqual([...BACKUP_KEYS].sort(), server.sort());
  assert.match(src, /if \(!isObj\(parsed\)\) throw new HttpError\(400/, 'サーバーは配列の値を受け付けない');
});

test('ID token の nonce 確認: 載っていない・違うトークンは送らない（署名の検証はサーバー）', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (p: unknown) => `${b64({ alg: 'RS256' })}.${b64(p)}.sig`;
  assert.equal(idTokenNonce(tok({ nonce: 'abc' })), 'abc');
  assert.equal(idTokenNonce(tok({ sub: 'x' })), undefined);
  assert.equal(idTokenNonce('not-a-jwt'), undefined);
  assert.equal(idTokenNonce(`a.${Buffer.from('{bad').toString('base64url')}.c`), undefined);
});

test('文言: すべての失敗に短い日本語の説明があり、token や内部コードを出さない', () => {
  const kinds: FailKind[] = ['invalidState', 'busy', 'cancelled', 'denied', 'timeout', 'unavailable', 'notConfigured', 'offline', 'rejected', 'rateLimited', 'server', 'storage', 'sessionLost', 'revokeFailed', 'providerUnavailable', 'unknown'];
  assert.deepEqual(Object.keys(FAIL_TEXT).sort(), [...kinds].sort());
  for (const k of kinds) assert.ok(FAIL_TEXT[k].length > 3 && !/token|nonce|JWT|[A-Za-z_]{12,}/.test(FAIL_TEXT[k]), k);
});

test('実装の方針: Google は AuthSession の Code+PKCE(S256)+nonce(ASWebAuthenticationSession)。非推奨の Google helper も無料Original SDK も使わず、token は SecureStore だけ、Web には native ログインを出さない', () => {
  const native = read('../src/account/native.ts');
  assert.match(native, /AuthSession\.AuthRequest/);
  assert.match(native, /AuthSession\.ResponseType\.Code/);
  assert.match(native, /CodeChallengeMethod\.S256/);
  assert.match(native, /extraParams: \{ nonce \}/);
  assert.match(native, /code_verifier: request\.codeVerifier/);
  assert.match(native, /idTokenNonce\(tokens\.idToken\) !== nonce/);
  assert.match(native, /scopes: \[\.\.\.GOOGLE_SCOPES\]/);
  assert.match(native, /requestedScopes: \[\]/);
  assert.match(native, /ERR_REQUEST_CANCELED/);
  assert.match(native, /SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.match(read('../src/account/config.ts'), /GOOGLE_SCOPES = \['openid'\]/);
  const all = readdirSync(new URL('../src/account/', import.meta.url)).map((f) => read(`../src/account/${f}`)).join('\n');
  assert.doesNotMatch(all, /providers\/google|useAuthRequest|google-signin|GoogleSignin|firebase|supabase/i);
  assert.doesNotMatch(all, /localStorage\s*[.[]|window\.localStorage|sessionStorage\s*[.[]/);
  // token を AsyncStorage に入れない: asyncKv を使うのは install の目印だけ
  assert.equal(native.split('\n').filter((l) => /asyncKv/.test(l)).length, 2); // import 行と installMarker の行だけ
  assert.match(native, /installMarker: asyncKv,/);
  const webSrc = read('../src/account/native.web.ts');
  const web = webSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); // コメントを除いた実コード
  assert.match(web, /runtime: 'web'/);
  assert.doesNotMatch(web, /expo-secure-store|expo-apple-authentication|AsyncStorage|localStorage/);
  // 秘密を公開環境変数に置かない: 参照する EXPO_PUBLIC は2つの公開識別子だけ
  const names = new Set([...all.matchAll(/EXPO_PUBLIC_[A-Z_]+/g)].map((m) => m[0]));
  assert.deepEqual([...names].sort(), ['EXPO_PUBLIC_API_BASE_URL', 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID']);
});

test('画面: アカウントは手帳の「せってい」の下に置き、比較側だけ。本体(App.tsx)には出さない。確認が要る操作はボタンを分け、飾り文を足さない', () => {
  assert.match(read('../src/ios/Screens.tsx'), /footer=\{<AccountPanel/);
  assert.doesNotMatch(read('../src/App.tsx'), /account|Account/);
  const panel = read('../src/account/AccountPanel.tsx');
  for (const label of ['Googleでログイン', 'クラウドに保存', 'クラウドから復元', 'ログアウト', 'アカウントを削除', '置き換える', '削除する', '復元を元に戻す']) assert.ok(panel.includes(label), label);
  assert.match(panel, /restore\(\{ confirmed: true \}\)/);
  assert.match(panel, /upload\(\{ overwrite \}\)/);
  assert.match(panel, /ログインしなくても、学習・箱庭・無料復習は使えます/);
  assert.doesNotMatch(panel, /おめでとう|ようこそ|最高|お得|無料で始め/);
  const app = read('../src/ios/IosDesignApp.tsx');
  assert.match(app, /new GenerationKv\(prefixed\)/);
  assert.match(app, /new FaultKv\(gen\.view\(\)\)/);
  assert.match(app, /<Runner key=\{epoch\}/);
  assert.match(read('../src/account/AppleButton.tsx'), /AppleAuthenticationButton/);
});

// ================= ビルド前の検査 =================

test('ビルド前: 署名ビルド用の API URL と Google クライアントID が未設定なら止まる。http・localhost・秘密らしい EXPO_PUBLIC 名も止める', () => {
  const app = JSON.parse(read('../app.json'));
  const eas = JSON.parse(read('../eas.json'));
  assert.equal(app.expo.ios.usesAppleSignIn, true);
  const miss = missingForBuild(app, eas);
  // owner・projectId・承認済み bundle ID・Google iOS client ID は入っている。署名ビルド用の API URL（preview/production 各）だけが残る
  assert.equal(miss.length, 2);
  assert.ok(!miss.some((m: string) => m.includes('GOOGLE_IOS_CLIENT_ID')));
  assert.ok(!miss.some((m: string) => m.includes('bundleIdentifier')));
  assert.ok(miss.some((m: string) => m.includes('production.env.EXPO_PUBLIC_API_BASE_URL')));
  assert.ok(miss.some((m: string) => m.includes('preview.env.EXPO_PUBLIC_API_BASE_URL')));
  const env = { EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: CLIENT_ID };
  const filled = { ...eas, build: { ...eas.build, preview: { ...eas.build.preview, env }, production: { ...eas.build.production, env } } };
  const filledApp = { expo: { ...app.expo, owner: 'someone', ios: { ...app.expo.ios, bundleIdentifier: 'com.someone.certgarden' }, extra: { eas: { projectId: '00000000-0000-4000-8000-000000000000' } } } };
  assert.deepEqual(missingForBuild(filledApp, filled), []);
  assert.deepEqual(problems(app, filled, JSON.parse(read('../package.json'))), []);
  const bad = (e: Record<string, string>) => problems(app, { ...eas, build: { ...eas.build, production: { ...eas.build.production, env: e } } }, JSON.parse(read('../package.json')));
  assert.ok(bad({ EXPO_PUBLIC_API_BASE_URL: 'http://api.example.test' }).length > 0);
  assert.ok(bad({ EXPO_PUBLIC_API_BASE_URL: 'https://localhost:8799' }).length > 0);
  assert.ok(bad({ EXPO_PUBLIC_APPLE_PRIVATE_KEY: 'x' }).length > 0);
  assert.ok(bad({ EXPO_PUBLIC_TOKEN_SECRET: 'x' }).length > 0);
  assert.ok(problems({ expo: { ...app.expo, ios: { ...app.expo.ios, usesAppleSignIn: false } } }, eas, JSON.parse(read('../package.json'))).some((p: string) => p.includes('usesAppleSignIn')));
});

test('app.config.js: 有効な Google iOS クライアントIDがあるときだけ、逆順スキームを URL スキームに足す。秘密は読まない', async () => {
  const mod = (await import('../app.config.js')) as { default: (a: { config: Record<string, unknown> }) => Record<string, unknown> };
  const f = mod.default;
  const base = { scheme: 'certgarden', name: 'x' };
  // 通信設定(ATS)は製品相当が既定（HTTPSのみ）。scheme の判定だけを見る
  const withoutAts = (c: Record<string, unknown>) => {
    const { ios, ...rest } = c as { ios?: { infoPlist?: Record<string, unknown> } };
    assert.deepEqual(ios?.infoPlist?.NSAppTransportSecurity, { NSAllowsArbitraryLoads: false });
    return rest;
  };
  const prev = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  try {
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    assert.deepEqual(withoutAts(f({ config: base })), base);
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = 'nope';
    assert.deepEqual(withoutAts(f({ config: base })), base);
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = CLIENT_ID;
    assert.deepEqual(f({ config: base }).scheme, ['certgarden', 'com.googleusercontent.apps.123456789012-abcdefghijklmnop']);
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = prev;
  }
  const text = read('../app.config.js');
  assert.doesNotMatch(text, /SECRET|PRIVATE|PASSWORD/);
});

// ================= Apple の失効（TN3194）・退会の結果・Apple の一時障害 =================

async function appleIn(who = 'A'): Promise<Rig> {
  const r = rig();
  r.apple.who = who;
  await signedIn(r, 'apple');
  return r;
}

test('Apple失効: 照会が revoked / notFound なら自社 session を閉じてゲストへ戻す。端末のデータは残り、サーバーにも閉じる依頼を出す', async () => {
  for (const st of ['revoked', 'notFound'] as const) {
    const r = await appleIn();
    await seedLocal(r.data);
    const before = JSON.stringify([...r.base.map.entries()]);
    r.apple.state = st;
    await r.account.checkProviderState();
    assert.deepEqual(r.account.getState(), { phase: 'signedOut', notice: 'appleRevoked' }, st);
    assert.equal(r.secure.map.size, 0);
    assert.equal(r.server.count('POST /v1/auth/logout'), 1);
    assert.equal(JSON.stringify([...r.base.map.entries()]), before, '端末のデータは消さない');
    assert.equal(r.apple.stateCalls, 1);
  }
});

test('Apple失効: authorized / transferred は何もしない。OS の照会が一時的に失敗（例外）しても失効とは扱わず、session を保つ', async () => {
  for (const st of ['authorized', 'transferred', 'throw'] as const) {
    const r = await appleIn();
    r.apple.state = st;
    await r.account.checkProviderState();
    assert.equal(r.account.getState().phase, 'signedIn', st);
    assert.ok(r.secure.map.has(SESSION_KEY));
    assert.equal(r.server.count('POST /v1/auth/logout'), 0);
  }
  // Google の session では照会しない
  const g = rig();
  await signedIn(g, 'google');
  g.apple.state = 'revoked';
  await g.account.checkProviderState();
  assert.equal(g.apple.stateCalls, 0);
  assert.equal(g.account.getState().phase, 'signedIn');
  // 保存された user が無い Apple session（照会できない）も閉じない
  const noUser = rig();
  await noUser.account.init();
  noUser.apple.signIn = async (nonce: string): Promise<IdpOutcome> => ({ kind: 'success', idToken: `fake.apple.A.${nonce}`, authorizationCode: 'c' });
  assert.equal((await noUser.account.signIn('apple')).ok, true);
  noUser.apple.state = 'revoked';
  await noUser.account.checkProviderState();
  assert.equal(noUser.apple.stateCalls, 0);
  assert.equal(noUser.account.getState().phase, 'signedIn');
});

test('Apple失効: Apple の user は Keychain の session の中だけに保存され、再起動後の起動時の照会でも使われる', async () => {
  const r = await appleIn('A');
  assert.equal(JSON.parse(r.secure.map.get(SESSION_KEY)!).appleUser, 'apple-user-A');
  for (const [k, v] of [...r.base.map, ...r.marker.map]) assert.ok(!v.includes('apple-user-A'), `${k} に user が漏れている`);
  const again = rig({ server: r.server, base: r.base, secure: r.secure, marker: r.marker });
  again.apple.state = 'revoked';
  await again.account.init();
  assert.equal(again.account.getState().phase, 'signedIn');
  const stop = again.account.startMonitoring(); // 起動時の照会
  await again.account.checkProviderState();
  assert.equal(again.account.getState().phase, 'signedOut');
  assert.equal(again.secure.map.size, 0);
  stop();
});

test('Apple失効: 前面復帰と OS の失効通知で照会し、止めた後の通知・復帰は無視する（listener の後始末）', async () => {
  const r = await appleIn();
  const stop = r.account.startMonitoring();
  await r.account.checkProviderState();
  const base = r.apple.stateCalls;
  assert.equal(r.life.cbs.size, 1);
  assert.equal(r.apple.revokeListeners.size, 1);
  r.apple.state = 'authorized';
  r.life.foreground();
  await r.account.checkProviderState();
  assert.ok(r.apple.stateCalls > base);
  r.apple.state = 'revoked';
  r.apple.fireRevoked(); // 通知 → 照会 → 閉じる
  await r.account.checkProviderState();
  assert.equal(r.account.getState().phase, 'signedOut');
  stop();
  assert.equal(r.life.cbs.size, 0);
  assert.equal(r.apple.revokeListeners.size, 0);
  const calls = r.apple.stateCalls;
  r.life.foreground();
  r.apple.fireRevoked();
  assert.equal(r.apple.stateCalls, calls);
  // 2回開始しても、それぞれ別に止められる
  const a = r.account.startMonitoring();
  const b = r.account.startMonitoring();
  a();
  assert.equal(r.life.cbs.size, 1);
  b();
  assert.equal(r.life.cbs.size, 0);
});

test('Apple失効: 照会は同時に1本。連続した通知は終わった後に1回だけやり直す。照会中に別の session になっても、古い結果で新しい session を閉じない', async () => {
  const r = await appleIn('A');
  r.apple.state = 'slow';
  const p1 = r.account.checkProviderState();
  const p2 = r.account.checkProviderState();
  const p3 = r.account.checkProviderState();
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(r.apple.stateCalls, 1, '同時には1本だけ');
  await r.account.logout();
  r.apple.who = 'B';
  assert.equal((await r.account.signIn('apple')).ok, true);
  const newUser = (r.account.getState() as { userId: string }).userId;
  r.apple.gate!(); // 古い照会が「revoked」で戻る
  r.apple.state = 'authorized';
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(r.account.getState(), { phase: 'signedIn', provider: 'apple', userId: newUser }, '古い結果で新しい session を閉じていない');
  assert.ok(r.secure.map.has(SESSION_KEY));
  assert.ok(r.apple.stateCalls <= 3, `やり直しは1回だけ (${r.apple.stateCalls})`);
});

test('退会の結果: Appleの連携が手動の場合の案内文が出る。完全に成功した時は出さない。端末内の後始末が残る時は正直に伝える', async () => {
  assert.ok(!deleteDoneText('revoked', 'done').includes('Appleでサインイン'));
  for (const rev of ['manual_required', 'skipped_manual_required']) {
    const t = deleteDoneText(rev, 'done');
    assert.match(t, /設定/);
    assert.match(t, /サインインとセキュリティ/);
    assert.match(t, /Appleでサインイン/);
  }
  assert.match(deleteDoneText('already_invalid', 'pending'), /次に起動した時にもう一度消します/);
  const r = await appleIn();
  r.server.appleRevoke = 'manual';
  assert.deepEqual(await r.account.deleteAccount(), { ok: true, appleRevocation: 'manual_required', localCleanup: 'done' });
});

test('退会: Appleの一時障害(502)では何も消えず通常の再試行ができる。連携解除を後にする削除は、本人が明示的に選び、再認証つきで送った時だけ。勝手には送らない', async () => {
  const r = await appleIn();
  r.server.appleRevoke = 'transient';
  const uid = (r.account.getState() as { userId: string }).userId;
  const nonces = r.apple.nonces.length;
  assert.deepEqual(await r.account.deleteAccount(), { ok: false, kind: 'revokeFailed' });
  assert.deepEqual(await r.account.deleteAccount(), { ok: false, kind: 'revokeFailed' }, '再試行も同じ扱い');
  assert.equal(r.server.deleteBodies.length, 2);
  assert.ok(r.server.deleteBodies.every((b) => !('forceWithoutAppleRevocation' in b)), '勝手に force を送らない');
  assert.equal(r.server.users.has(uid), true);
  assert.equal(r.account.getState().phase, 'signedIn');
  assert.equal(r.apple.nonces.length, nonces + 2, '試すたびに再認証');
  const forced = await r.account.deleteAccount({ forceWithoutAppleRevocation: true });
  assert.deepEqual(forced, { ok: true, appleRevocation: 'skipped_manual_required', localCleanup: 'done' });
  assert.equal(r.server.deleteBodies[2]!.forceWithoutAppleRevocation, true);
  assert.equal(r.apple.nonces.length, nonces + 3, 'force も再認証つき');
  assert.equal(r.server.users.has(uid), false);
  const panel = read('../src/account/AccountPanel.tsx');
  assert.match(panel, /連携の解除を後にして削除する/);
  assert.match(panel, /if \(r\.kind === 'revokeFailed'\) setForceOffer\(true\)/);
  assert.equal([...panel.matchAll(/del\(true\)/g)].length, 1);
});

test('Apple一時障害: 更新(refresh)が 503 provider_unavailable なら session を保ち（サーバーは更新tokenを消費しない）、再試行できる。通信喪失・不明な5xxは従来どおり再ログイン', async () => {
  const r = rig();
  await seedLocal(r.data);
  await signedIn(r, 'apple');
  r.server.clock += 14.9 * 60_000;
  r.server.refreshUnavailable = true;
  const rt = JSON.parse(r.secure.map.get(SESSION_KEY)!).tokens.refreshToken as string;
  assert.deepEqual(await r.account.upload(), { ok: false, kind: 'providerUnavailable' });
  assert.equal(r.account.getState().phase, 'signedIn', 'ログインは保たれる');
  assert.equal(JSON.parse(r.secure.map.get(SESSION_KEY)!).tokens.refreshToken, rt, '同じ更新 token を持ち続ける');
  assert.equal(r.server.count('POST /v1/auth/refresh'), 1, '自動の再送はしない');
  r.server.refreshUnavailable = false;
  assert.equal((await r.account.upload()).ok, true, '回復後はそのまま続けられる');
  assert.equal(r.server.revoked.size, 0);
  for (const f of [{ mode: 'status' as const, status: 503, code: 'provider_not_configured' }, { mode: 'status' as const, status: 500 }, { mode: 'network' as const }]) {
    const x = rig();
    await seedLocal(x.data);
    await signedIn(x, 'apple');
    x.server.clock += 14.9 * 60_000;
    x.server.failures.push({ match: (_m, p) => p === '/v1/auth/refresh', ...f });
    assert.deepEqual(await x.account.upload(), { ok: false, kind: 'sessionLost' }, JSON.stringify(f));
    assert.equal(x.account.getState().phase, 'signedOut');
  }
});

test('読込の固定(比較入口だけ): URL の pin を読み書きし、他の指定を残す。製品の経路には無い', () => {
  assert.equal(parsePin('?iosDesign=1&pin=home'), 'home');
  assert.equal(parsePin('?pin=question'), 'question');
  assert.equal(parsePin('?pin=nope'), null);
  assert.equal(parsePin(''), null);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(withPin('?iosDesign=1&v=3', 'shop'))), { iosDesign: '1', v: '3', pin: 'shop' });
  assert.equal(withPin('?pin=shop', null), '');
  assert.equal(withPin('?iosDesign=1&pin=shop', null), '?iosDesign=1');
  for (const kind of SKELETON_KINDS) assert.equal(parsePin(withPin('', kind)), kind);
  assert.doesNotMatch(read('../src/App.tsx'), /\bpin\b/);
  for (const f of ['../src/Root.tsx', '../src/ui/Home.tsx', '../src/ui/LearnTab.tsx', '../src/ui/Tabs.tsx', '../src/ui/Study.tsx', '../src/ui/Complete.tsx']) assert.doesNotMatch(read(f), /\bpin\b/, f);
  assert.match(read('../src/ios/Runner.tsx'), /pin === 'question' \|\| pin === 'result'/);
  assert.match(read('../src/ios/Screens.tsx'), /bootVisible \|\| ctx\.pin === kind/);
  for (const t of ['箱庭', '学ぶ', '手帳', 'お店', '問題', '結果']) assert.match(read('../src/ios/CompareChrome.tsx'), new RegExp(`text: '${t}'`));
});

test('画面の方針(I4修理): 取り消しの可否はサービスの問い合わせで決め、通知はサービスが持つ。アカウント処理中は画面操作を受けない。起動時に見える空間を確定してから描く。Web に native module を混ぜない', () => {
  const panel = read('../src/account/AccountPanel.tsx');
  assert.doesNotMatch(panel, /canUndo/);
  assert.match(panel, /service\.undoKind\(\)/);
  assert.match(panel, /s\.getNotice\(\)/);
  const app = read('../src/ios/IosDesignApp.tsx');
  assert.match(app, /gen\.subscribe\(\(\) => setEpoch/);
  assert.match(app, /account\.init\(\)\.finally/);
  assert.match(app, /cfg && accountReady/);
  assert.match(app, /account\.startMonitoring\(\)/);
  assert.match(read('../src/ios/Runner.tsx'), /accessibilityLabel="アカウントの処理中"/);
  assert.match(read('../src/ios/ProductApp.tsx'), /account\.startMonitoring\(\)/); // 製品も同じ監視
  const native = read('../src/account/native.ts');
  assert.match(native, /AppleAuthentication\.getCredentialStateAsync/);
  assert.match(native, /AppleAuthentication\.addRevokeListener\(cb\)/);
  assert.match(native, /AppState\.addEventListener\('change'/);
  const web = read('../src/account/native.web.ts').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(web, /expo-apple-authentication|AppState|expo-constants/);
});
