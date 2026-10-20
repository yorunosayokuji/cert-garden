// iOS 画面の共通の中身（製品と比較入口で共有）。5案の画面・学習フロー・アカウントは同じ部品。
// 比較専用の道具（上の操作帯・picker・読込の固定・故障の差し込み・人工の待ち）は compare が渡された時だけ働き、
// 渡さない製品では何も出ない・何も読み込まない（待ちは 0、スケルトン ON、本物の ready/error/retry だけで進む）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountService } from '../account/service.ts';
import type { KeyValue } from '../state/kv.ts';
import { Button } from '../ui/common';
import type { LabTab } from '../ui/MotionLab.tsx';
import { ReduceMotionContext } from '../ui/motion';
import { C, MAX_W, T } from '../ui/theme';
import type { SkeletonKind } from './compare.ts';
import { FlowScreen, hasFlow, type RenderLab } from './Flow';
import type { UiCtx } from './Screens';
import { LoadView } from './Skeletons';
import { useGardenRuntime } from './useGardenRuntime';
import { useMinShow } from './useMinShow';
import { VARIANT_COMPONENTS, type Sheet, type Tab } from './Variants';

export interface RunnerCfg {
  variant: number;
  skeleton: boolean;
  /** 比較用の人工の待ち(ms)。製品は 0 */
  delayMs: number;
}

/** 比較入口の操作帯へ渡す操作 */
export interface ChromeApi {
  replay: () => void;
  fail: () => void;
  busy: boolean;
  flowOpen: boolean;
  insetTop: number;
  pin: SkeletonKind | null;
  setPin: (k: SkeletonKind | null) => void;
}

export interface CompareHooks {
  renderChrome: (api: ChromeApi) => ReactNode;
  /** 次の1回だけ保存の読み取りを失敗させる（本物の読込エラー→再試行の経路を見る） */
  armFailure: () => void;
  initialPin: SkeletonKind | null;
  onPinChange: (k: SkeletonKind | null) => void;
  /** 動きの見くらべ(lab)の画面。比較の入口だけが渡す。無ければ箱庭に「新しい動き」を出さず、lab の部品も読み込まない（製品） */
  renderLab?: RenderLab;
}

export interface RunnerProps {
  cfg: RunnerCfg;
  kv: KeyValue;
  account: AccountService;
  accountBusy: boolean;
  compare?: CompareHooks;
}

export function Runner({ cfg, kv, account, accountBusy, compare }: RunnerProps) {
  const insets = useSafeAreaInsets();
  const rt = useGardenRuntime(kv);
  const { c, diag } = rt;
  const [tab, setTab] = useState<Tab>('home');
  const [pin, setPinState] = useState<SkeletonKind | null>(compare?.initialPin ?? null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [lab, setLab] = useState<LabTab | null>(null);
  const [nonce, setNonce] = useState(0);
  const [frameTop, setFrameTop] = useState(0);

  const setPin = useCallback(
    (k: SkeletonKind | null) => {
      if (!compare) return; // 製品には固定がない
      setPinState(k);
      if (k === 'home' || k === 'learn' || k === 'notebook' || k === 'shop') setTab(k);
      setSheet(k === 'notebook' || k === 'shop' ? k : null); // 候補4/5では手帳・お店はシートの中
      compare.onPinChange(k);
    },
    [compare],
  );

  // 読み込み表示: 実際の準備中は必ず。比較では準備が整っていても人工の待ち(1.2秒)が残る間は続ける。製品は待ち 0＝実際の準備だけで進む
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
      setNonce((n) => n + 1); // 設問・結果の読み込み表示を計り直す（保存データには触れない）
      return;
    }
    if (bootBusyRef.current) return; // 読み込み中の連続操作は二重に走らせない
    setNonce((n) => n + 1);
    void c.load();
  }, [c.load]);

  const fail = useCallback(() => {
    if (!compare || flowRef.current || bootBusyRef.current) return;
    compare.armFailure();
    setNonce((n) => n + 1);
    void c.load();
  }, [c.load, compare]);

  // 本物の読込失敗からの再試行（製品でも同じ）
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
    cfg: { variant: cfg.variant, skeleton: cfg.skeleton, delayMs: cfg.delayMs },
    bootVisible,
    retry,
    keyboardOffset: frameTop,
    openLab: compare?.renderLab ? setLab : undefined,
    account,
    pin,
    bottomInset: insets.bottom,
  };
  const Variant = VARIANT_COMPONENTS[cfg.variant - 1]!;
  const dark = !!compare;

  return (
    <ReduceMotionContext.Provider value={rt.reduceMotion}>
      {compare?.renderChrome({ replay, fail, busy: bootBusyRef.current, flowOpen, insetTop: insets.top, pin, setPin })}
      <View style={[styles.frameWrap, { backgroundColor: dark ? '#1c1c1e' : C.bg }, !compare && { paddingTop: insets.top }]}>
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
            <FlowScreen ctx={ctx} lab={lab} renderLab={compare?.renderLab} onCloseLab={() => setLab(null)} goHome={() => setTab('home')} loadingKind={loadingKind} />
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
  frameWrap: { flex: 1, alignItems: 'center' },
  frame: { flex: 1, width: '100%', maxWidth: MAX_W, backgroundColor: C.bg, overflow: 'hidden' },
  notice: { backgroundColor: C.hintBg, padding: 10, gap: 6, borderBottomWidth: 2, borderBottomColor: C.line },
  noticeText: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink },
});
