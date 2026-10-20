import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, Platform, StyleSheet, Text, View } from 'react-native';
import { setInert } from './webFocus';
import { Button } from '../ui/common';
import { qualName } from '../ui/LearnTab';
import { useReduceMotion } from '../ui/motion';
import { C, T } from '../ui/theme';
import { HeaderBar, HeaderButton, Segmented, TabBar, type TabDef } from './Nav';
import { MOTION } from './Press';
import { BottomSheet } from './Sheet';
import { TabScreen, type UiCtx } from './Screens';

export type Tab = 'home' | 'learn' | 'notebook' | 'shop';
export type Sheet = 'notebook' | 'shop' | null;

export const TABS4: readonly TabDef<Tab>[] = [
  { id: 'home', label: '箱庭' },
  { id: 'learn', label: '学ぶ' },
  { id: 'notebook', label: '手帳' },
  { id: 'shop', label: 'お店' },
];
const TABS2: readonly TabDef<'home' | 'learn'>[] = [
  { id: 'home', label: '箱庭' },
  { id: 'learn', label: '学ぶ' },
];

export interface VariantProps {
  ctx: UiCtx;
  tab: Tab;
  setTab: (t: Tab) => void;
  sheet: Sheet;
  setSheet: (s: Sheet) => void;
}

/** 候補1 標準タブ: 箱庭/学ぶ/手帳/お店の4区画。部屋は引きの全景のまま、下に不透明なタブ */
export function Variant1({ ctx, tab, setTab }: VariantProps) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 120 }}>
      <View style={{ flexGrow: 1, flexBasis: 120 }}>
        <TabScreen kind={tab} ctx={ctx} />
      </View>
      <TabBar tabs={TABS4} active={tab} onChange={setTab} bottomInset={ctx.bottomInset} />
    </View>
  );
}

const DEEP = '#2b3527';
const FLOAT_SPACE = 49 + 8 + 20;

/** 候補2 全景ルーム: 部屋を画面いっぱいの濃い面に置き、実・ポイントは部屋の上に浮かせ、下の4タブは浮いたカプセル。他の画面も末尾に余白を足して隠れない */
export function Variant2({ ctx, tab, setTab }: VariantProps) {
  const space = FLOAT_SPACE + Math.max(ctx.bottomInset, 8);
  const home = tab === 'home';
  return (
    <View style={{ flex: 1, backgroundColor: home ? DEEP : C.bg }}>
      <View style={{ flex: 1, paddingBottom: home ? space : 0 }}>
        <TabScreen kind={tab} ctx={ctx} homeChrome="overlay" extraBottom={home ? 0 : space} />
      </View>
      <TabBar floating tabs={TABS4} active={tab} onChange={setTab} bottomInset={ctx.bottomInset} />
    </View>
  );
}

/** 候補3 学習カード: 箱庭の上に部屋、下に「選択中の資格・続き・復習」だけのカード。学習そのものは別画面（設問）で行う */
function StudyCard({ ctx, goLearn }: { ctx: UiCtx; goLearn: () => void }) {
  const { rt } = ctx;
  const snap = rt.c.snapshot;
  const qual = rt.learnQual.qual;
  if (!snap || !qual || ctx.bootVisible) return null;
  const busy = rt.c.busy || rt.starting;
  const resumeName = rt.c.resumable ? qualName(rt.c.resumable.qualificationId) : null;
  return (
    <View style={styles.studyCard} accessibilityRole="summary">
      <View style={styles.studyTop}>
        <Text style={styles.studyQual}>{resumeName ?? qualName(qual)}</Text>
        <Text style={styles.studyFruit} accessibilityLabel={`知恵の実 ${snap.fruits}個、最大${snap.maxFruits}個`}>実 {snap.fruits}/{snap.maxFruits}</Text>
      </View>
      <View style={styles.studyBtns}>
        {rt.c.resumable ? (
          <Button label="つづきから" onPress={() => void rt.startLearn()} disabled={busy} style={{ flexGrow: 1, flexBasis: 120 }} />
        ) : (
          <Button label="学ぶ" onPress={goLearn} style={{ flexGrow: 1, flexBasis: 120 }} />
        )}
        <Button label="復習" kind="secondary" onPress={() => void rt.startReview(rt.c.resumable?.qualificationId ?? qual)} disabled={busy} style={{ flexGrow: 1, flexBasis: 120 }} />
      </View>
    </View>
  );
}

export function Variant3({ ctx, tab, setTab }: VariantProps) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 120 }}>
      <View style={{ flexGrow: 1, flexBasis: 120 }}>
        <TabScreen kind={tab} ctx={ctx} />
      </View>
      {tab === 'home' ? <StudyCard ctx={ctx} goLearn={() => setTab('learn')} /> : null}
      <TabBar tabs={TABS4} active={tab} onChange={setTab} bottomInset={ctx.bottomInset} />
    </View>
  );
}

/** 候補4 2つの主役: 下タブは箱庭と学ぶの2つだけ。手帳とお店は右上のボタンから出るシート（とじる・下へ払う・背景タップで戻れる） */
export function Variant4({ ctx, tab, setTab, sheet, setSheet }: VariantProps) {
  const t2 = tab === 'learn' ? 'learn' : 'home';
  return (
    <View style={{ flexGrow: 1, flexBasis: 120 }}>
      <HeaderBar>
        <HeaderButton label="手帳" onPress={() => setSheet('notebook')} />
        <HeaderButton label="お店" onPress={() => setSheet('shop')} />
      </HeaderBar>
      <View style={{ flexGrow: 1, flexBasis: 120 }}>
        <TabScreen kind={t2} ctx={ctx} />
      </View>
      <TabBar tabs={TABS2} active={t2} onChange={setTab} bottomInset={ctx.bottomInset} />
      <BottomSheet visible={sheet === 'notebook'} title="手帳" onClose={() => setSheet(null)} bottomInset={ctx.bottomInset}>
        <TabScreen kind="notebook" ctx={ctx} />
      </BottomSheet>
      <BottomSheet visible={sheet === 'shop'} title="お店" onClose={() => setSheet(null)} bottomInset={ctx.bottomInset}>
        <TabScreen kind="shop" ctx={ctx} />
      </BottomSheet>
    </View>
  );
}

