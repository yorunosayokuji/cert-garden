import { useCallback, useEffect, useState } from 'react';
import type { CharMotion } from '../state/roomMotion';
import { clipsReady, ensureClips, warmClips } from './motionCatalog';

export type ClipsStatus = 'loading' | 'ready' | 'error';

/**
 * 選んだ個体のクリップの画像が実際にそろうまで 'loading'。そろったら 'ready'、失敗したら 'error'（retry で再試行）。
 * 'ready' になるまで呼び出し側は時計を進めない。別の個体の絵で代替しない。次に使うクリップは待たずに用意だけしておく。
 * 同期的に判定できる（すでに用意済み）ときは、最初の描画から 'ready'。
 */
export function useClipsReady(chars: CharMotion[], required: (c: CharMotion) => string[], next: (c: CharMotion) => string[] = () => []): { status: ClipsStatus; retry: () => void } {
  const key = chars.map((c) => `${c.id}:${required(c).join('+')}`).join('|');
  const allReady = () => chars.every((c) => clipsReady(c, required(c)));
  const [status, setStatus] = useState<ClipsStatus>(() => (allReady() ? 'ready' : 'loading'));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    if (allReady()) {
      setStatus('ready');
    } else {
      setStatus('loading');
      Promise.all(chars.map((c) => ensureClips(c, required(c)))).then(
        () => alive && setStatus('ready'),
        () => alive && setStatus('error'),
      );
    }
    chars.forEach((c) => warmClips(c, next(c)));
    return () => {
      alive = false; // 個体の切替・画面を離れたときに古い結果を反映しない
    };
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // 個体が替わった直後の描画でも、前の個体の「ready」を引きずらない
  const effective: ClipsStatus = status === 'ready' && !allReady() ? 'loading' : status;
  return { status: effective, retry };
}
