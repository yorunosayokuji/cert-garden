// クラウド保存の端末側: 集める(collect)・検査する(validate)・世代で安全に復元する(GenerationKv)。
// サーバーの契約(server/src/backup.ts)の9キー。購入・権利・比較設定('compare:v1')は含めない。
import { QUALIFICATIONS, emptyDiagState, emptyHoldState, isValidDiagState, isValidHoldState, parseState } from '../../../src/mobile.ts';
import { CORE_KEY } from '../state/kvStorage.ts';
import { DIAG_KEY } from '../state/diagnosticStore.ts';
import { FURNITURE_KEY, isValidLayout, starterLayout } from '../state/furniture.ts';
import { HOLDS_KEY } from '../state/holdStore.ts';
import { MemoryKv, type KeyValue } from '../state/kv.ts';
import { LEARN_PREFS_KEY } from '../state/learnPrefs.ts';
import { DEFAULT_SETTINGS, NOTEBOOK_KEY, NotebookStore, SETTINGS_KEY } from '../state/notebook.ts';
import { ROOM_IDS, ROOM_KEY, DEFAULT_ROOM } from '../state/room.ts';
import { ROSTER_KEY, defaultRoster, isValidRoster } from '../state/roster.ts';

export const BACKUP_KEYS = [CORE_KEY, DIAG_KEY, ROSTER_KEY, HOLDS_KEY, ROOM_KEY, NOTEBOOK_KEY, SETTINGS_KEY, FURNITURE_KEY, LEARN_PREFS_KEY] as const;
export type BackupKey = (typeof BACKUP_KEYS)[number];
export const BACKUP_FORMAT = 'certgarden-backup';
export const BACKUP_VERSION = 1;
/** サーバーの上限（server/src/backup.ts）。超える見込みなら送らない */
export const MAX_ENTRY_BYTES = 400_000;
export const MAX_TOTAL_BYTES = 900_000;

