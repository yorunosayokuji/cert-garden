import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

/** アプリが前面にある間だけ true。背景・非表示では演出の timer を止める */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** 表示用の「いま」。intervalMs ごとにだけ更新する（1秒ごとの再描画や書込みはしない）。非表示の間は止める */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  const active = useAppActive();
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** OS の「動きを減らす」設定 */
export function useOsReduceMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setOn(v)).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}
