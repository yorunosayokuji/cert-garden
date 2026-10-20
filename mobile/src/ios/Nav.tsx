import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotion } from '../ui/motion';
import { C, T } from '../ui/theme';
import { hapticSelect } from './haptics';
import { MOTION, PressScale } from './Press';

export interface TabDef<K extends string> {
  id: K;
  label: string;
}

/** 選択枠の色を140msで切り替える（動きを減らす時は即時）。layout は変えない */
function useSelectValue(on: boolean): Animated.Value {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    v.stopAnimation();
    if (reduce) v.setValue(on ? 1 : 0);
    else Animated.timing(v, { toValue: on ? 1 : 0, duration: MOTION.select, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [on, reduce, v]);
  return v;
}

function TabItem({ label, on, onPress, kind }: { label: string; on: boolean; onPress: () => void; kind: 'tab' | 'button' }) {
  const v = useSelectValue(on);
  const bg = v.interpolate({ inputRange: [0, 1], outputRange: ['rgba(234,242,222,0)', C.chosenBg] });
  const border = v.interpolate({ inputRange: [0, 1], outputRange: ['rgba(63,106,49,0)', C.accentDark] });
  return (
    <PressScale
      role={kind}
      label={label}
      state={kind === 'tab' ? { selected: on } : undefined}
      onPress={() => {
        if (!on) hapticSelect();
        onPress();
      }}
      style={styles.tab}
    >
      <Animated.View style={[styles.pill, { backgroundColor: bg, borderColor: border }]}>
        <Text maxFontSizeMultiplier={1.5} style={[styles.tabText, on && { color: C.accentDark }]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </PressScale>
  );
}

interface TabBarProps<K extends string> {
  tabs: readonly TabDef<K>[];
  active: K;
  onChange: (id: K) => void;
  /** 浮かせる(候補2)。丸いカプセルで、下端の安全領域の上に余白を空けて重なる */
  floating?: boolean;
  bottomInset: number;
}

/**
 * 下のタブ。各タブは44pt以上の領域で、片手の親指が届く下端に置く。下端はホームバーの安全領域を避ける。
 * 浮かせる時の面は読みやすさのため不透明寄り（Webのぼかしは近似で、iOS実機のガラス素材とは別）。
 */
export function TabBar<K extends string>({ tabs, active, onChange, floating, bottomInset }: TabBarProps<K>) {
  return (
    <View
      role="tablist"
      accessibilityRole="tablist"
      style={floating ? [styles.floatWrap, { bottom: Math.max(bottomInset, 8) + 4 }] : [styles.bar, { paddingBottom: Math.max(bottomInset, 4) }]}
    >
      <View style={floating ? styles.floatBar : styles.row}>
        {tabs.map((t) => (
          <TabItem key={t.id} label={t.label} on={t.id === active} kind="tab" onPress={() => onChange(t.id)} />
        ))}
      </View>
    </View>
  );
}

/** 上のセグメント（候補5）。インジケーターは外から渡す進み具合(0..1)に追従し、指のスワイプと同期する */
export function Segmented({ labels, active, progress, onSelect, right }: { labels: readonly string[]; active: number; progress: Animated.Value; onSelect: (i: number) => void; right?: ReactNode }) {
  const [w, setW] = useState(0);
  const segW = labels.length ? w / labels.length : 0;
  return (
    <View style={styles.segRow}>
      <View role="tablist" accessibilityRole="tablist" style={styles.seg} onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width) - 6)}>
        {segW > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.segThumb, { width: segW, transform: [{ translateX: progress.interpolate({ inputRange: [0, labels.length - 1], outputRange: [0, segW * (labels.length - 1)] }) }] }]}
          />
        ) : null}
        {labels.map((l, i) => (
          <PressScale
            key={l}
            role="tab"
            label={l}
            state={{ selected: active === i }}
            onPress={() => {
              if (active !== i) hapticSelect();
              onSelect(i);
            }}
            style={styles.segItem}
          >
            <Text maxFontSizeMultiplier={1.5} style={[styles.segText, active === i && { color: C.ink }]}>{l}</Text>
          </PressScale>
        ))}
      </View>
      {right}
    </View>
  );
}

/** 補助機能を開く丸い文字ボタン（候補4/5のヘッダー）。44pt以上 */
export function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <PressScale label={label} onPress={() => { hapticSelect(); onPress(); }} style={styles.headerBtn}>
      <Text maxFontSizeMultiplier={1.5} style={styles.headerBtnText}>{label}</Text>
    </PressScale>
  );
}

export function HeaderBar({ title, children, style }: { title?: string; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.header, style]}>
      {title ? <Text accessibilityRole="header" style={styles.headerTitle}>{title}</Text> : <View />}
      <View style={{ flexDirection: 'row', gap: 4 }}>{children}</View>
    </View>
  );
}

const glass = Platform.select({ web: { backdropFilter: 'blur(14px) saturate(1.3)' } as object, default: {} });

const styles = StyleSheet.create({
  bar: { backgroundColor: C.card, borderTopWidth: 1.5, borderTopColor: C.line, paddingTop: 4 },
  row: { flexDirection: 'row' },
  floatWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'stretch' },
  floatBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,250,240,0.92)',
    borderRadius: 32,
    borderWidth: 1.5,
    borderColor: C.line,
    paddingHorizontal: 6,
    paddingVertical: 4,
    ...glass,
  },
  tab: { flex: 1, minHeight: 49 },
  pill: { minHeight: 40, minWidth: 64, paddingHorizontal: 14, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  tabText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.sub },
  segRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.bg },
  seg: { flex: 1, flexDirection: 'row', minHeight: 44, borderRadius: 14, backgroundColor: '#e7dcc3', padding: 3 },
  segThumb: { position: 'absolute', left: 3, top: 3, bottom: 3, borderRadius: 11, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.accentDark },
  segItem: { flex: 1, minHeight: 44 - 6 },
  segText: { ...T.button, fontSize: 17, lineHeight: 24, color: C.sub },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8, backgroundColor: C.bg },
  headerTitle: { ...T.head, fontSize: 22, lineHeight: 30, color: C.ink },
  headerBtn: { minWidth: 56, minHeight: 44, paddingHorizontal: 8 },
  headerBtnText: { ...T.button, fontSize: 17, lineHeight: 24, color: C.accentDark },
});
