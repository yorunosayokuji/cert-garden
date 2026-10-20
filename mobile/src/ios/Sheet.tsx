import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, BackHandler, Easing, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useReduceMotion } from '../ui/motion';
import { C, T } from '../ui/theme';
import { hapticSelect } from './haptics';
import { MOTION, NATIVE_DRIVER, PressScale } from './Press';
import { focusablesIn, inertOutside, trapTab } from './webFocus';

interface Props {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 下端の安全領域（ホームバー）の高さ */
  bottomInset?: number;
}

const CLOSE_DRAG = 90;

/**
 * 下から出るシート。閉じる方法: 閉じるボタン・背景のタップ・持ち手/見出しを下へ払う・Esc(Web)・端末の戻る(Android)。
 * 開閉は240msの位置移動で、途中で逆向きの操作をしても現在位置から動く（中断できる）。動きを減らす時は即切り替え。
 * 中身（手帳・お店）は閉じても保存データを消さない。
 */
export function BottomSheet({ visible, title, onClose, children, bottomInset = 0 }: Props) {
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const [h, setH] = useState(600);
  const y = useRef(new Animated.Value(visible ? 0 : 600)).current;
  const closingRef = useRef(false);

  useEffect(() => {
    y.stopAnimation();
    if (visible) {
      closingRef.current = false;
      if (!mounted) y.setValue(h);
      setMounted(true);
      if (reduce) y.setValue(0);
      else Animated.timing(y, { toValue: 0, duration: MOTION.sheet, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE_DRIVER }).start();
    } else if (mounted) {
      closingRef.current = true;
      if (reduce) {
        y.setValue(h);
        setMounted(false);
      } else {
        Animated.timing(y, { toValue: h, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE_DRIVER }).start(({ finished }) => {
          if (finished && closingRef.current) setMounted(false);
        });
      }
    }
    // mounted は閉じ終わりの判定にだけ使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduce]);

  const close = useCallback(() => {
    hapticSelect();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!visible) return;
    if (Platform.OS === 'web') {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close();
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [visible, close]);

  // Web: 開いたら中へ焦点を移し、Tab を中で一周させ、背景を操作停止にし、閉じたら開く前の位置へ焦点を戻す
  const sheetEl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || !mounted) return;
    const el = sheetEl.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const restoreInert = inertOutside(el);
    el.setAttribute('tabindex', '-1');
    (focusablesIn(el)[0] ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => trapTab(el, e);
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      restoreInert();
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [visible, mounted]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_, g) => {
          if (g.dy > CLOSE_DRAG || g.vy > 0.9) close();
          else Animated.timing(y, { toValue: 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE_DRIVER }).start();
        },
        onPanResponderTerminate: () => {
          Animated.timing(y, { toValue: 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE_DRIVER }).start();
        },
      }),
    [y, close],
  );

  if (!mounted) return null;
  const backdrop = y.interpolate({ inputRange: [0, Math.max(h, 1)], outputRange: [1, 0], extrapolate: 'clamp' });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" onLayout={(e) => setH(Math.max(240, Math.round(e.nativeEvent.layout.height * 0.9)))}>
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(40,30,20,0.42)', opacity: backdrop }]}
        {...(Platform.OS === 'web' ? ({ dataSet: { keep: '1' } } as object) : null)}
      >
        {/* 背景のタップで閉じる面。キーボードの移動先には含めない(閉じるボタンが別にある) */}
        <Pressable style={StyleSheet.absoluteFill} onPress={close} focusable={false} accessibilityRole="button" accessibilityLabel={`${title}をとじる`} />
      </Animated.View>
      <Animated.View
        ref={(n: unknown) => {
          sheetEl.current = n as HTMLElement | null;
        }}
        style={[styles.sheet, { height: h, transform: [{ translateY: y }] }]}
        accessibilityViewIsModal
        accessible={false}
        {...(Platform.OS === 'web' ? ({ role: 'dialog', 'aria-modal': true, 'aria-label': title } as object) : null)}
      >
        <View {...pan.panHandlers} style={styles.head}>
          <View style={styles.grabber} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={styles.headRow}>
            <Text accessibilityRole="header" style={styles.title}>{title}</Text>
            <PressScale label={`${title}をとじる`} onPress={close} style={styles.closeBtn}>
              <Text style={styles.closeText}>とじる</Text>
            </PressScale>
          </View>
        </View>
        <View style={{ flex: 1, paddingBottom: bottomInset }}>{children}</View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: C.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', borderTopWidth: 1.5, borderColor: C.line },
  head: { paddingTop: 8, paddingHorizontal: 16, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.card },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 6 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48 },
  title: { ...T.head, fontSize: 18, lineHeight: 26, color: C.ink },
  closeBtn: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { ...T.button, fontSize: 16, lineHeight: 22, color: C.accentDark },
});
