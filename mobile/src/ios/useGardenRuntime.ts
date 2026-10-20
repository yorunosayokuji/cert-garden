import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerMode } from '../../../src/mobile.ts';
import { useController } from '../state/controller';
import { useDiagnostic } from '../state/diagnosticController';
import { useHolds, useLearnQual } from '../state/holdsController';
import { useLayout } from '../state/layoutController';
import type { KeyValue } from '../state/kv.ts';
import { useOsReduceMotion } from '../ui/hooks';
import { hapticSuccess, hapticTap } from './haptics';

/**
 * 既存の本体(App.tsx)と同じ配線を、渡された KeyValue（＝名前空間で隔離した保存）に対して組む。
 * 学習・採点・報酬は本体と同じ StudyCore を使い、比較用の別実装や偽データは作らない。
 */
export function useGardenRuntime(kv: KeyValue) {
  const noticeRef = useRef<(message: string, retry?: () => void) => void>(() => undefined);
  const onNotice = useCallback((message: string, retry?: () => void) => noticeRef.current(message, retry), []);
  const holds = useHolds(kv, onNotice);
  const c = useController(kv, Date.now, undefined, holds.engine);
  const { setNotice } = c;
  noticeRef.current = (message, retry) => setNotice({ message, ...(retry ? { retry } : {}) });
  const diag = useDiagnostic(kv, onNotice, holds.engine);
  const learnQual = useLearnQual(kv);
  void holds.tick;
  const furniture = useLayout(kv, useCallback((m: string) => onNotice(m), [onNotice]));
  const osReduce = useOsReduceMotion();
  const reduceMotion = osReduce || c.settings.reduceMotion;

  // 設問を開く準備中（コアの開始〜問題が出るまで）。スケルトンの出し分けに使う
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const begin = useCallback(async (fn: () => Promise<void>) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    hapticTap();
    try {
      await fn();
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, []);
  const startLearn = useCallback((q?: string, t?: string, m?: AnswerMode) => begin(() => c.startLearn(q, t, m)), [begin, c.startLearn]);
  const startReview = useCallback((q?: string, m?: AnswerMode) => begin(() => c.startReview(q, m)), [begin, c.startReview]);

  // 正解・励ましの反応で触覚（実機のiOSのみ。連続は間引く）
  // 誤答・「わからない」(encourage)では鳴らさない（動物にも本人にも害を与えない）
  const seq = c.reaction?.seq;
  const cue = c.reaction?.cue;
  useEffect(() => {
    if (seq && (cue === 'cheer' || cue === 'celebrate')) hapticSuccess();
  }, [seq, cue]);

  return { c, holds, diag, learnQual, furniture, reduceMotion, starting, startLearn, startReview };
}

export type GardenRuntime = ReturnType<typeof useGardenRuntime>;
