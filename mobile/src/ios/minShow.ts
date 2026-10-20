/**
 * 読み込み表示を出し続けるか。実際の準備中は必ず表示。準備が終わっていても、開始から delayMs 未満なら表示を続ける（比較用）。
 * delayMs=0 なら実際の準備だけで決まる＝待ちを足さない（製品はこちら）。
 */
export function minShowVisible(startedAt: number | null, real: boolean, now: number, delayMs: number): boolean {
  if (real) return true;
  if (startedAt === null || delayMs <= 0) return false;
  return now - startedAt < delayMs;
}

/** あと何 ms で表示を終えてよいか（実際の準備が終わっている時のみ意味がある） */
export function minShowRemaining(startedAt: number | null, now: number, delayMs: number): number {
  if (startedAt === null || delayMs <= 0) return 0;
  return Math.max(0, delayMs - (now - startedAt));
}
