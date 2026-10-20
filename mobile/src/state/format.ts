/** 次の実までの短い表示（分単位。1秒ごとには更新しない）。満タンなら空 */
export function fruitEta(nextFruitAt: number | null, now: number): string {
  if (nextFruitAt === null) return '';
  const min = Math.max(1, Math.ceil((nextFruitAt - now) / 60_000));
  return min >= 60 ? `あと${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}` : `あと${min}分`;
}
