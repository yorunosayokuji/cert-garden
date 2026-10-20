import { useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotion } from './motion';
import { C, T } from './theme';

interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'quiet';
  hint?: string;
  style?: StyleProp<ViewStyle>;
}

const SHADOW = 3;
const PRESS = 2;

/**
 * 最低48px。2px枠と下辺の影(3px)は常に同じ寸法で、押すと面が2px下がり影が減る。離すと120msで戻る。
 * 面の移動は transform だけなのでレイアウトは動かない。reduce時は即時に切り替える。
 */
export function Button({ label, onPress, disabled, kind = 'primary', hint, style }: ButtonProps) {
  const reduce = useReduceMotion();
  const down = useRef(new Animated.Value(0)).current;
  const primary = kind === 'primary';
  const quiet = kind === 'quiet';
  const edge = disabled ? C.line : primary ? C.accentDark : C.line;
  const move = (to: number, ms: number) => {
    if (reduce) down.setValue(to);
    else Animated.timing(down, { toValue: to, duration: ms, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  };
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={!!disabled}
      onPressIn={() => !disabled && move(1, 40)}
      onPressOut={() => move(0, 120)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.wrap, style]}
    >
      {!quiet ? <View pointerEvents="none" style={[styles.shadow, { backgroundColor: edge }]} /> : null}
      <Animated.View
        style={[
          styles.face,
          primary ? styles.facePrimary : kind === 'secondary' ? styles.faceSecondary : styles.faceQuiet,
          disabled && styles.faceDisabled,
          !quiet && { transform: [{ translateY: down.interpolate({ inputRange: [0, 1], outputRange: [0, PRESS] }) }] },
        ]}
      >
        <Text style={[styles.btnText, primary && !disabled && { color: C.accentText }, disabled && { color: C.disabledInk }]}>{label}</Text>
      </Animated.View>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.h}>
      {children}
    </Text>
  );
}

/** 本文 16/24 regular、補助 13/19 */
export function Body({ children, sub }: { children: ReactNode; sub?: boolean }) {
  return <Text style={[styles.body, sub && styles.sub]}>{children}</Text>;
}

export const styles = StyleSheet.create({
  wrap: { minHeight: 48 + SHADOW, minWidth: 48, paddingBottom: SHADOW },
  shadow: { position: 'absolute', left: 0, right: 0, top: SHADOW, bottom: 0, borderRadius: 16 },
  face: { minHeight: 48, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  facePrimary: { backgroundColor: C.accent, borderColor: C.accentDark },
  faceSecondary: { backgroundColor: C.card, borderColor: C.line },
  faceQuiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
  faceDisabled: { backgroundColor: C.disabled, borderColor: C.line },
  btnText: { ...T.button, fontSize: 17, lineHeight: 24, color: C.ink },
  card: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1.5, borderColor: C.line, padding: 16, gap: 8 },
  h: { ...T.head, fontSize: 20, lineHeight: 28, color: C.ink },
  body: { ...T.body, fontSize: 16, lineHeight: 24, color: C.ink },
  sub: { color: C.sub, fontSize: 13, lineHeight: 19 },
});