export class BackupError extends Error {
  readonly kind: 'invalid' | 'incomplete' | 'tooLarge' | 'empty';
  /** 問題のあるキー名（保存内容は含めない） */
  readonly keys: string[];
  constructor(kind: BackupError['kind'], keys: string[] = []) {
    super(`${kind}:${keys.join(',')}`);
    this.name = 'BackupError';
    this.kind = kind;
    this.keys = keys;
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- 送受信の形 ----
// サーバーは各値を「JSONオブジェクト」に限る。手帳は配列で保存しているので、送受信の間だけ { v:1, entries:[...] } に包む。
export function toTransport(key: string, raw: string): string {
  if (key !== NOTEBOOK_KEY) return raw;
  return JSON.stringify({ v: 1, entries: JSON.parse(raw) as unknown });
}

export function fromTransport(key: string, transport: string): string {
  if (key !== NOTEBOOK_KEY) return transport;
  const o = JSON.parse(transport) as unknown;
  if (!isObj(o) || o.v !== 1 || !Array.isArray(o.entries) || Object.keys(o).length !== 2) throw new Error('bad notebook wrapper');
  return JSON.stringify(o.entries);
}

// ---- 厳格な検査（既存の保存部品と同じ判定を再利用。読めない値を既定値へ黙って直さない） ----
async function validateRaw(key: string, raw: string): Promise<boolean> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return false;
  }
  try {
    switch (key) {
      case CORE_KEY:
        parseState(v);
        return true;
      case DIAG_KEY:
        return isValidDiagState(v);
      case HOLDS_KEY:
        return isValidHoldState(v);
      case ROSTER_KEY:
        return isValidRoster(v);
      case FURNITURE_KEY:
        return isValidLayout(v);
      case ROOM_KEY:
        return isObj(v) && (ROOM_IDS as unknown[]).includes(v.room);
      case LEARN_PREFS_KEY:
        return isObj(v) && QUALIFICATIONS.some((q) => q.id === v.qualificationId);
      case SETTINGS_KEY:
        return isObj(v) && (v.companion === 'cream' || v.companion === 'lavender' || v.companion === 'apricot') && typeof v.reduceMotion === 'boolean';
      case NOTEBOOK_KEY: {
        const staged = new MemoryKv();
        staged.map.set(NOTEBOOK_KEY, raw);
        await new NotebookStore(staged).load(); // 壊れていれば例外
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** 端末にまだ保存が無い項目の既定値（既存の初期値と同じ）。送る束を9項目そろえるため。学習コア本体は作らない */
function defaultRaw(key: string): string | null {
  switch (key) {
    case DIAG_KEY:
      return JSON.stringify(emptyDiagState());
    case HOLDS_KEY:
      return JSON.stringify(emptyHoldState());
    case ROSTER_KEY:
      return JSON.stringify(defaultRoster());
    case FURNITURE_KEY:
      return JSON.stringify(starterLayout());
    case ROOM_KEY:
      return JSON.stringify({ room: DEFAULT_ROOM });
    case LEARN_PREFS_KEY:
      return JSON.stringify({ qualificationId: 'it-passport' });
    case SETTINGS_KEY:
      return JSON.stringify(DEFAULT_SETTINGS);
    case NOTEBOOK_KEY:
      return '[]';
    default:
      return null;
  }
}

export interface Bundle {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  entries: Record<string, string>;
}

/**
 * 端末の現在の保存を集めて、送る束(9項目・送受信の形)を作る。
 * 1つでも壊れていれば 'invalid'（送らない・何も変えない）。学習コアがまだ無ければ 'empty'（送るものがない）。
 */
export async function collectBundle(kv: KeyValue): Promise<Bundle> {
  const entries: Record<string, string> = {};
  const bad: string[] = [];
  let total = 0;
  for (const key of BACKUP_KEYS) {
    let raw = await kv.getItem(key);
    if (raw === null) {
      if (key === CORE_KEY) throw new BackupError('empty');
      raw = defaultRaw(key);
      if (raw === null) throw new BackupError('empty');
    }
    if (!(await validateRaw(key, raw))) {
      bad.push(key);
      continue;
    }
    const t = toTransport(key, raw);
    const n = bytes(t);
    total += n;
    if (n > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new BackupError('tooLarge', [key]);
    entries[key] = t;
  }
  if (bad.length > 0) throw new BackupError('invalid', bad);
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, entries };
}

/**
 * 受け取った束を検査する。形・版・9項目そろい（欠けも余りも不可）・各項目の中身。
 * 通れば保存用の（送受信の形から戻した）文字列を返す。通らなければ何も書かない。
 */
export async function validateBundle(b: { format: string; version: number; entries: Record<string, string> }): Promise<Record<BackupKey, string>> {
  if (b.format !== BACKUP_FORMAT || b.version !== BACKUP_VERSION) throw new BackupError('invalid', ['format']);
  const have = Object.keys(b.entries);
  const missing = BACKUP_KEYS.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !(BACKUP_KEYS as readonly string[]).includes(k));
  if (missing.length > 0 || extra.length > 0) throw new BackupError('incomplete', [...missing, ...extra]);
  const out: Partial<Record<BackupKey, string>> = {};
  const bad: string[] = [];
  for (const key of BACKUP_KEYS) {
    let raw: string;
    try {
      raw = fromTransport(key, b.entries[key]!);
    } catch {
      bad.push(key);
      continue;
    }
    if (!(await validateRaw(key, raw))) bad.push(key);
    else out[key] = raw;
  }
  if (bad.length > 0) throw new BackupError('invalid', bad);
  return out as Record<BackupKey, string>;
}

/** 内容の目印（変更の検出用。暗号ではない）。cyrb53 */
export function contentHash(bundle: Bundle): string {
  const s = BACKUP_KEYS.map((k) => `${k}\n${bundle.entries[k] ?? ''}`).join('\n\u0000');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// ---- 世代つき保存 ----

export const GEN_POINTER_KEY = 'gen:v1';
const genKey = (gen: number, key: string) => `g${gen}/${key}`;

export const GUEST = 'guest';

interface SpaceRef {
  gen: number;
  prev: number | null;
}
/**
 * v2: 「空間」ごとの世代。guest = このアプリを使っている端末の元のデータ（世代0は従来のキーそのまま）。
 * 空間のキーがユーザーID = そのアカウントからクラウド復元した端末内のコピー（そのアカウントでログインした時だけ見える）。
 * next は世代番号の通し番号、garbage は削除待ちの世代（ポインターを先に切り替えてから消し、消し損ねは次回起動で再試行）。
 */
interface Pointer {
  v: 2;
  active: string;
  spaces: Record<string, SpaceRef>;
  next: number;
  garbage: number[];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parsePointer(text: string | null): Pointer {
  if (text === null) return { v: 2, active: GUEST, spaces: { [GUEST]: { gen: 0, prev: null } }, next: 1, garbage: [] };
  const p = JSON.parse(text) as Record<string, unknown>;
  if (p.v === undefined) {
    // 旧形式 {gen, prev}（この比較入口の以前の版）を guest 空間として引き継ぐ
    if (!isInt(p.gen) || !(p.prev === null || isInt(p.prev))) throw new Error('世代の記録が壊れています');
    return { v: 2, active: GUEST, spaces: { [GUEST]: { gen: p.gen, prev: p.prev as number | null } }, next: Math.max(p.gen, (p.prev as number | null) ?? 0) + 1, garbage: [] };
  }
  const spaces = p.spaces as Record<string, SpaceRef> | undefined;
  if (p.v !== 2 || typeof p.active !== 'string' || !spaces || typeof spaces !== 'object' || !isInt(p.next) || !Array.isArray(p.garbage) || !p.garbage.every(isInt)) throw new Error('世代の記録が壊れています');
  for (const s of Object.values(spaces)) if (!s || !isInt(s.gen) || !(s.prev === null || isInt(s.prev))) throw new Error('世代の記録が壊れています');
  if (!spaces[GUEST] || !spaces[p.active]) throw new Error('世代の記録が壊れています');
  return { v: 2, active: p.active, spaces, next: p.next, garbage: p.garbage as number[] };
}

/**
 * 9つのデータキーだけを「世代」の下へ読み書きする KeyValue。他のキー（比較設定・結び付けなど）はそのまま通す。
 * 復元は新しい世代へ全項目を書き、読み戻して確かめてから、ポインターを1回の書き込みで切り替える。
 * 途中で失敗・停止しても、ポインターは古い世代のまま＝旧データを使い続ける。旧世代は残し、「元に戻す」で戻せる。
 * アカウントごとの復元データは空間（owner）に分け、別のアカウント・ゲストには見せない。
 */
export class GenerationKv implements KeyValue {
  private readonly inner: KeyValue;
  private pointer: Pointer | null = null;
  private loading: Promise<Pointer> | null = null;
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  constructor(inner: KeyValue) {
    this.inner = inner;
  }

  /** 見える空間（ゲスト/アカウント）が変わった時に呼ばれる。画面は作り直して読み直す */
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private changed() {
    this.epoch += 1;
    for (const l of this.listeners) l();
  }

  /** 切り替えは1本ずつ（ポインターの読み書きが交差しない） */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * 画面（学習コントローラーなど）に渡す読み書き窓口。世代を切り替えた（復元・取り消し）後は、切り替え前に作った窓口からの
   * データキーの「書き込み」を拒否する。切り替え前の古いメモリ状態が、復元した内容を上書きするのを防ぐ（読み取りは可）。
   */
  view(): KeyValue {
    const e = this.epoch;
    return {
      getItem: (k) => this.getItem(k),
      setItem: async (k, v) => {
        if (e !== this.epoch && (BACKUP_KEYS as readonly string[]).includes(k)) throw new Error('保存先が切り替わりました。画面を開き直してください');
        return this.setItem(k, v);
      },
      removeItem: async (k) => {
        if (e !== this.epoch && (BACKUP_KEYS as readonly string[]).includes(k)) throw new Error('保存先が切り替わりました。画面を開き直してください');
        return this.removeItem(k);
      },
    };
  }

  private async ptr(): Promise<Pointer> {
    if (this.pointer) return this.pointer;
    if (!this.loading) {
      this.loading = (async () => parsePointer(await this.inner.getItem(GEN_POINTER_KEY)))();
      this.loading.then((p) => (this.pointer = p), () => (this.loading = null));
    }
    return this.loading;
  }

  /** ポインターを1回の書き込みで差し替える。書き込みに失敗したらメモリも変えない */
  private async writePointer(p: Pointer): Promise<void> {
    await this.inner.setItem(GEN_POINTER_KEY, JSON.stringify(p));
    this.pointer = p;
    this.loading = Promise.resolve(p);
  }

  private async map(key: string): Promise<string> {
    if (!(BACKUP_KEYS as readonly string[]).includes(key)) return key;
    const p = await this.ptr();
    const { gen } = p.spaces[p.active]!;
    return gen === 0 ? key : genKey(gen, key);
  }

  private async removeGen(gen: number): Promise<boolean> {
    if (gen === 0) return true; // 従来のキー（ゲストの元データ）は消さない
    let ok = true;
    for (const key of BACKUP_KEYS) {
      try {
        await this.inner.removeItem(genKey(gen, key));
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  /** 削除待ちの世代を消す。消せたものだけポインターから外す（消し損ねは残して次回に再試行）。残りがあれば false */
  private async sweep(): Promise<boolean> {
    const p = await this.ptr();
    if (p.garbage.length === 0) return true;
    const left: number[] = [];
    for (const g of p.garbage) if (!(await this.removeGen(g))) left.push(g);
    if (left.length !== p.garbage.length) {
      try {
        await this.writePointer({ ...p, garbage: left });
      } catch {
        return false;
      }
    }
    return left.length === 0;
  }

  /** 起動時: 前回の消し損ねを片付ける。残っていれば false（誰にも見えないが、端末には残っている） */
  recover(): Promise<boolean> {
    return this.serial(() => this.sweep());
  }

  activeSpace(): Promise<string> {
    return this.ptr().then((p) => p.active);
  }

  /** ログイン/ログアウトで見える空間を切り替える。そのアカウントの空間があればそれ、無ければゲスト。変化したら通知 */
  activate(owner: string | null): Promise<boolean> {
    return this.serial(async () => {
      const p = await this.ptr();
      const target = owner !== null && p.spaces[owner] ? owner : GUEST;
      if (target === p.active) return false;
      // 先にメモリ上で切り替える（ログアウト直後に前のアカウントのデータを見せない＝fail closed）。
      // 記録できなくても、次回起動時に init がセッションの有無から見える空間を決め直すので、別の人に漏れない
      const next = { ...p, active: target };
      this.pointer = next;
      this.loading = Promise.resolve(next);
      this.changed();
      await this.inner.setItem(GEN_POINTER_KEY, JSON.stringify(next)).catch(() => undefined);
      return true;
    });
  }

  /** 空間が持つ世代 */
  async spaceInfo(owner: string): Promise<SpaceRef | null> {
    const p = await this.ptr();
    return p.spaces[owner] ? { ...p.spaces[owner]! } : null;
  }

  /**
   * 戻せるか。owner の空間が見えている時だけ（別のアカウントの世代へ戻す経路は無い）。
   * 'previous' = その空間の直前の世代へ / 'toGuest' = 初めての復元なので復元前のゲストのデータへ
   */
  async undoKind(owner: string): Promise<'none' | 'previous' | 'toGuest'> {
    const p = await this.ptr();
    if (owner === GUEST || p.active !== owner || !p.spaces[owner]) return 'none';
    return p.spaces[owner]!.prev !== null ? 'previous' : 'toGuest';
  }

  async getItem(key: string) {
    return this.inner.getItem(await this.map(key));
  }
  async setItem(key: string, value: string) {
    return this.inner.setItem(await this.map(key), value);
  }
  async removeItem(key: string) {
    return this.inner.removeItem(await this.map(key));
  }

  /** 見えている空間の世代（試験・表示用） */
  async currentGeneration(): Promise<{ gen: number; prev: number | null; owner: string }> {
    const p = await this.ptr();
    return { ...p.spaces[p.active]!, owner: p.active };
  }

  /**
   * 検査済みの9項目を owner（アカウント）の新しい世代へ書いて、その空間に切り替える。失敗したら例外で、見える世代は変わらない。
   * ゲストの元のデータには一切触れない。書いた後に読み戻して一致を確かめる。
   */
  commit(entries: Record<BackupKey, string>, owner: string): Promise<{ gen: number }> {
    if (!owner || owner === GUEST) return Promise.reject(new Error('owner が不正です'));
    return this.serial(async () => {
      const cur = await this.ptr();
      const next = cur.next;
      const written: string[] = [];
      try {
        for (const key of BACKUP_KEYS) {
          await this.inner.setItem(genKey(next, key), entries[key]);
          written.push(genKey(next, key));
        }
        for (const key of BACKUP_KEYS) {
          if ((await this.inner.getItem(genKey(next, key))) !== entries[key]) throw new Error('書き込みの確認に失敗しました');
        }
        const old = cur.spaces[owner];
        const garbage = [...cur.garbage];
        // 2つ前の世代は不要（直前の1つは「元に戻す」用に残す）
        if (old && old.prev !== null && old.prev > 0) garbage.push(old.prev);
        await this.writePointer({ v: 2, active: owner, spaces: { ...cur.spaces, [owner]: { gen: next, prev: old ? old.gen : null } }, next: next + 1, garbage });
      } catch (e) {
        for (const k of written) await this.inner.removeItem(k).catch(() => undefined); // 使われていない書きかけを片付ける
        throw e;
      }
      this.changed();
      await this.sweep().catch(() => undefined);
      return { gen: next };
    });
  }

  /** 復元を取り消す。owner の空間が見えている時だけ。直前の世代へ、初めての復元ならゲストのデータへ戻る */
  rollback(owner: string): Promise<boolean> {
    return this.serial(async () => {
      const kind = await this.undoKind(owner);
      if (kind === 'none') return false;
      const cur = await this.ptr();
      const s = cur.spaces[owner]!;
      if (kind === 'previous') {
        await this.writePointer({ ...cur, spaces: { ...cur.spaces, [owner]: { gen: s.prev!, prev: null } }, garbage: s.gen > 0 ? [...cur.garbage, s.gen] : cur.garbage });
      } else {
        const spaces = { ...cur.spaces };
        delete spaces[owner];
        await this.writePointer({ ...cur, active: GUEST, spaces, garbage: s.gen > 0 ? [...cur.garbage, s.gen] : cur.garbage });
      }
      this.changed();
      await this.sweep().catch(() => undefined);
      return true;
    });
  }

  /**
   * アカウント削除に伴い、そのアカウントの端末内コピー（世代・元に戻す用の残り）をすべて取り除く。ゲストのデータには触れない。
   * 先にポインターから外す（以後は誰にも見えない）→ 世代のキーを消す。消し損ねは削除待ちに残り、cleaned=false を返す。
   * ポインターを書けなかった時は例外（呼び出し側は成功を偽らない）。
   */
  purgeOwner(owner: string): Promise<{ cleaned: boolean }> {
    return this.serial(async () => {
      const cur = await this.ptr();
      const s = cur.spaces[owner];
      if (!s || owner === GUEST) return { cleaned: true };
      const spaces = { ...cur.spaces };
      delete spaces[owner];
      const gone = [s.gen, ...(s.prev !== null ? [s.prev] : [])].filter((g) => g > 0);
      const wasActive = cur.active === owner;
      await this.writePointer({ ...cur, active: wasActive ? GUEST : cur.active, spaces, garbage: [...cur.garbage, ...gone] });
      if (wasActive) this.changed();
      return { cleaned: await this.sweep().catch(() => false) };
    });
  }
}
