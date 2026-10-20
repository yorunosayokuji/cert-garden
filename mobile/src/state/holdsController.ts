import { useCallback, useEffect, useMemo, useState } from 'react';
import { QuestionHolds, type Hold, type QuestionRef, type Report, type ReportReason } from '../../../src/mobile.ts';
import { KvHoldStorage } from './holdStore.ts';
import { LearnPrefsStore } from './learnPrefs.ts';
import type { KeyValue } from './kv.ts';

/** 保留・報告（この端末だけ）。エンジンは1つを学習・診断と共有する。保存に失敗したら通知し、状態は変えない */
export function useHolds(kv: KeyValue, onNotice: (message: string, retry?: () => void) => void) {
  const engine = useMemo(() => new QuestionHolds({ storage: new KvHoldStorage(kv), clock: { now: Date.now } }), [kv]);
  const [tick, setTick] = useState(0);
  const [corrupt, setCorrupt] = useState(false);

  useEffect(() => {
    let alive = true;
    engine.load().then(
      (r) => {
        if (!alive) return;
        setCorrupt(r.corrupt);
        setTick((t) => t + 1);
        if (r.corrupt) onNotice('問題の記録・保留の保存データを読めません。データはそのまま残し、保留は効かない状態です。');
      },
      () => alive && onNotice('問題の記録・保留を読み込めませんでした。'),
    );
    return () => {
      alive = false;
    };
  }, [engine, onNotice]);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      const r = await fn();
      setTick((t) => t + 1);
      return r;
    } catch (e) {
      const m = e instanceof Error ? e.message : '保存できませんでした。';
      onNotice(m, undefined);
      return null;
    }
  }, [onNotice]);

  return {
    engine, corrupt, tick,
    holds: (): Hold[] => engine.list(),
    reports: (): Report[] => engine.reports(),
    hold: useCallback((ref: QuestionRef) => run(() => engine.hold(ref)), [engine, run]),
    release: useCallback((questionId: string) => run(() => engine.release(questionId)), [engine, run]),
    report: useCallback((ref: QuestionRef, reason: ReportReason, memo: string, hold: boolean) => run(() => engine.report(ref, reason, memo, hold)), [engine, run]),
  };
}

/** 学ぶ画面で最後に選んだ資格。ここで選んだ資格を保存し、次に開いたときもその資格とテーマを先に見せる */
export function useLearnQual(kv: KeyValue) {
  const store = useMemo(() => new LearnPrefsStore(kv), [kv]);
  const [qual, setQualState] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    store.load().then((q) => alive && setQualState(q), () => alive && setQualState('it-passport'));
    return () => {
      alive = false;
    };
  }, [store]);
  const setQual = useCallback((q: string) => {
    setQualState(q);
    void store.save(q).catch(() => undefined); // 見た目の設定。保存できなくても学習には影響しない
  }, [store]);
  return { qual, setQual };
}
