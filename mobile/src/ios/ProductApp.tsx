// iOS の製品の入口。承認された1つの案（release-selection.json）の画面だけを出す。比較の道具（操作帯・picker・固定・故障の差し込み・人工の待ち）は無い。
// 製品の読み込みは本物の ready/error/retry だけで進み（待ち 0）、スケルトンは ON。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GenerationKv } from '../account/backup.ts';
import { createNativeAccount } from '../account/native';
import { asyncKv } from '../state/asyncKv';
import { useOsReduceMotion } from '../ui/hooks';
import { ReduceMotionContext } from '../ui/motion';
import { C } from '../ui/theme';
import { LoadView } from './Skeletons';
import { productConfig } from './entry.ts';
import { Runner } from './Runner';
import { PRODUCT_PREVIEW_PREFIX, PrefixedKv, ProductKv } from './storage.ts';

export interface ProductAppProps {
  /** 画面の案(1〜5) */
  variant: number;
  /**
   * device = 端末の本物の保存（学習の9キーは既存のものをそのまま読むゲストの原本）。
   * preview = Web の開発専用の検品用。別の保存（通常・比較のどちらにも触れない）
   */
  space: 'device' | 'preview';
}

export default function ProductApp({ variant, space }: ProductAppProps) {
  const { gen, account } = useMemo(() => {
    const base = space === 'device' ? new ProductKv(asyncKv) : new PrefixedKv(asyncKv, PRODUCT_PREVIEW_PREFIX);
    const g = new GenerationKv(base);
    return { gen: g, account: createNativeAccount(g, g) };
  }, [space]);
  // 見える保存の空間（ゲスト/アカウント）や世代が変わるたびに画面を作り直して読み直す（古い画面は新しい内容を上書きできない）
  const [epoch, setEpoch] = useState(0);
  useEffect(() => gen.subscribe(() => setEpoch((e) => e + 1)), [gen]);
  const kv = useMemo(() => gen.view(), [gen, epoch]);
  // 起動時に見える空間をセッションの有無から確定してから描く（認証前にアカウントのデータを見せない）
  const [accountReady, setAccountReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void account.init().finally(() => alive && setAccountReady(true));
    return () => {
      alive = false;
    };
  }, [account]);
  useEffect(() => {
    if (!accountReady) return;
    return account.startMonitoring(); // Apple の失効（前面復帰時の照会と OS の通知）
  }, [account, accountReady]);
  const accountBusy = useSyncExternalStore((cb) => account.subscribe(cb), () => account.isBusy());
  const cfg = useMemo(() => productConfig(variant), [variant]);

  return (
    <SafeAreaProvider>
      <View style={styles.page}>{accountReady ? <Runner key={epoch} cfg={cfg} kv={kv} account={account} accountBusy={accountBusy} /> : <BootSkeleton />}</View>
    </SafeAreaProvider>
  );
}

/**
 * 起動時、見える保存の空間（ゲスト/アカウント）を確かめ終わるまで、個人のデータを描かずに箱庭の骨組みを出す。
 * 人工の待ちは足さない（account.init の実際の完了で入れ替わる）。読み込み中は操作できず、読み上げには「読み込み中」を伝える。
 */
function BootSkeleton() {
  const insets = useSafeAreaInsets();
  const reduce = useOsReduceMotion();
  return (
    <ReduceMotionContext.Provider value={reduce}>
      <View style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <LoadView kind="home" skeleton />
      </View>
    </ReduceMotionContext.Provider>
  );
}

const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: C.bg } });
