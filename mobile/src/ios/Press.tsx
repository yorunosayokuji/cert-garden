import { useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, Pressable, type AccessibilityState, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotion } from '../ui/motion';

/** Web は JS 駆動、native は UI スレッド駆動（opacity/transform のみ）。 */
export const NATIVE_DRIVER = Platform.OS !== 'web';

export const MOTION = {
  /** 押下 */ press: 110,
  /** 選択枠 */ select: 140,
  /** 画面移動 */ screen: 220,
  /** シート */ sheet: 240,
  /** 正解・保存の反応 */ feedback: 180,
  /** 進捗 */ progress: 180,
  /** 報酬 */ reward: 300,
} as const;

interface Props {
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  label: string;
  hint?: string;
  role?: 'button' | 'tab' | 'radio' | 'link';
  state?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  /** 押下の縮小率。既定 0.97 */
  scaleTo?: number;
  hitSlop?: number;
}

/**
 * 押下で 110ms / 0.97 に縮む（opacity/transform のみ）。離す・別の押下でも現在値から動くので途中で止められる。
 * 動きを減らす時は縮めない。最低の操作領域 44pt は呼び出し側の style(minHeight/minWidth) で確保する。
 */
export function PressScale({ onPress, onLongPress, disabled, label, hint, role = 'button', state, style, children, scaleTo = 0.97, hitSlop }: Props) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(1)).current;
  const go = (to: number) => {
    v.stopAnimation();
    if (reduce) v.setValue(1);
    else Animated.timing(v, { toValue: to, duration: MOTION.press, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE_DRIVER }).start();
  };
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      onPressIn={() => !disabled && go(scaleTo)}
      onPressOut={() => go(1)}
      disabled={!!disabled}
      // native は accessibilityRole/State。React Native Web 0.21 は accessibilityState を DOM の aria-* にしないので、
      // role と aria-selected / aria-checked / aria-disabled も明示して実DOMで選択状態を伝える
      role={role}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, ...state }}
      aria-label={label}
      aria-disabled={!!disabled}
      {...(state?.selected !== undefined ? { 'aria-selected': state.selected } : null)}
      {...(state?.checked !== undefined ? { 'aria-checked': state.checked as boolean } : null)}
      hitSlop={hitSlop}
      style={style}
    >
      <Animated.View style={{ transform: [{ scale: v }], alignItems: 'center', justifyContent: 'center', flexGrow: 1, alignSelf: 'stretch' }}>{children}</Animated.View>
    </Pressable>
  );
}
