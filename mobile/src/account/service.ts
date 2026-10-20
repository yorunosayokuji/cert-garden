// アカウントの中核。ログイン・セッション更新・クラウド保存/復元・ログアウト・退会を、ポート(注入)越しに組む。
// UI にも Expo にも依存しないので、試験は偽のポート（署名付きの実 token ではない）で状態遷移を検査する。
import type { KeyValue } from '../state/kv.ts';
import { ApiError, type ApiClient, type Provider, type SessionTokens } from './api.ts';
import { BackupError, GUEST, collectBundle, contentHash, validateBundle, type GenerationKv } from './backup.ts';
import type { SessionRecord, SessionStore } from './session.ts';

// ---- ポート ----
export type IdpOutcome =
  | { kind: 'success'; idToken: string; authorizationCode?: string; /** Apple の資格情報の user（失効の照会用） */ appleUser?: string }
  | { kind: 'cancelled' } // 本人が閉じた/取り消した（普通の結果）
  | { kind: 'denied' } // 認可の拒否・失敗応答
  | { kind: 'timeout' }
  | { kind: 'unavailable' } // 端末がその方法に対応していない
  | { kind: 'error' };

export type CredentialState = 'authorized' | 'revoked' | 'notFound' | 'transferred';

export interface IdpPort {
  isAvailable(): Promise<boolean>;
  /** サーバーが発行した nonce をそのまま使い、署名付きの ID token を得る */
  signIn(nonce: string): Promise<IdpOutcome>;
  /** Apple: OS に資格情報の状態を照会する。一時的に答えられない時は例外（失効とは扱わない） */
  credentialState?(user: string): Promise<CredentialState>;
  /** Apple: OS の失効通知。解除する関数を返す */
  onRevoked?(cb: () => void): () => void;
}

export type FailKind =
  | 'invalidState' | 'busy' | 'cancelled' | 'denied' | 'timeout' | 'unavailable' | 'notConfigured' | 'offline' | 'rejected'
  | 'rateLimited' | 'server' | 'storage' | 'sessionLost' | 'revokeFailed' | 'providerUnavailable' | 'unknown';

export type Fail = { ok: false; kind: FailKind };

export type AccountState =
  | { phase: 'loading' }
  | { phase: 'unsupported'; reason: 'web' | 'platform' | 'expoGo' }
  | { phase: 'unconfigured'; reasons: string[] }
  | { phase: 'signedOut'; notice: null | 'sessionExpired' | 'deleted' | 'appleRevoked' }
  | { phase: 'signedIn'; provider: Provider; userId: string };

export interface ServiceDeps {
  api: ApiClient;
  sessions: SessionStore;
  /** 端末のデータ。世代・所有者つき（復元の原子的な切り替えとアカウントごとの分離） */
  data: GenerationKv;
  /** 結び付け・未完了送信の記録（データキー以外は世代を通らず、そのまま保存される） */
  meta: KeyValue;
  idp: Record<Provider, IdpPort>;
  now: () => number;
  newRequestId: () => string;
  newId: () => string;
  /** アプリが前面に戻った時の通知 */
  lifecycle?: { onActive(cb: () => void): () => void };
  /** 外部ログインの待ち時間の上限（サーバーのチャレンジは5分で失効） */
  idpTimeoutMs?: number;
  /** 起動時の状態: 未対応/未設定の判定は呼び出し側で済ませて渡す */
  initial: Extract<AccountState, { phase: 'unsupported' | 'unconfigured' }> | null;
}

const BINDING_KEY = 'account-binding:v1';
const PENDING_KEY = 'account-pending:v1';
const REFRESH_MARGIN_MS = 60_000;

const bindingKey = (space: string) => `${BINDING_KEY}:${space}`;
const pendingKey = (space: string) => `${PENDING_KEY}:${space}`;

interface Binding {
  userId: string;
  revision: number;
  hash: string;
}
interface Pending {
  requestId: string;
  base: number;
  hash: string;
  userId: string;
}

export type UploadResult =
  | { ok: true; revision: number; replayed: boolean }
  | { ok: false; kind: 'needsChoice'; reason: 'cloudHasData' | 'otherAccount'; serverRevision: number }
  | { ok: false; kind: 'conflict'; serverRevision: number }
  | { ok: false; kind: 'nothing' | 'invalidLocal' | 'tooLarge'; keys: string[] }
  | Fail;

