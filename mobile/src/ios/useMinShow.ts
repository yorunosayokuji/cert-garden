import { useEffect, useRef, useState } from 'react';
import { minShowRemaining, minShowVisible } from './compare.ts';

/**
 * 比較用の最低表示。trigger が変わるたびに計り直し、実際の準備(real)が続く間は必ず表示、
 * 終わっていても開始から delayMs 未満なら表示を続ける。delayMs=0 なら実際の準備だけで決まる（待ちを足さない）。
 * trigger が null の間は何も表示しない。nonce を変えると同じ trigger でも計り直す（再生ボタン）。
 */
export function useMinShow(trigger: string | null, real: boolean, delayMs: number, nonce = 0): boolean {
  const key = trigger === null ? null : `${trigger}#${nonce}`;
  const ref = useRef<{ key: string | null; at: number | null }>({ key: null, at: null });
  if (ref.current.key !== key) ref.current = { key, at: key === null ? null : Date.now() };
  const [, force] = useState(0);
  const at = ref.current.at;
  const visible = key !== null && minShowVisible(at, real, Date.now(), delayMs);
  useEffect(() => {
    if (real || !visible) return;
    const t = setTimeout(() => force((n) => n + 1), minShowRemaining(at, Date.now(), delayMs) + 20);
    return () => clearTimeout(t);
  }, [real, visible, at, delayMs, key]);
  return visible;
}
