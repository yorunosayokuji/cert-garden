// iOS候補の確認入口。本体(App.tsx)とは別の保存（名前空間）で動き、本体の採用デザインと本人の保存には触れない。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GenerationKv } from '../account/backup.ts';
import { createNativeAccount } from '../account/native';
import type { AccountService } from '../account/service.ts';
import { asyncKv } from '../state/asyncKv';
import { CORE_KEY } from '../state/kvStorage.ts';
import { Button } from '../ui/common';
import type { LabTab } from '../ui/MotionLab.tsx';
import { ReduceMotionContext } from '../ui/motion';
import { C, MAX_W, T } from '../ui/theme';
import { CompareChrome } from './CompareChrome';
import { buildCompareSearch, mergeCompare, parseCompareSearch, parsePin, withPin, type SkeletonKind } from './compare.ts';
import { LoadView } from './Skeletons';
import { FlowScreen, hasFlow } from './Flow';
import { CompareStore, FaultKv, PrefixedKv, type CompareSettings } from './namespace.ts';
import type { UiCtx } from './Screens';
import { useGardenRuntime } from './useGardenRuntime';
import { useMinShow } from './useMinShow';
import { VARIANT_COMPONENTS, type Sheet, type Tab } from './Variants';

export default function IosDesignApp() {
  // 本体の保存とは別の接頭辞。比較設定も同じ名前空間の中
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

  return (
    <SafeAreaProvider>
      <View style={styles.page}>
        {cfg && accountReady ? <Runner key={epoch} cfg={cfg} update={update} fault={fault} account={account} accountBusy={accountBusy} /> : null}
      </View>
    </SafeAreaProvider>
  );
}