/** 横スワイプの2ページ。指に追従し、離すと近いほうへ220msで寄る。タップでも移動できる（segment）。縦の動きはスクロールに任せる */
function Pager({ index, onIndex, progress, left, right }: { index: number; onIndex: (i: number) => void; progress: Animated.Value; left: ReactNode; right: ReactNode }) {
  const reduce = useReduceMotion();
  const [w, setW] = useState(0);
  const indexRef = useRef(index);
  const wRef = useRef(0);
  indexRef.current = index;
  wRef.current = w;

  // Web: 画面外のページはキーボードの移動先にも入れない（aria-hidden だけでは Tab が入る）
  const pages = useRef<(HTMLElement | null)[]>([null, null]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setInert(pages.current[0] ?? null, index !== 0);
    setInert(pages.current[1] ?? null, index !== 1);
  }, [index]);

  const animateTo = (to: number) => {
    progress.stopAnimation();
    if (reduce) progress.setValue(to);
    else Animated.timing(progress, { toValue: to, duration: MOTION.screen, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  };
  // タップ・外部からの切り替え
  useEffect(() => {
    animateTo(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, reduce]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
        onPanResponderGrant: () => progress.stopAnimation(),
        onPanResponderMove: (_, g) => {
          const base = indexRef.current;
          const width = wRef.current || 1;
          progress.setValue(Math.min(1, Math.max(0, base - g.dx / width)));
        },
        onPanResponderRelease: (_, g) => {
          const base = indexRef.current;
          const width = wRef.current || 1;
          let to = base;
          if (g.dx < -width * 0.2 || g.vx < -0.5) to = 1;
          else if (g.dx > width * 0.2 || g.vx > 0.5) to = 0;
          if (to !== base) onIndex(to);
          else animateTo(base);
        },
        onPanResponderTerminate: () => animateTo(indexRef.current),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [progress, onIndex],
  );
  return (
    <View style={{ flex: 1, overflow: 'hidden' }} onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))} {...pan.panHandlers}>
      <Animated.View style={{ flex: 1, flexDirection: 'row', width: Math.max(w, 1) * 2, transform: [{ translateX: Animated.multiply(progress, -Math.max(w, 1)) }] }}>
        <View ref={(n) => { pages.current[0] = n as unknown as HTMLElement | null; }} style={{ width: Math.max(w, 1) }} importantForAccessibility={index === 0 ? 'auto' : 'no-hide-descendants'} aria-hidden={index !== 0}>{left}</View>
        <View ref={(n) => { pages.current[1] = n as unknown as HTMLElement | null; }} style={{ width: Math.max(w, 1) }} importantForAccessibility={index === 1 ? 'auto' : 'no-hide-descendants'} aria-hidden={index !== 1}>{right}</View>
      </Animated.View>
    </View>
  );
}

/** 候補5 スワイプ往復: 上のセグメントとスワイプで箱庭⇄学ぶ。下タブなし。手帳とお店は上のボタンから出るシート */
export function Variant5({ ctx, tab, setTab, sheet, setSheet }: VariantProps) {
  const index = tab === 'learn' ? 1 : 0;
  const progress = useRef(new Animated.Value(index)).current;
  return (
    <View style={{ flexGrow: 1, flexBasis: 120 }}>
      <Segmented
        labels={['箱庭', '学ぶ']}
        active={index}
        progress={progress}
        onSelect={(i) => setTab(i === 1 ? 'learn' : 'home')}
        right={
          <View style={{ flexDirection: 'row' }}>
            <HeaderButton label="手帳" onPress={() => setSheet('notebook')} />
            <HeaderButton label="お店" onPress={() => setSheet('shop')} />
          </View>
        }
      />
      <Pager
        index={index}
        progress={progress}
        onIndex={(i) => setTab(i === 1 ? 'learn' : 'home')}
        left={<TabScreen kind="home" ctx={ctx} extraBottom={ctx.bottomInset} />}
        right={<TabScreen kind="learn" ctx={ctx} extraBottom={ctx.bottomInset} />}
      />
      <BottomSheet visible={sheet === 'notebook'} title="手帳" onClose={() => setSheet(null)} bottomInset={ctx.bottomInset}>
        <TabScreen kind="notebook" ctx={ctx} />
      </BottomSheet>
      <BottomSheet visible={sheet === 'shop'} title="お店" onClose={() => setSheet(null)} bottomInset={ctx.bottomInset}>
        <TabScreen kind="shop" ctx={ctx} />
      </BottomSheet>
    </View>
  );
}

export const VARIANT_COMPONENTS = [Variant1, Variant2, Variant3, Variant4, Variant5] as const;

const styles = StyleSheet.create({
  studyCard: { backgroundColor: C.card, borderTopWidth: 1.5, borderTopColor: C.line, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, gap: 8 },
  // 大きな文字では実の表示が下の行へ回り、資格名を省略しない（横→縦の組み替え）
  studyTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4, minHeight: 28 },
  studyQual: { ...T.head, flexGrow: 1, flexShrink: 1, flexBasis: 160, fontSize: 17, lineHeight: 24, color: C.ink },
  studyFruit: { ...T.head, fontSize: 15, lineHeight: 21, color: C.ink, backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.line, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 2 },
  studyBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
