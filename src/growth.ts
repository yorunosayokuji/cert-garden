// 実の時計・一日のミッション・木の世話の純粋なロジック（仮ルール）。
// 端末内の試作で、サーバーの不正対策や課金残高ではない。時計はこの端末の Date.now() を JST の日付に直して使う。
import type { CoreConfig } from './config.ts';
import type { CoreState } from './types.ts';

export const MISSION_KINDS = ['learn', 'review'] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

export interface DailyMission {
  /** 今日これを完了した学習/おさらいの完了ID。診断・中断・終了・放置は入らない */
  completionId: string | null;
  claimed: boolean;
}
export interface FruitClock {
  /** 最後に処理したJST日。日付が進むと満タンにする */
  lastDay: string;
  /** 1時間ごとの回復の起点(ms)。満タンの間は常に「いま」に進め、貯金しない */
  anchor: number;
  /** これまでに処理した最大の時刻(ms)。時計が戻っても、これに追いつくまで新しい回復・再配布をしない */
  maxSeen: number;
}

export function jstDay(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}
/** 次のJST日付の始まり(ms) */
export function nextDayStart(ms: number, tzOffsetMinutes: number): number {
  const day = jstDay(ms, tzOffsetMinutes);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d + 1) - tzOffsetMinutes * 60_000;
}

/**
 * 実の回復を進める（state を直接書き換える）。同じ時刻・同じ日に何度呼んでも二重に回復しない。
 * - 旧保存（時計なし）は現在の実を保ち、いまから時計を始める（さかのぼって配らない）
 * - 時計が戻ったら、maxSeen に追いつくまで何も増やさない
 * - JST日付が進んだら満タン。満タンの間の時間は貯金しない
 * 戻り値: 変更があったか
 */
export function applyClock(s: CoreState, now: number, cfg: CoreConfig): boolean {
  const before = JSON.stringify([s.wallet, s.fruitClock, s.daily, s.tree, s.growthMigrated]);
  const day = jstDay(now, cfg.tzOffsetMinutes);
  const w = s.wallet;
  if (!s.fruitClock) {
    s.fruitClock = { lastDay: day, anchor: now, maxSeen: now };
  } else if (now >= s.fruitClock.maxSeen) {
    const c = s.fruitClock;
    if (c.lastDay < day) {
      if (w.fruits < w.maxFruits) w.fruits = w.maxFruits;
      c.lastDay = day;
      c.anchor = now;
    } else if (w.fruits < w.maxFruits) {
      const n = Math.floor((now - c.anchor) / cfg.fruitRecoveryMs);
      if (n > 0) {
        w.fruits = Math.min(w.maxFruits, w.fruits + n);
        c.anchor += n * cfg.fruitRecoveryMs;
      }
      if (w.fruits >= w.maxFruits) c.anchor = now;
    } else {
      c.anchor = now; // 満タンの間は貯金しない
    }
    c.maxSeen = now;
  }
  // 日が替わったらミッションを今日のものにする（過去日へは戻さない）
  const known = s.fruitClock.lastDay;
  if (!s.daily || s.daily.day < known) s.daily = { day: known, learn: { completionId: null, claimed: false }, review: { completionId: null, claimed: false } };
  migrateFromCompletions(s, cfg);
  return before !== JSON.stringify([s.wallet, s.fruitClock, s.daily, s.tree, s.growthMigrated]);
}

/**
 * 実の時計・ミッション・木の導入前（または導入直後）に保存された学習の完了記録から、一度だけ引き継ぐ。
 * - 今日（既知のJST日）に完了した学習/おさらいを、今日のミッションの達成にする（完了IDが受取済み台帳にあれば受取済み）
 * - 木の世話は、有効な完了日のユニーク日数まで（既存の世話数より減らさず、同じ日を二重に足さない）
 * - 過去日へは実を配らない。実・ポイント・学習時間は変えない。未来の完了（既知の最大時刻より後）は数えない
 * 引き継ぎ済みの印（growthMigrated）で、再起動しても二重に配らない。
 */
