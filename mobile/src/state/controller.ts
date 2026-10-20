import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createContent } from './learningPack.ts';
import { defOf, isStarter } from './furniture.ts';
import {
  CoreError, StudyCore, codes,
  type AnswerMode, type MissionKind, type QuestionHolds, type QuestionRef, type CompletionResult, type CoreEvent, type GardenSnapshot, type StageView,
} from '../../../src/mobile.ts';
import { KvStorage } from './kvStorage.ts';
import type { KeyValue } from './kv.ts';
import { DEFAULT_SETTINGS, NotebookStore, SettingsStore, type NotebookEntry, type Settings } from './notebook.ts';
import { useAppActive } from '../ui/hooks';
import type { Reaction } from '../ui/MotionSprite';
import { DEFAULT_ROOM, RoomStore, type RoomId } from './room.ts';
import { RosterStore, defaultRoster, setCompanion as rosterSetCompanion, setSlot as rosterSetSlot, type Roster } from './roster.ts';
import type { CharacterId } from './characters.ts';

export const QUAL_ID = 'it-passport';
export const THEME_ID = 'bit-patterns';

export interface Session {
  stageId: string;
  kind: 'learn' | 'review';
  qualificationId: string;
  view: StageView;
  title: string;
  intro: string;
  explanation: string[];
  hint: string | null;
  result: StageResult | null;
}

export interface StageResult {
  correct: number;
  total: number;
  activeSeconds: number;
  pointsAwarded: number;
  totalPoints: number;
  duplicate: boolean;
  nextReviewDate: string | null;
  kind: 'learn' | 'review';
}

export interface Notice {
  message: string;
  retry?: () => void;
}

/** コアのエラーをユーザー向けの短い文にする（内部コードやイベント名は出さない） */
export function friendlyMessage(e: unknown): string {
  if (e instanceof CoreError) {
    switch (e.code) {
      case codes.themeOnHold: return e.message;
      case codes.insufficientPoints: return 'ポイントがたりません。学習でためられます（この試作の仮ポイントです）。';
      case codes.noFruits: return '知恵の実がありません。無料の復習ならできます。';
      case codes.nothingToReview: return 'まだ復習できるテーマがありません。学習を終えると使えます。';
      case codes.activeStageExists: return 'ほかに途中の学習があります。先に続きから進めてください。';
      case codes.storageWrite: return '保存できませんでした。もう一度ためせます。';
      case codes.corruptStorage: return '保存データを読めません。データはそのまま残してあります。';
      case codes.staleContent: return '教材が新しくなったため、途中の学習は続けられません。';
      case codes.contentLoad: case codes.contentInvalid: return '教材を読み込めませんでした。';
      default: return e.message;
    }
  }
  return e instanceof Error ? e.message : 'うまくいきませんでした。';
}

export type Boot = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready' };