export type RestoreResult =
  | { ok: true; gen: number; revision: number }
  | { ok: false; kind: 'noCloudData' }
  | { ok: false; kind: 'invalidCloud' | 'incompleteCloud'; keys: string[] }
  | { ok: false; kind: 'writeFailed' }
  | Fail;

export type DeleteResult = { ok: true; appleRevocation: string; localCleanup: 'done' | 'pending' } | Fail;

export interface LocalStatus {
  /** 端末のデータが最後に同期した内容と違う（true）/同じ（false）/判定できない・未同期（null） */
  dirty: boolean | null;
  boundUserId: string | null;
  revision: number | null;
}

type Listener = () => void;

export class AccountService {
  private readonly d: ServiceDeps;
  private state: AccountState;
  private session: SessionRecord | null = null;
  private refreshing: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private recheck = false;
  private busy = false;
  private notice: string | null = null;
  private readonly listeners = new Set<Listener>();
  private initialized: Promise<void> | null = null;

  constructor(deps: ServiceDeps) {
    this.d = deps;
    this.state = deps.initial ?? { phase: 'loading' };
  }

  getState(): AccountState {
    return this.state;
  }
  isBusy(): boolean {
    return this.busy;
  }
  /** 画面を作り直しても残る短い通知（復元・ログインなどの結果） */
  getNotice(): string | null {
    return this.notice;
  }
  setNotice(s: string | null) {
    this.notice = s;
    this.emit();
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private set(s: AccountState) {
    this.state = s;
    this.emit();
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /** 操作を1本ずつ実行する（ログイン・保存・復元・退会が重ならない）。実行中の別操作は 'busy' で断る */
  private async run<T extends { ok: boolean }>(fn: () => Promise<T>): Promise<T | Fail> {
    if (this.busy) return { ok: false, kind: 'busy' };
    this.busy = true;
    this.emit();
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  /** 起動時に1回（何度呼んでも同じ結果）。前回の消し損ねの片付けと、見える空間の確定（セッションが無ければゲスト）まで行う */
  init(): Promise<void> {
    if (!this.initialized) this.initialized = this.doInit();
    return this.initialized;
  }
  private async doInit(): Promise<void> {
    await this.d.data.recover().catch(() => false);
    if (this.d.initial) {
      await this.d.data.activate(null).catch(() => undefined);
      return;
    }
    try {
      const r = await this.d.sessions.load(this.d.now());
      if (r.kind === 'ok') {
        this.session = r.session;
        await this.d.data.activate(r.session.userId).catch(() => undefined);
        this.set({ phase: 'signedIn', provider: r.session.provider, userId: r.session.userId });
      } else {
        await this.d.data.activate(null).catch(() => undefined);
        this.set({ phase: 'signedOut', notice: r.kind === 'expired' ? 'sessionExpired' : null });
      }
    } catch {
      await this.d.data.activate(null).catch(() => undefined);
      this.set({ phase: 'signedOut', notice: null });
    }
  }

  // ---- ログイン ----

  private failFromApi(e: unknown): Fail {
    if (e instanceof ApiError) {
      if (e.kind === 'network' || e.kind === 'timeout') return { ok: false, kind: 'offline' };
      if (e.kind === 'http') {
        if (e.status === 503 && e.code === 'provider_unavailable') return { ok: false, kind: 'providerUnavailable' };
        if (e.status === 503 && e.code === 'provider_not_configured') return { ok: false, kind: 'notConfigured' };
        if (e.status === 429) return { ok: false, kind: 'rateLimited' };
        if (e.status === 502 && e.code === 'apple_revoke_failed') return { ok: false, kind: 'revokeFailed' };
        if (e.status === 401 || e.status === 400) return { ok: false, kind: 'rejected' };
        if (e.status >= 500) return { ok: false, kind: 'server' };
      }
      return { ok: false, kind: 'unknown' };
    }
    return { ok: false, kind: 'unknown' };
  }

  private async idp(provider: Provider, nonce: string): Promise<{ ok: true; idToken: string; code?: string; appleUser?: string } | Fail> {
    const port = this.d.idp[provider];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<IdpOutcome>((res) => {
      timer = setTimeout(() => res({ kind: 'timeout' }), this.d.idpTimeoutMs ?? 270_000);
    });
    let out: IdpOutcome;
    try {
      out = await Promise.race([port.signIn(nonce), timeout]);
    } catch {
      out = { kind: 'error' };
    } finally {
      clearTimeout(timer);
    }
    if (out.kind === 'success') return { ok: true, idToken: out.idToken, ...(out.authorizationCode ? { code: out.authorizationCode } : null), ...(out.appleUser ? { appleUser: out.appleUser } : null) };
    if (out.kind === 'cancelled' || out.kind === 'denied' || out.kind === 'timeout' || out.kind === 'unavailable') return { ok: false, kind: out.kind };
    return { ok: false, kind: 'unknown' };
  }

  async signIn(provider: Provider): Promise<{ ok: true } | Fail> {
    if (this.state.phase !== 'signedOut') return { ok: false, kind: 'invalidState' };
    return this.run(async () => {
      try {
        const ch = await this.d.api.challenge(provider, 'login');
        const r = await this.idp(provider, ch.nonce);
        if (!r.ok) return r;
        if (provider === 'apple' && !r.code) return { ok: false as const, kind: 'unknown' as const };
        const ex = await this.d.api.exchange(provider, ch.challengeId, r.idToken, r.code);
        const rec: SessionRecord = {
          userId: ex.userId, provider, installId: this.d.sessions.currentInstallId(), sid: this.d.newId(), scope: this.d.sessions.currentScope(),
          ...(provider === 'apple' && r.appleUser ? { appleUser: r.appleUser } : null), tokens: ex.session,
        };
        try {
          await this.d.sessions.save(rec);
        } catch {
          // 保存できないセッションは使わない（次回起動で消えるため）。サーバー側も閉じる
          await this.d.api.logout(rec.tokens.accessToken).catch(() => undefined);
          return { ok: false as const, kind: 'storage' as const };
        }
        this.session = rec;
        this.set({ phase: 'signedIn', provider, userId: rec.userId });
        // そのアカウントの端末内コピーがあれば、その空間を表示する（無ければゲストのまま）
        await this.d.data.activate(rec.userId).catch(() => undefined);
        return { ok: true as const };
      } catch (e) {
        return this.failFromApi(e);
      }
    });
  }

  // ---- セッション更新（直列・1本化） ----

  /**
   * 自分の session を閉じる。端末の記録を消せなくても、メモリ上は閉じる（見えるデータはゲストへ）。
   * 戻り値 false = Keychain の削除も「閉じた印」も書けなかった（再起動で戻りうる。成功と偽らない）
   */
  private async dropSession(notice: 'sessionExpired' | 'deleted' | 'appleRevoked' | null): Promise<boolean> {
    const sid = this.session?.sid ?? null;
    this.session = null;
    let persisted = true;
    try {
      await this.d.sessions.clear(sid);
    } catch {
      persisted = false;
    }
    this.set({ phase: 'signedOut', notice });
    await this.d.data.activate(null).catch(() => undefined);
    return persisted;
  }

  /** 更新は同時に1本だけ。同じ更新 token を並行/再送で出さない（サーバーは再提示を盗用とみなして全失効するため） */
  private refreshSingle(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const old = this.session;
    if (!old) return Promise.reject(new SessionLost());
    const p = (async () => {
      try {
        const tokens: SessionTokens = await this.d.api.refresh(old.tokens.refreshToken);
        const rec: SessionRecord = { ...old, tokens };
        this.session = rec; // 保存に失敗しても、新しい token はメモリで使う（古い token は使用済み）
        await this.d.sessions.save(rec).catch(() => undefined);
      } catch (e) {
        // サーバーが「更新 token を消費していない」と保証する応答だけ session を残して再試行できる:
        //  429（受付前に断られた）と 503 provider_unavailable（Apple の一時障害）。
        // 通信失敗・401・不明な 5xx は更新 token がどうなったか分からない（再送すると盗用扱いで全失効）ので、安全に再ログインへ
        if (e instanceof ApiError && e.kind === 'http' && (e.status === 429 || (e.status === 503 && e.code === 'provider_unavailable'))) throw e;
        await this.dropSession('sessionExpired');
        throw new SessionLost();
      }
    })().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = p;
    return p;
  }

  /** 認証つき呼び出し。期限が近ければ先に更新、401 なら1回だけ更新して再実行。失敗が確定すればログアウト状態へ */
  async withSession<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    if (!this.session) throw new SessionLost();
    if (this.session.tokens.accessExpiresAt - this.d.now() < REFRESH_MARGIN_MS) await this.refreshSingle();
    const used = this.session!.tokens.accessToken;
    try {
      return await fn(used);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'http' && e.status === 401) {
        if (this.session && this.session.tokens.accessToken === used) await this.refreshSingle(); // 他が更新済みなら再実行だけ
        if (!this.session) throw new SessionLost();
        try {
          return await fn(this.session.tokens.accessToken);
        } catch (e2) {
          if (e2 instanceof ApiError && e2.kind === 'http' && e2.status === 401) {
            await this.dropSession('sessionExpired');
            throw new SessionLost();
          }
          throw e2;
        }
      }
      throw e;
    }
  }

  private failFrom(e: unknown): Fail {
    if (e instanceof SessionLost) return { ok: false, kind: 'sessionLost' };
    return this.failFromApi(e);
  }

  // ---- Apple の資格情報の失効（TN3194: 起動/復帰時の照会と失効通知） ----

  /** 前面に戻った時・失効通知を受けた時に呼ぶ。同時に1本だけ実行し、実行中に来た依頼は終わった後に1回やり直す */
  checkProviderState(): Promise<void> {
    if (this.checking) {
      this.recheck = true;
      return this.checking;
    }
    const p = (async () => {
      do {
        this.recheck = false;
        await this.checkOnce();
      } while (this.recheck);
    })().finally(() => {
      this.checking = null;
    });
    this.checking = p;
    return p;
  }

  private async checkOnce(): Promise<void> {
    const s = this.session;
    if (!s || s.provider !== 'apple' || !s.appleUser) return;
    const port = this.d.idp.apple;
    if (!port.credentialState) return;
    let st: CredentialState;
    try {
      st = await port.credentialState(s.appleUser);
    } catch {
      return; // OS が一時的に答えられない（シミュレーターは常にここ）。失効とは扱わない
    }
    // 照会の間に別の session になっていたら、古い結果で今の session を閉じない
    if (!this.session || this.session.sid !== s.sid) return;
    if (st === 'revoked' || st === 'notFound') {
      await this.d.api.logout(this.session.tokens.accessToken).catch(() => undefined);
      if (!this.session || this.session.sid !== s.sid) return;
      await this.dropSession('appleRevoked');
    }
  }

  /** 前面復帰と失効通知の監視を始める。返す関数で止める（止めた後に届いた通知は無視） */
  startMonitoring(): () => void {
    let live = true;
    const fire = () => {
      if (live) void this.checkProviderState();
    };
    const offs = [this.d.lifecycle?.onActive(fire), this.d.idp.apple.onRevoked?.(fire)];
    fire();
    return () => {
      live = false;
      for (const off of offs) off?.();
    };
  }

  // ---- 端末の状態 ----

  private async readBinding(space: string): Promise<Binding | null> {
    try {
      const t = await this.d.meta.getItem(bindingKey(space));
      if (!t) return null;
      const v = JSON.parse(t) as Partial<Binding>;
      if (typeof v.userId !== 'string' || !Number.isSafeInteger(v.revision) || typeof v.hash !== 'string') return null;
      return { userId: v.userId, revision: v.revision as number, hash: v.hash };
    } catch {
      return null;
    }
  }

  async localStatus(): Promise<LocalStatus> {
    const b = await this.readBinding(await this.d.data.activeSpace());
    let dirty: boolean | null = null;
    try {
      const bundle = await collectBundle(this.d.data);
      dirty = b ? contentHash(bundle) !== b.hash : null;
    } catch {
      dirty = null;
    }
    return { dirty, boundUserId: b?.userId ?? null, revision: b?.revision ?? null };
  }

  // ---- クラウドへ保存（本人の操作だけ） ----

  /**
   * 現在の端末データをクラウドへ送る。別端末の保存を自動で上書きしない:
   *  - クラウドに保存があり、この端末が結び付いていない → needsChoice(cloudHasData)
   *  - この端末のデータが別のアカウントと結び付いている → needsChoice(otherAccount)
   *  - 競合(409) → conflict（自動で解決しない）
   * overwrite: true は本人が確認した後だけ渡す。
   */
  async upload(opts: { overwrite?: boolean } = {}): Promise<UploadResult> {
    return this.run<UploadResult>(async () => {
      const session = this.session;
      if (!session) return { ok: false, kind: 'invalidState' };
      let bundle;
      try {
        bundle = await collectBundle(this.d.data);
      } catch (e) {
        if (e instanceof BackupError) {
          if (e.kind === 'empty') return { ok: false, kind: 'nothing', keys: [] };
          if (e.kind === 'tooLarge') return { ok: false, kind: 'tooLarge', keys: e.keys };
          return { ok: false, kind: 'invalidLocal', keys: e.keys };
        }
        return { ok: false, kind: 'unknown' };
      }
      const hash = contentHash(bundle);
      try {
        const space = await this.d.data.activeSpace();
        const binding = await this.readBinding(space);
        // 応答を失った送信の再試行: 同じ内容・同じ基準なら、同じ requestId で送り直す（サーバー側で二重適用にならない）
        let pending: Pending | null = null;
        try {
          const t = await this.d.meta.getItem(pendingKey(space));
          pending = t ? (JSON.parse(t) as Pending) : null;
        } catch {
          pending = null;
        }
        const retrying = pending !== null && pending.userId === session.userId && pending.hash === hash && Number.isSafeInteger(pending.base);
        let base: number;
        if (retrying) {
          base = pending!.base;
        } else if (binding && binding.userId === session.userId && !opts.overwrite) {
          base = binding.revision;
        } else {
          const cur = await this.withSession((a) => this.d.api.getBackup(a));
          if (binding && binding.userId !== session.userId && !opts.overwrite) return { ok: false, kind: 'needsChoice', reason: 'otherAccount', serverRevision: cur.revision };
          if (cur.revision > 0 && !opts.overwrite) return { ok: false, kind: 'needsChoice', reason: 'cloudHasData', serverRevision: cur.revision };
          base = cur.revision;
        }
        const requestId = retrying ? pending!.requestId : this.d.newRequestId();
        await this.d.meta.setItem(pendingKey(space), JSON.stringify({ requestId, base, hash, userId: session.userId } satisfies Pending)).catch(() => undefined);
        const r = await this.withSession((a) => this.d.api.putBackup(a, base, requestId, bundle));
        await this.d.meta.removeItem(pendingKey(space)).catch(() => undefined);
        const b: Binding = { userId: session.userId, revision: r.revision, hash };
        await this.d.meta.setItem(bindingKey(space), JSON.stringify(b)).catch(() => undefined);
        return { ok: true, revision: r.revision, replayed: r.replayed };
      } catch (e) {
        if (e instanceof ApiError && e.kind === 'http' && e.status === 409) return { ok: false, kind: 'conflict', serverRevision: e.serverRevision ?? 0 };
        return this.failFrom(e);
      }
    });
  }

  // ---- クラウドから復元（本人の操作・確認済みのときだけ） ----

  /**
   * クラウドの保存を、このアカウントの端末内コピーとして取り込む。confirmed: true（置き換えの確認）が無ければ何もしない。
   * 全9項目を検査し、このアカウント専用の新しい世代へ書き切って読み戻し、最後にポインターを1回で切り替える。
   * ゲストの元のデータは一切変えない（ログアウトすれば元のまま見える）。
   */
  async restore(opts: { confirmed: boolean }): Promise<RestoreResult> {
    if (!opts.confirmed) return { ok: false, kind: 'invalidState' };
    return this.run<RestoreResult>(async () => {
      const session = this.session;
      if (!session) return { ok: false, kind: 'invalidState' };
      try {
        const cur = await this.withSession((a) => this.d.api.getBackup(a));
        if (!cur.backup) return { ok: false, kind: 'noCloudData' };
        let entries;
        try {
          entries = await validateBundle(cur.backup);
        } catch (e) {
          if (e instanceof BackupError) return { ok: false, kind: e.kind === 'incomplete' ? 'incompleteCloud' : 'invalidCloud', keys: e.keys };
          return { ok: false, kind: 'invalidCloud', keys: [] };
        }
        // 取得の間にログアウト/別アカウントになっていたら取り込まない
        if (!this.session || this.session.sid !== session.sid) return { ok: false, kind: 'sessionLost' };
        let gen: number;
        try {
          ({ gen } = await this.d.data.commit(entries, session.userId));
        } catch {
          return { ok: false, kind: 'writeFailed' };
        }
        const bundle = await collectBundle(this.d.data).catch(() => null);
        const b: Binding = { userId: session.userId, revision: cur.revision, hash: bundle ? contentHash(bundle) : '' };
        await this.d.meta.setItem(bindingKey(session.userId), JSON.stringify(b)).catch(() => undefined);
        await this.d.meta.removeItem(pendingKey(session.userId)).catch(() => undefined);
        return { ok: true, gen, revision: cur.revision };
      } catch (e) {
        return this.failFrom(e);
      }
    });
  }

  /** 復元を取り消せるか。端末の世代の記録から問い合わせる（画面を作り直しても・再起動しても分かる）。別のアカウントの世代へは戻らない */
  async undoKind(): Promise<'none' | 'previous' | 'toGuest'> {
    const s = this.session;
    if (!s) return 'none';
    try {
      return await this.d.data.undoKind(s.userId);
    } catch {
      return 'none';
    }
  }

  /** 復元を取り消す: 直前の世代へ、初めての復元ならゲストのデータへ */
  async undoRestore(): Promise<{ ok: boolean }> {
    const s = this.session;
    if (!s) return { ok: false };
    try {
      const kind = await this.d.data.undoKind(s.userId);
      const done = await this.d.data.rollback(s.userId);
      if (done && kind === 'toGuest') {
        await this.d.meta.removeItem(bindingKey(s.userId)).catch(() => undefined);
        await this.d.meta.removeItem(pendingKey(s.userId)).catch(() => undefined);
      }
      return { ok: done };
    } catch {
      return { ok: false };
    }
  }

  // ---- ログアウト / 退会 ----

  /**
   * ログアウト。サーバーへ通知できなくても端末のセッションは閉じる。端末のデータは消さない。
   * Keychain の削除も「閉じた印」も書けなかった時は ok:false(storage)（再起動で戻りうるので、閉じたと偽らない）
   */
  async logout(): Promise<{ ok: true } | Fail> {
    return this.run(async () => {
      const s = this.session;
      if (s) {
        try {
          await this.d.api.logout(s.tokens.accessToken);
        } catch {
          // 通知できなくても端末側は閉じる（サーバーのセッションは期限で失効する）
        }
      }
      const persisted = await this.dropSession(null);
      return persisted ? { ok: true as const } : { ok: false as const, kind: 'storage' as const };
    });
  }

  /**
   * アプリ内の退会。本人が再ログイン(reauth)して最終確認した後だけサーバーへ送る。
   * 成功時: 自分の session・結び付け・このアカウント由来の端末内コピー（世代と元に戻す用の残り）を消す。ゲストのデータは残す。
   * Apple の連携解除に一時失敗した時はサーバーが何も消さず 502 を返すので、再試行できる(revokeFailed)。
   * forceWithoutAppleRevocation は本人が明示的に選んだ時だけ true（Apple 側の連携解除は設定アプリで手動）。
   */
  async deleteAccount(opts: { forceWithoutAppleRevocation?: boolean } = {}): Promise<DeleteResult> {
    return this.run<DeleteResult>(async () => {
      const s = this.session;
      if (!s) return { ok: false as const, kind: 'invalidState' as const };
      try {
        const ch = await this.withSession((a) => this.d.api.challenge(s.provider, 'reauth', a));
        const r = await this.idp(s.provider, ch.nonce);
        if (!r.ok) return r;
        const res = await this.withSession((a) => this.d.api.deleteAccount(a, s.provider, ch.challengeId, r.idToken, opts.forceWithoutAppleRevocation === true));
        // サーバー側は削除済み。ここから先は端末側の後始末で、失敗しても削除を取り消せない。先に端末内コピーを見えなくする
        let cleaned = true;
        try {
          ({ cleaned } = await this.d.data.purgeOwner(s.userId));
        } catch {
          cleaned = false;
        }
        for (const space of [s.userId, GUEST]) {
          if (space === GUEST) {
            const b = await this.readBinding(GUEST);
            if (b?.userId !== s.userId) continue; // ゲストの結び付けが他の人のものなら触らない
          }
          await this.d.meta.removeItem(bindingKey(space)).catch(() => (cleaned = false));
          await this.d.meta.removeItem(pendingKey(space)).catch(() => (cleaned = false));
        }
        const persisted = await this.dropSession('deleted');
        return { ok: true as const, appleRevocation: res.appleRevocation, localCleanup: cleaned && persisted ? ('done' as const) : ('pending' as const) };
      } catch (e) {
        return this.failFrom(e);
      }
    });
  }
}

class SessionLost extends Error {
  constructor() {
    super('sessionLost');
    this.name = 'SessionLost';
  }
}
