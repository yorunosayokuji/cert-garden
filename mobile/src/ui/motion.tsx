import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

/** OS設定 + アプリ設定の「動きを減らす」。true の間は transition も静止にする（意味と表示は残す） */
export const ReduceMotionContext = createContext(false);
export const useReduceMotion = () => useContext(ReduceMotionContext);

/** 新しい内容だけ opacity + 横dx から ease-out で現れる。key を変えると再生。reduce 時は即表示 */
export function Reveal({ children, ms = 180, dx = 8, style }: { children: ReactNode; ms?: number; dx?: number; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    const a = Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.out(Easing.quad), useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [reduce, ms, v]);
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) }] }]}>{children}</Animated.View>
  );
}

/** 進捗バー。値の変化を 200ms で追う */
export function AnimatedFill({ pct, style }: { pct: number; style: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(pct);
      return;
    }
    const a = Animated.timing(v, { toValue: pct, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [pct, reduce, v]);
  return <Animated.View style={[style, { width: v.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }]} />;
}