export function migrateFromCompletions(s: CoreState, cfg: CoreConfig): void {
  if (s.growthMigrated || !s.fruitClock) return;
  const known = s.fruitClock.lastDay;
  const limit = s.fruitClock.maxSeen;
  const valid = Object.values(s.completions ?? {})
    .filter((c) => Number.isFinite(c.completedAt) && c.completedAt <= limit)
    .map((c) => ({ ...c, day: jstDay(c.completedAt, cfg.tzOffsetMinutes) }))
    .filter((c) => c.day <= known);
  const days = new Set(valid.map((c) => c.day));
  if (days.size > 0) {
    const t = (s.tree ??= { total: 0, lastDay: '' });
    t.total = Math.max(t.total, days.size);
    const latest = [...days].sort().at(-1)!;
    if (latest > t.lastDay) t.lastDay = latest;
  }
  if (s.daily && s.daily.day === known) {
    for (const kind of MISSION_KINDS) {
      const m = s.daily[kind];
      if (m.completionId !== null) continue;
      const today = valid.filter((c) => c.day === known && c.kind === kind).sort((a, b) => b.completedAt - a.completedAt)[0];
      if (!today) continue;
      m.completionId = today.completionId;
      if (s.claimed && today.completionId in s.claimed) m.claimed = true;
    }
  }
  s.growthMigrated = true;
}

/** 書き込まずに、いまの見かけの実・次の回復時刻を出す（表示用） */
export function projectWallet(s: CoreState, now: number, cfg: CoreConfig): { fruits: number; nextFruitAt: number | null; nextDayAt: number } {
  // 表示の計算で保存済みの状態を書き換えないよう、変わりうる項目は深く複製する
  const copy: CoreState = {
    ...s,
    wallet: { ...s.wallet },
    ...(s.fruitClock ? { fruitClock: { ...s.fruitClock } } : {}),
    ...(s.daily ? { daily: JSON.parse(JSON.stringify(s.daily)) as NonNullable<CoreState['daily']> } : {}),
    ...(s.tree ? { tree: { ...s.tree } } : {}),
  };
  applyClock(copy, now, cfg);
  const c = copy.fruitClock!;
  const shownNow = Math.max(now, c.maxSeen); // 時計が戻っていても、既知の最大時刻を基準に表示
  return {
    fruits: copy.wallet.fruits,
    nextFruitAt: copy.wallet.fruits >= copy.wallet.maxFruits ? null : c.anchor + cfg.fruitRecoveryMs,
    nextDayAt: nextDayStart(shownNow, cfg.tzOffsetMinutes),
  };
}

/** 木の段階（累計の世話数から。誤答や休みで下がらない）。しきい値は仮 */
export type TreeStage = 'seed' | 'sprout' | 'leaf' | 'fruit';
export function treeStage(total: number): TreeStage {
  return total >= 7 ? 'fruit' : total >= 3 ? 'leaf' : total >= 1 ? 'sprout' : 'seed';
}

/**
 * 学習/おさらいの完了を、今日のミッションと木の世話に反映する（完了と同じ保存で呼ぶ）。
 * 完了IDとJST日が根拠。時計が戻っている間の完了（日付が既知の最大日より古い）は、ミッションにも世話にも数えない。
 */
export function recordCompletion(s: CoreState, kind: MissionKind, completionId: string, localDay: string): void {
  const known = s.fruitClock?.lastDay;
  if (!known || localDay !== known || !s.daily || s.daily.day !== known) return;
  const m = s.daily[kind];
  if (m.completionId === null && !(s.claimed && completionId in s.claimed)) m.completionId = completionId;
  const t = (s.tree ??= { total: 0, lastDay: '' });
  if (t.lastDay !== known) {
    t.total += 1;
    t.lastDay = known;
  }
}

export type ClaimResult = { status: 'claimed'; fruits: number } | { status: 'pending_full' } | { status: 'not_done' } | { status: 'already' };

/** ミッションの実を受け取る。満タンなら保留（上限超えも消失もしない）。同じ完了IDで二重に受け取れない */
export function claimMission(s: CoreState, kind: MissionKind): ClaimResult {
  const m = s.daily?.[kind];
  if (!m || m.completionId === null) return { status: 'not_done' };
  if (m.claimed || (s.claimed && m.completionId in s.claimed)) {
    m.claimed = true;
    return { status: 'already' };
  }
  if (s.wallet.fruits >= s.wallet.maxFruits) return { status: 'pending_full' };
  s.wallet.fruits += 1;
  m.claimed = true;
  (s.claimed ??= {})[m.completionId] = s.daily!.day;
  return { status: 'claimed', fruits: s.wallet.fruits };
}
