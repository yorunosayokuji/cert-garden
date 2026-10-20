// セッションの保存。token は Keychain（SecureStore）だけ。AsyncStorage / localStorage には置かない。
// iOS の Keychain はアプリを消しても残ることがあるので、「この install のもの」と分かる目印（AsyncStorage 側。アプリを消すと一緒に消える）と照合する。
import type { KeyValue } from '../state/kv.ts';
import type { Provider, SessionTokens } from './api.ts';

/** Keychain への薄い境界。試験ではメモリ版を使う */
export interface SecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemorySecureKv implements SecureKv {
  readonly map = new Map<string, string>();
  failNextWrites = 0;
  /** true の間、削除が失敗する（Keychain の削除失敗の再現用） */
  failRemoves = false;
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error('secure write failed');
    }
    this.map.set(key, value);
  }
  async remove(key: string) {
    if (this.failRemoves) throw new Error('secure remove failed');
    this.map.delete(key);
  }
}

export const SESSION_KEY = 'certgarden.session.v1';
/** 本体の保存('certgarden:')とも比較の名前空間とも別。アプリを消すと消える AsyncStorage に置く */
export const INSTALL_MARKER_KEY = 'certgarden-account:install:v1';
/** 閉じた session の id。Keychain の削除に失敗しても、再起動後にその session を使わせない（fail closed） */
export const REVOKED_SID_KEY = 'certgarden-account:revoked-sid:v1';

export interface SessionRecord {
  userId: string;
  provider: Provider;
  /** この install の目印。違えば前の install の残りなので使わない */
  installId: string;
  /** この session の id（乱数）。閉じた印と照合する */
  sid: string;
  /** 接続先の組（API の origin・Google クライアントID・bundle ID。公開してよい識別子だけ）。違えば旧 Bearer を新しい接続先へ送らない */
  scope: string;
  /** Apple の資格情報の user（Keychain の中だけ）。失効の照会に使う */
  appleUser?: string;
  tokens: SessionTokens;
}

export type LoadedSession =
  | { kind: 'none'; reason: 'empty' | 'newInstall' | 'otherInstall' | 'otherScope' | 'revoked' | 'unreadable' }
  | { kind: 'expired' }
  | { kind: 'ok'; session: SessionRecord };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parse(text: string): SessionRecord | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const t = v.tokens as Record<string, unknown> | undefined;
    if (!isStr(v.userId) || (v.provider !== 'google' && v.provider !== 'apple') || !isStr(v.installId) || !isStr(v.sid) || !isStr(v.scope) || !t) return null;
    if (v.appleUser !== undefined && !isStr(v.appleUser)) return null;
    if (!isStr(t.accessToken) || !isStr(t.refreshToken) || !isNum(t.accessExpiresAt) || !isNum(t.refreshExpiresAt)) return null;
    return { userId: v.userId, provider: v.provider, installId: v.installId, sid: v.sid, scope: v.scope, ...(v.appleUser ? { appleUser: v.appleUser } : null), tokens: { accessToken: t.accessToken, accessExpiresAt: t.accessExpiresAt, refreshToken: t.refreshToken, refreshExpiresAt: t.refreshExpiresAt } };
  } catch {
    return null;
  }
}

export class SessionStore {
  private readonly secure: SecureKv;
  private readonly marker: KeyValue;
  private readonly newId: () => string;
  private installId: string | null = null;
  private readonly scope: string;
  constructor(secure: SecureKv, marker: KeyValue, newId: () => string, scope: string) {
    this.secure = secure;
    this.marker = marker;
    this.newId = newId;
    this.scope = scope;
  }

  currentScope(): string {
    return this.scope;
  }

  /**
   * 起動時に1回。目印が無い＝新しい install なので、Keychain に残っていた前の install の session は捨てる（端末のデータは触らない）。
   * 期限切れの更新 token は使えないので捨てて 'expired'。読めない保存も捨てて続行（ゲストとして使える）。
   */
  async load(now: number): Promise<LoadedSession> {
    let id = await this.marker.getItem(INSTALL_MARKER_KEY);
    if (!id) {
      id = this.newId();
      await this.secure.remove(SESSION_KEY).catch(() => undefined);
      await this.marker.setItem(INSTALL_MARKER_KEY, id);
      this.installId = id;
      return { kind: 'none', reason: 'newInstall' };
    }
    this.installId = id;
    let text: string | null;
    try {
      text = await this.secure.get(SESSION_KEY);
    } catch {
      return { kind: 'none', reason: 'unreadable' };
    }
    if (text === null) return { kind: 'none', reason: 'empty' };
    const rec = parse(text);
    if (!rec) {
      await this.secure.remove(SESSION_KEY).catch(() => undefined);
      return { kind: 'none', reason: 'unreadable' };
    }
    if (rec.installId !== id) {
      await this.secure.remove(SESSION_KEY).catch(() => undefined);
      return { kind: 'none', reason: 'otherInstall' };
    }
    // 閉じた印が読めない/壊れている時は「未失効」と決めつけない（Keychain の削除に失敗して印だけ残っている場合に、元の session を使ってしまうため）。
    // 印が無い(null)のは正常な初回。読めない・空の文字列は安全側（使わない・通信しない）。session は消さずに残し、読めるようになれば次の起動で判定する
    let revoked: string | null;
    try {
      revoked = await this.marker.getItem(REVOKED_SID_KEY);
    } catch {
      return { kind: 'none', reason: 'unreadable' };
    }
    if (revoked !== null && (typeof revoked !== 'string' || revoked === '')) return { kind: 'none', reason: 'unreadable' };
    if (revoked !== null && revoked === rec.sid) {
      await this.secure.remove(SESSION_KEY).catch(() => undefined); // 消せるなら今度こそ消す。消せなくてもこの session は使わない
      return { kind: 'none', reason: 'revoked' };
    }
    if (rec.scope !== this.scope) {
      await this.secure.remove(SESSION_KEY).catch(() => undefined);
      return { kind: 'none', reason: 'otherScope' };
    }
    if (rec.tokens.refreshExpiresAt <= now) {
      await this.secure.remove(SESSION_KEY).catch(() => undefined);
      return { kind: 'expired' };
    }
    return { kind: 'ok', session: rec };
  }

  currentInstallId(): string {
    if (!this.installId) throw new Error('SessionStore.load() の前に保存できません');
    return this.installId;
  }

  async save(rec: SessionRecord): Promise<void> {
    await this.secure.set(SESSION_KEY, JSON.stringify(rec));
  }

  /**
   * 閉じる。閉じた印（AsyncStorage）と Keychain の削除の両方を試し、どちらかが成功すれば再起動後も使われない。
   * 両方失敗したら例外（呼び出し側は「閉じた」と偽らない）。
   */
  async clear(sid: string | null): Promise<void> {
    let marked = false;
    if (sid) {
      try {
        await this.marker.setItem(REVOKED_SID_KEY, sid);
        marked = true;
      } catch {
        marked = false;
      }
    }
    try {
      await this.secure.remove(SESSION_KEY);
    } catch (e) {
      if (!marked) throw e;
    }
  }
}