function Runner({ cfg, update, fault, account, accountBusy }: { cfg: CompareSettings; update: (p: Partial<CompareSettings>) => void; fault: FaultKv; account: AccountService; accountBusy: boolean }) {
  const insets = useSafeAreaInsets();
  const rt = useGardenRuntime(fault);
  const { c, diag } = rt;
  const [tab, setTab] = useState<Tab>('home');
  // 比較用: 読み込み表示を固定して見る（解除すると実際の画面へ）。製品の経路には無く、保存や報酬には触れない
  const [pin, setPinState] = useState<SkeletonKind | null>(() => (Platform.OS === 'web' && typeof window !== 'undefined' ? parsePin(window.location.search) : null));
  const setPin = useCallback((k: SkeletonKind | null) => {
    setPinState(k);
    if (k === 'home' || k === 'learn' || k === 'notebook' || k === 'shop') setTab(k);
    setSheet(k === 'notebook' || k === 'shop' ? k : null); // 候補4/5では手帳・お店はシートの中
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.history.replaceState(null, '', `${window.location.pathname}${withPin(window.location.search, k)}${window.location.hash}`);
    }
  }, []);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [lab, setLab] = useState<LabTab | null>(null);
  const [nonce, setNonce] = useState(0);
  const [frameTop, setFrameTop] = useState(0);

  // 読み込み表示: 実際の準備中は必ず。準備が整っていても、比較用の待ち(1.2秒)が残る間は続ける。待ち「なし」なら実際の準備だけで進む
  const bootLoading = c.boot.kind === 'loading';
  const bootVisible = useMinShow('boot', bootLoading, cfg.delayMs, nonce);
  const sessionOpen = !!c.session && c.session.view.phase !== 'completed';
  const completed = !!c.session && c.session.view.phase === 'completed';
  const qShow = useMinShow(rt.starting || sessionOpen ? 'q' : null, rt.starting || (c.busy && !c.session), cfg.delayMs, nonce);
  const rShow = useMinShow(completed ? `r:${c.session!.stageId}` : null, completed && !c.session!.result, cfg.delayMs, nonce);
  const loadingKind: 'question' | 'result' | null = rShow ? 'result' : qShow ? 'question' : null;

  const flowOpen = hasFlow(rt, lab);
  const bootBusyRef = useRef(false);
  bootBusyRef.current = bootLoading || bootVisible;
  const flowRef = useRef(false);
  flowRef.current = flowOpen;

  const replay = useCallback(() => {
    if (flowRef.current) {
      // 設問・結果の読み込み表示を計り直す（保存データには触れない）
      setNonce((n) => n + 1);
      return;
    }
    if (bootBusyRef.current) return; // 読み込み中の連続操作は二重に走らせない
    setNonce((n) => n + 1);
    void c.load();
  }, [c.load]);

  const fail = useCallback(() => {
    if (flowRef.current || bootBusyRef.current) return;
    fault.armReadFailure(CORE_KEY); // 次の1回の読み取りだけ失敗（本物の読込エラー→再試行の経路）
    setNonce((n) => n + 1);
    void c.load();
  }, [c.load, fault]);

  const retry = useCallback(() => {
    setNonce((n) => n + 1);
    void c.load();
  }, [c.load]);

  // 端末の戻る操作（Android）。iOS はシート/画面の閉じる操作・スワイプで戻る
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (lab) {
        setLab(null);
        return true;
      }
      if (diag.qual && !c.session) {
        diag.close();
        return true;
      }
      if (c.session) {
        if (c.session.view.phase === 'completed') {
          setTab('home');
          c.returnHome();
        } else c.closeStage();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [lab, c.session, c.closeStage, c.returnHome, diag.qual, diag.close]);

  const ctx: UiCtx = {
    rt,
    cfg,
    bootVisible,
    retry,
    keyboardOffset: frameTop,
    openLab: setLab,
    account,
    pin,
    bottomInset: insets.bottom,
  };
  const Variant = VARIANT_COMPONENTS[cfg.variant - 1]!;

  return (
    <ReduceMotionContext.Provider value={rt.reduceMotion}>
      <CompareChrome
        cfg={cfg}
        onVariant={(v) => update({ variant: v })}
        onSkeleton={(on) => update({ skeleton: on })}
        onDelay={(ms) => update({ delayMs: ms })}
        onReplay={replay}
        onFail={fail}
        busy={bootBusyRef.current}
        flowOpen={flowOpen}
        insetTop={insets.top}
        pin={pin}
        onPin={setPin}
      />
      <View style={styles.frameWrap}>
        <View style={styles.frame} {...(Platform.OS === 'web' ? ({ dataSet: { productFrame: '1' } } as object) : null)} onLayout={(e) => setFrameTop(Math.round(e.nativeEvent.layout.y))}>
          {c.notice ? (
            <View style={styles.notice} accessibilityLiveRegion="assertive" accessibilityRole="alert">
              <Text style={styles.noticeText}>{c.notice.message}</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {c.notice.retry ? <Button label="もう一度" kind="secondary" onPress={c.notice.retry} /> : null}
                <Button label="とじる" kind="quiet" onPress={() => c.setNotice(null)} />
              </View>
            </View>
          ) : null}
          {pin === 'question' || pin === 'result' ? (
            <LoadView kind={pin} skeleton={cfg.skeleton} />
          ) : flowOpen ? (
            <FlowScreen ctx={ctx} lab={lab} onCloseLab={() => setLab(null)} goHome={() => setTab('home')} loadingKind={loadingKind} />
          ) : (
            <Variant key={`${cfg.variant}:${nonce}`} ctx={ctx} tab={tab} setTab={setTab} sheet={sheet} setSheet={setSheet} />
          )}
          {accountBusy ? (
            // アカウントの処理中（ログイン・保存・復元・退会）は画面の操作を受けない。途中で学習を始めたり画面を切り替えたりさせない
            <View style={StyleSheet.absoluteFill} accessible accessibilityLabel="アカウントの処理中" accessibilityState={{ busy: true }} />
          ) : null}
        </View>
      </View>
    </ReduceMotionContext.Provider>
  );
}

const styles = StyleSheet.create({
  // 比較用の外側（製品ではない）。偽のステータスバーやホームインジケーターは描かない
  page: { flex: 1, backgroundColor: '#1c1c1e', ...(Platform.OS === 'web' ? ({ height: '100dvh' } as object) : null) },
  frameWrap: { flex: 1, alignItems: 'center', backgroundColor: '#1c1c1e' },
  frame: { flex: 1, width: '100%', maxWidth: MAX_W, backgroundColor: C.bg, overflow: 'hidden' },
  notice: { backgroundColor: C.hintBg, padding: 10, gap: 6, borderBottomWidth: 2, borderBottomColor: C.line },
  noticeText: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink },
});
