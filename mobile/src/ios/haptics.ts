// 触覚フィードバック。実機のiOSだけで動く（Webでは何もしない＝鳴った/震えたと見せない）。連続で鳴らしすぎない。
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

let last = 0;
const MIN_GAP_MS = 60;

function run(fn: () => Promise<void>): void {
  if (Platform.OS !== 'ios') return;
  const now = Date.now();
  if (now - last < MIN_GAP_MS) return;
  last = now;
  fn().catch(() => undefined);
}

/** タブ・選択の切り替え */
export const hapticSelect = () => run(() => Haptics.selectionAsync());
/** 押した感触（ボタン） */
export const hapticTap = () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
/** 正解・保存の成功 */
export const hapticSuccess = () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
