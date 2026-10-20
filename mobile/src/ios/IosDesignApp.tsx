// iOS候補の「比較入口」（5案を見比べる道具）。開発用で、製品の起動経路には入らない。
// 本体(App.tsx)とは別の保存（名前空間）で動き、本体の採用デザインと本人の保存には触れない。
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GenerationKv } from '../account/backup.ts';
import { createNativeAccount } from '../account/native';
import { asyncKv } from '../state/asyncKv';
import { CORE_KEY } from '../state/kvStorage.ts';
import { MotionCheck } from '../ui/MotionCheck';
import { CompareChrome } from './CompareChrome';
import { buildCompareSearch, mergeCompare, parseCompareSearch, parsePin, withPin } from './compare.ts';
import { CompareStore, FaultKv, type CompareSettings } from './namespace.ts';
import { Runner, type ChromeApi } from './Runner';
import { PrefixedKv } from './storage.ts';

export default function IosDesignApp() {
  // 保存の層: 本体のキーに触れない名前空間 → 世代つき(復元の原子的な切り替え) → 比較用の読込失敗の差し込み
  const { gen, account, compareStore } = useMemo(() => {
    const prefixed = new PrefixedKv(asyncKv);
    const g = new GenerationKv(prefixed);
    return { gen: g, account: createNativeAccount(g, g), compareStore: new CompareStore(prefixed) };
  }, []);
  // 見える保存の空間（ゲスト/アカウント）や世代が変わるたび（復元・取り消し・ログイン・ログアウト・退会）に、
  // 画面（学習コントローラー等）を作り直して読み直す。古い画面のメモリが新しい内容を上書きしないよう、古い窓口の書き込みは拒否される
  const [epoch, setEpoch] = useState(0);
  useEffect(() => gen.subscribe(() => setEpoch((e) => e + 1)), [gen]);
  const fault = useMemo(() => new FaultKv(gen.view()), [gen, epoch]);
  const [cfg, setCfg] = useState<CompareSettings | null>(null);
  // 起動時に、見える空間をセッションの有無から確定してから画面を作る（前のアカウントのデータを一瞬でも出さない）
  const [accountReady, setAccountReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void account.init().finally(() => alive && setAccountReady(true));
    return () => {
      alive = false;
    };
  }, [account]);
  // Apple の資格情報の失効（前面復帰時の照会と OS の通知）の監視
  useEffect(() => {
    if (!accountReady) return;
    return account.startMonitoring();
  }, [account, accountReady]);
  const accountBusy = useSyncExternalStore((cb) => account.subscribe(cb), () => account.isBusy());

  useEffect(() => {
    let alive = true;
    void compareStore.load().then((stored) => {
      if (!alive) return;
      const over = Platform.OS === 'web' && typeof window !== 'undefined' ? parseCompareSearch(window.location.search) : {};
      setCfg(mergeCompare(stored, over));
    });
    return () => {
      alive = false;
    };
  }, [compareStore]);

  const update = useCallback(
    (patch: Partial<CompareSettings>) => {
      setCfg((cur) => {
        if (!cur) return cur;
        const next = mergeCompare(cur, patch);
        void compareStore.save(next).catch(() => undefined); // 確認用の設定。保存できなくても比較はできる
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.history.replaceState(null, '', `${window.location.pathname}${buildCompareSearch(window.location.search, next)}${window.location.hash}`);
        }
        return next;
      });
    },
    [compareStore],
  );

  const compare = useMemo(
    () => ({
      armFailure: () => fault.armReadFailure(CORE_KEY),
      // 動きの見くらべは比較の入口だけ（全26体の既存の画面）。製品には渡さない
      renderLab: (initialId: string, onBack: () => void) => <MotionCheck initialId={initialId} onBack={onBack} />,
      initialPin: Platform.OS === 'web' && typeof window !== 'undefined' ? parsePin(window.location.search) : null,
      onPinChange: (k: ReturnType<typeof parsePin>) => {
        if (Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState(null, '', `${window.location.pathname}${withPin(window.location.search, k)}${window.location.hash}`);
      },
      renderChrome: (api: ChromeApi) => renderChromeFor(cfg!, api, update), // Runner は cfg がある時だけ描かれる
    }),
    [fault, cfg, update],
  );

  return (
    <SafeAreaProvider>
      <View style={styles.page}>
        {cfg && accountReady ? <Runner key={epoch} cfg={cfg} kv={fault} account={account} accountBusy={accountBusy} compare={compare} /> : null}
      </View>
    </SafeAreaProvider>
  );
}

function renderChromeFor(cfg: CompareSettings, api: ChromeApi, update: (p: Partial<CompareSettings>) => void) {
  return (
    <CompareChrome
      cfg={cfg}
      onVariant={(v) => update({ variant: v })}
      onSkeleton={(on) => update({ skeleton: on })}
      onDelay={(ms) => update({ delayMs: ms })}
      onReplay={api.replay}
      onFail={api.fail}
      busy={api.busy}
      flowOpen={api.flowOpen}
      insetTop={api.insetTop}
      pin={api.pin}
      onPin={api.setPin}
    />
  );
}

const styles = StyleSheet.create({
  // 比較用の外側（製品ではない）。偽のステータスバーやホームインジケーターは描かない
  page: { flex: 1, backgroundColor: '#1c1c1e', ...(Platform.OS === 'web' ? ({ height: '100dvh' } as object) : null) },
});
