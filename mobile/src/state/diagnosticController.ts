import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoreError, DiagnosticEngine, type DiagResult, type DiagView, type QuestionHolds } from '../../../src/mobile.ts';
import { KvDiagStorage } from './diagnosticStore.ts';
import type { KeyValue } from './kv.ts';
import { createContent, themesOf } from './learningPack.ts';
import { friendlyMessage } from './controller.ts';


/** 用意した基礎テーマ（既存のビット列の見本テーマは含めない） */
export const foundationThemeIds = (qualificationId: string) => themesOf(qualificationId).filter((t) => t.kind === 'foundation').map((t) => t.themeId);

export interface QualSummary {
  latest?: DiagResult;
  dismissed: boolean;
  active: boolean;
}

/** 資格ごとの初回チェック。学習コアの hook とは分け、状態・保存も別。実・ポイント・完了テーマには触れない */
export function useDiagnostic(kv: KeyValue, onNotice: (message: string, retry?: () => void) => void, holds?: QuestionHolds) {
  // 新しく作るチェックは保留を除く。進行中のチェックは保留しても続けられる（rawContent）
  const engine = useMemo(
    () => new DiagnosticEngine({ storage: new KvDiagStorage(kv), content: createContent(holds), rawContent: createContent(), clock: { now: Date.now } }),
    [kv, holds],
  );
  const [ready, setReady] = useState(false);
  const [corrupt, setCorrupt] = useState(false);
  const [tick, setTick] = useState(0);
  const [qual, setQual] = useState<string | null>(null);
  const [view, setView] = useState<DiagView>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const qualRef = useRef<string | null>(null);
  qualRef.current = qual;

  useEffect(() => {
    let alive = true;
    engine.load().then(
      (r) => {
        if (!alive) return;
        setCorrupt(r.corrupt);
        setReady(true);
        if (r.corrupt) onNotice('初回チェックの保存データを読めません。データはそのまま残し、チェックは使えない状態です。');
      },
      () => alive && (setReady(true), setCorrupt(true), onNotice('初回チェックの保存を読み込めませんでした。')),
    );
    return () => {
      alive = false;
    };
  }, [engine, onNotice]);

  const summary = useCallback((q: string): QualSummary => {
    const s = engine.getQual(q);
    return { ...(s.latest ? { latest: s.latest } : {}), dismissed: s.dismissed === true, active: !!s.active };
  }, [engine, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 二重押下を防ぎ、失敗は画面の通知にする（保存失敗は再試行できる） */
  const run = useCallback(async (fn: () => Promise<DiagView | void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const v = await fn();
      if (v) setView(v);
      setTick((t) => t + 1);
    } catch (e) {
      if (e instanceof CoreError && e.code === 'STALE_STEP') {
        const q = qualRef.current;
        if (q) setView(await engine.view(q).catch(() => ({ kind: 'none' }) as DiagView));
      } else {
        onNotice(friendlyMessage(e), e instanceof CoreError && e.code === 'STORAGE_WRITE_FAILED' ? () => void run(fn) : undefined);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [engine, onNotice]);

  const stepOf = (v: DiagView) => (v.kind === 'question' ? v.step : -1);

  return {
    ready, corrupt, qual, view, busy, summary, tick,
    /** チェック画面を開く。進行中があれば続き、結果があれば結果を見せる。開始は start */
    open: useCallback((q: string) => void run(async () => {
      setQual(q);
      qualRef.current = q;
      return engine.view(q);
    }), [engine, run]),
    start: useCallback((q: string) => void run(async () => {
      setQual(q);
      qualRef.current = q;
      return engine.start(q, foundationThemeIds(q));
    }), [engine, run]),
    select: useCallback((optionId: string) => void run(() => engine.select(qualRef.current!, stepOf(view), optionId)), [engine, run, view]),
    confirm: useCallback(() => void run(() => engine.confirm(qualRef.current!, stepOf(view))), [engine, run, view]),
    dontKnow: useCallback(() => void run(() => engine.dontKnow(qualRef.current!, stepOf(view))), [engine, run, view]),
    next: useCallback(() => void run(() => engine.next(qualRef.current!, stepOf(view))), [engine, run, view]),
    /** 画面を閉じる。進行中はそのまま保存され、あとで続きから */
    close: useCallback(() => {
      setQual(null);
      setView({ kind: 'none' });
    }, []),
    /** 進行中のチェックをやめる（前の結果は残す） */
    abandon: useCallback((q: string) => void run(async () => {
      await engine.abandon(q);
      setQual(null);
      return { kind: 'none' } as DiagView;
    }), [engine, run]),
    dismiss: useCallback((q: string) => void run(() => engine.dismiss(q)), [engine, run]),
  };
}