export function useController(kv: KeyValue, now: () => number = Date.now, newId?: () => string, holds?: QuestionHolds) {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [snapshot, setSnapshot] = useState<GardenSnapshot | null>(null);
  const [resumable, setResumable] = useState<{ stageId: string; kind: 'learn' | 'review'; qualificationId: string; themeId: string } | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [reaction, setReaction] = useState<Reaction | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [room, setRoom] = useState<RoomId>(DEFAULT_ROOM);
  const [notebook, setNotebook] = useState<NotebookEntry[]>([]);
  const [notebookError, setNotebookError] = useState<string | null>(null);
  const [roster, setRoster] = useState<Roster>(() => defaultRoster());
  const rosterRef = useRef<Roster>(roster);
  const rosterCorruptRef = useRef(false);
  const coreRef = useRef<StudyCore | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const busyRef = useRef(false);
  const seqRef = useRef(0);
  const bgSeqRef = useRef(0);
  const active = useAppActive();
  sessionRef.current = session;

  const notebookStore = useMemo(() => new NotebookStore(kv), [kv]);
  const settingsStore = useMemo(() => new SettingsStore(kv), [kv]);
  const roomStore = useMemo(() => new RoomStore(kv), [kv]);
  const rosterStore = useMemo(() => new RosterStore(kv), [kv]);

  const refresh = useCallback(() => {
    const core = coreRef.current;
    if (!core) return;
    setSnapshot(core.getGardenSnapshot());
    const r = core.findResumable();
    setResumable(r ? { stageId: r.id, kind: r.kind, qualificationId: r.qualificationId, themeId: r.themeId } : null);
  }, []);

  const load = useCallback(async () => {
    setBoot({ kind: 'loading' });
    try {
      // 保留の保存を先に読む（壊れていても学習は始められる。保留が効かないだけで、保存は書き換えない）
      if (holds) await holds.load().catch(() => undefined);
      const core = await StudyCore.open({ storage: new KvStorage(kv), content: createContent(holds), clock: { now }, ...(newId ? { newId } : {}) });
      core.subscribe((ev: CoreEvent) => {
        if (ev.type === 'answer_correct' || ev.type === 'encouragement' || ev.type === 'stage_completed') {
          seqRef.current += 1;
          setReaction({ cue: ev.cue, seq: seqRef.current });
        }
      });
      coreRef.current = core;
      // 閉じている間の時間を端末の時計で数える（1回だけ。同じ時刻なら二重に回復しない）
      void core.refreshClock().then(() => refresh(), () => undefined);
      refresh();
      let legacyCompanion: string | undefined;
      try {
        const loaded = await settingsStore.load();
        legacyCompanion = loaded.companion;
        setSettings(loaded);
      } catch {
        setNotice({ message: '設定を読めなかったので、標準の設定で表示しています。' });
      }
      try {
        const r = await rosterStore.load(legacyCompanion);
        rosterCorruptRef.current = r.corrupt;
        rosterRef.current = r.roster;
        setRoster(r.roster);
        if (r.corrupt) setNotice({ message: '同室の編成の保存データを読めません。保存データはそのまま残し、標準の編成で表示しています。' });
      } catch {
        rosterRef.current = defaultRoster(legacyCompanion);
        rosterCorruptRef.current = true;
        setRoster(rosterRef.current);
        setNotice({ message: '同室の編成を読み込めませんでした。標準の編成で表示しています。' });
      }
      try {
        setRoom(await roomStore.load());
      } catch {
        setRoom(DEFAULT_ROOM);
      }
      try {
        setNotebook(await notebookStore.load());
        setNotebookError(null);
      } catch (e) {
        setNotebookError(e instanceof Error ? e.message : '手帳のデータを読めません');
      }
      setBoot({ kind: 'ready' });
    } catch (e) {
      setBoot({ kind: 'error', message: friendlyMessage(e) });
    }
  }, [kv, now, newId, holds, refresh, settingsStore, roomStore, rosterStore, notebookStore]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 操作を二重に走らせない。失敗は画面上の通知にし、保存失敗は再試行できる */
  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
        setNotice(null);
      } catch (e) {
        if (e instanceof CoreError && e.code === codes.staleStep) {
          const s = sessionRef.current;
          if (s && coreRef.current) setSession({ ...s, view: coreRef.current.getStageView(s.stageId) });
        } else {
          setNotice({ message: friendlyMessage(e), retry: e instanceof CoreError && e.code === codes.storageWrite ? () => void guard(fn) : undefined });
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  const openSession = useCallback(async (core: StudyCore, view: StageView, kind: 'learn' | 'review', qualificationId: string) => {
    const intro = await core.getStageIntro(view.stageId);
    setSession({ stageId: view.stageId, kind, qualificationId, view, title: intro.title, intro: intro.intro, explanation: intro.explanation, hint: null, result: null });
  }, []);

  /** 資格とテーマを選んで学ぶ。途中のステージがあれば（どの資格でも）そちらをつづける */
  const startLearn = useCallback((qualificationId: string = QUAL_ID, themeId: string = THEME_ID, answerMode: AnswerMode = 'choice') => guard(async () => {
    const core = coreRef.current!;
    const r = core.findResumable();
    if (r) {
      // 途中のステージは保存された入力方式のまま再開する（ここで選び直さない）
      await openSession(core, await core.resume(r.id), r.kind, r.qualificationId);
    } else {
      await openSession(core, await core.startStage(qualificationId, themeId, { answerMode }), 'learn', qualificationId);
    }
  }), [guard, openSession]);

  const startReview = useCallback((qualificationId: string = QUAL_ID, answerMode: AnswerMode = 'choice') => guard(async () => {
    const core = coreRef.current!;
    const r = core.findResumable();
    if (r) {
      await openSession(core, await core.resume(r.id), r.kind, r.qualificationId);
    } else {
      await openSession(core, await core.startReview(qualificationId, { answerMode }), 'review', qualificationId);
    }
  }), [guard, openSession]);

  /** いま見ている問題の「気になる」記録・保留に使う識別情報（問題ID・教材版・資格・テーマ） */
  const currentQuestionRef = useCallback((): QuestionRef | null => {
    const s = sessionRef.current;
    const q = s?.view.question;
    const st = s ? coreRef.current?.getState().stages[s.stageId] : undefined;
    if (!s || !q || !st) return null;
    return { questionId: q.id, qualificationId: st.qualificationId, themeId: st.themeId, contentVersion: st.contentVersion, prompt: q.prompt };
  }, []);

  /** 数字入力の答え合わせ。形式が不正・違う単位なら理由を返し（記録は進まない）、受け付けたら null */
  const submitNumber = useCallback((text: string): Promise<string | null> => {
    const s = sessionRef.current;
    const q = s?.view.question;
    if (!s || !q) return Promise.resolve(null);
    let problem: string | null = null;
    return guard(async () => {
      try {
        patchView(await coreRef.current!.submitNumber(s.stageId, q.id, text));
      } catch (e) {
        if (e instanceof CoreError && e.code === codes.invalidInput) problem = e.message;
        else throw e;
      }
    }).then(() => problem);
  }, [guard]);

  const patchView = (view: StageView) =>
    setSession((s) => (s ? { ...s, view, hint: view.question && s.view.question?.id === view.question.id ? s.hint : null } : s));

  const select = useCallback((optionId: string) => {
    const s = sessionRef.current;
    const q = s?.view.question;
    if (!s || !q || s.view.qState !== 'choosing') return;
    void guard(async () => patchView(await coreRef.current!.select(s.stageId, q.id, optionId)));
  }, [guard]);

  const confirm = useCallback(() => {
    const s = sessionRef.current;
    const q = s?.view.question;
    if (!s || !q) return;
    void guard(async () => patchView(await coreRef.current!.confirm(s.stageId, q.id)));
  }, [guard]);

  const dontKnow = useCallback(() => {
    const s = sessionRef.current;
    const q = s?.view.question;
    if (!s || !q) return;
    void guard(async () => patchView(await coreRef.current!.dontKnow(s.stageId, q.id)));
  }, [guard]);

  const hint = useCallback(() => {
    const s = sessionRef.current;
    const q = s?.view.question;
    if (!s || !q) return;
    void guard(async () => {
      const text = await coreRef.current!.requestHint(s.stageId, q.id);
      const view = coreRef.current!.getStageView(s.stageId);
      setSession((cur) => (cur ? { ...cur, view, hint: text } : cur));
    });
  }, [guard]);

  const next = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    void guard(async () => {
      const core = coreRef.current!;
      const { view, completion } = await core.advance(s.stageId, s.view.step);
      const result = completion ? summarize(core, s, completion) : null;
      setSession((cur) => (cur ? { ...cur, view, hint: null, result } : cur));
    });
  }, [guard]);

  /** 閉じる・戻る: 中断を保存して箱庭へ戻る */
  const closeStage = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    void guard(async () => {
      if (s.view.phase !== 'completed') await coreRef.current!.interrupt(s.stageId);
      setSession(null);
    });
  }, [guard]);

  const returnHome = useCallback(() => {
    setSession(null);
    refresh();
  }, [refresh]);

  // 前面を離れたら中断を保存し、戻ったら再開する（二重消費はコアが防ぐ）
  const wasActive = useRef(true);
  useEffect(() => {
    const core = coreRef.current;
    const s = sessionRef.current;
    if (!core || !s || s.view.phase === 'completed') {
      wasActive.current = active;
      return;
    }
    const token = ++bgSeqRef.current;
    const stale = () => token !== bgSeqRef.current || sessionRef.current?.stageId !== s.stageId;
    if (wasActive.current && !active) {
      const save = (): Promise<void> => core.interrupt(s.stageId).catch(() => {
        // 保存に失敗しても画面と進捗はそのまま。前面に戻ったとき短く知らせ、再試行できる
        if (sessionRef.current?.stageId === s.stageId) {
          setNotice({
            message: 'いまの状態を保存できませんでした。ここまでの回答は残っています。',
            retry: () => void guard(async () => {
              await core.interrupt(s.stageId);
              await core.resume(s.stageId);
              setSession((cur) => (cur && cur.stageId === s.stageId ? { ...cur, view: core.getStageView(s.stageId) } : cur));
            }),
          });
        }
      });
      void save();
    } else if (!wasActive.current && active) {
      const restore = (): Promise<void> => core.resume(s.stageId).then(() => {
        // 古い非同期結果で別の画面を上書きしない。成功したときだけ最新の状態を表示する
        if (stale()) return;
        setSession((cur) => (cur && cur.stageId === s.stageId ? { ...cur, view: core.getStageView(s.stageId) } : cur));
      }, () => {
        if (sessionRef.current?.stageId === s.stageId) setNotice({ message: '前の続きを読み直せませんでした。もう一度ためせます。', retry: () => void guard(restore) });
      });
      void restore();
    }
    wasActive.current = active;
  }, [active, guard]);

  const saveSettings = useCallback(async (nextSettings: Settings) => {
    setSettings(nextSettings);
    try {
      await settingsStore.save(nextSettings);
    } catch {
      setNotice({ message: '設定を保存できませんでした。' });
    }
  }, [settingsStore]);

  /** 背景の切替。表示は先に変え、保存に失敗しても今の画面はそのまま短く知らせる */
  const saveRoom = useCallback(async (next: RoomId) => {
    setRoom(next);
    try {
      await roomStore.save(next);
    } catch {
      setNotice({ message: '背景の選択を保存できませんでした。' });
    }
  }, [roomStore]);

  /** 家具を仮ポイントで入手。ポイントの減算と所持は学習コアの同じ1回の保存。持っていれば何も引かない */
  // アプリが前面に戻ったとき、実の時計を進めて保存する（1秒ごとには書かない）
  useEffect(() => {
    const core = coreRef.current;
    if (!active || !core) return;
    void core.refreshClock().then(() => refresh(), () => undefined);
  }, [active, refresh]);

  // 次に実が回復する時刻（または日付が替わる時刻）に1回だけ処理する。表示の更新に必要な最小限
  const nextAt = snapshot ? Math.min(snapshot.nextFruitAt ?? Infinity, snapshot.nextDayAt) : null;
  useEffect(() => {
    const core = coreRef.current;
    if (!core || nextAt === null || !active || !Number.isFinite(nextAt)) return;
    const wait = Math.max(1000, nextAt - now() + 500);
    const t = setTimeout(() => void core.refreshClock().then(() => refresh(), () => undefined), Math.min(wait, 2_147_000_000));
    return () => clearTimeout(t);
  }, [nextAt, active, refresh, now]);

  /** 今日のミッションの実を受け取る。満タンなら保留（実は動かさない） */
  const claimMission = useCallback((kind: MissionKind) => guard(async () => {
    const r = await coreRef.current!.claimMission(kind);
    if (r.status === 'pending_full') throw new CoreError(codes.notAllowed, '実が満タンです。使ったあとで受け取れます（ミッションはそのまま残ります）。');
  }), [guard]);

  const buyFurniture = useCallback((furnitureId: string) => guard(async () => {
    const def = defOf(furnitureId);
    if (!def || isStarter(furnitureId)) return;
    await coreRef.current!.purchaseFurniture(furnitureId, def.trialPointCost);
  }), [guard]);

  /** 同室3枠・学習相棒の変更。保存に成功した時だけ反映する（壊れた保存は上書きしない） */
  const updateRoster = useCallback(async (next: Roster): Promise<boolean> => {
    if (next === rosterRef.current) return true;
    if (rosterCorruptRef.current) {
      setNotice({ message: '編成の保存データが壊れているため、変更を保存できません。データはそのまま残してあります。' });
      return false;
    }
    try {
      await rosterStore.save(next);
      rosterRef.current = next;
      setRoster(next);
      return true;
    } catch {
      setNotice({ message: '編成を保存できませんでした。もう一度ためしてください。' });
      return false;
    }
  }, [rosterStore]);
  const chooseSlot = useCallback((slot: number, id: CharacterId) => updateRoster(rosterSetSlot(rosterRef.current, slot, id)), [updateRoster]);
  const chooseCompanion = useCallback((id: CharacterId) => updateRoster(rosterSetCompanion(rosterRef.current, id)), [updateRoster]);

  /** 手帳の変更。保存に成功した時だけ画面へ反映する */
  const saveNotebook = useCallback(async (nextEntries: NotebookEntry[]): Promise<boolean> => {
    if (notebookError) return false;
    try {
      await notebookStore.save(nextEntries);
      setNotebook(nextEntries);
      return true;
    } catch {
      setNotice({ message: '手帳を保存できませんでした。もう一度ためしてください。' });
      return false;
    }
  }, [notebookStore, notebookError]);

  return {
    boot, load, snapshot, resumable, session, notice, setNotice, busy, reaction, settings, saveSettings, room, saveRoom,
    notebook, notebookError, saveNotebook, roster, chooseSlot, chooseCompanion, buyFurniture, claimMission,
    startLearn, startReview, submitNumber, currentQuestionRef, select, confirm, dontKnow, hint, next, closeStage, returnHome,
  };
}

function summarize(core: StudyCore, s: Session, c: CompletionResult): StageResult {
  const stage = core.getState().stages[s.stageId];
  const answers = stage?.answers ?? [];
  return {
    correct: answers.filter((a) => a.correct).length,
    total: answers.length,
    activeSeconds: Math.round(stage?.activeSeconds ?? 0),
    pointsAwarded: c.pointsAwarded,
    totalPoints: c.totalPoints,
    duplicate: c.duplicate,
    nextReviewDate: c.nextReview?.dueDate ?? null,
    kind: s.kind,
  };
}
