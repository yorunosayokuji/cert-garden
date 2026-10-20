// 仮値。本人が確定した数値ではない（apps/README.md「採用済みの継続方針／未決の数値」）。
export interface CoreConfig {
  /** 初期デモ値 8/10（仮） */
  initialFruits: number;
  maxFruits: number;
  /** 完了報酬ポイント +10（仮） */
  completionPoints: number;
  /** 復習間隔（日）翌日→3→7→14（仮。効果は未実証） */
  reviewIntervalsDays: number[];
  /** 日付境界。JST=540（仮） */
  tzOffsetMinutes: number;
  /** 1操作間で学習時間に数える上限秒（放置を学習時間にしない） */
  maxCountedGapSeconds: number;
  /** 実が1個回復するまで（ms）。仮: 1時間 */
  fruitRecoveryMs: number;
}

export const DEMO_CONFIG: CoreConfig = {
  initialFruits: 8,
  maxFruits: 10,
  completionPoints: 10,
  reviewIntervalsDays: [1, 3, 7, 14],
  tzOffsetMinutes: 540,
  maxCountedGapSeconds: 120,
  fruitRecoveryMs: 3_600_000,
};
