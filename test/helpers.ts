import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BitPatternsContent, DEMO_CONFIG, MemoryStorage, StudyCore,
  type Clock, type ContentProvider, type CoreConfig, type CoreEvent, type CoreState, type Question, type StageView,
  type StorageAdapter, type StorageLoad, type ThemeContent,
} from '../src/index.ts';

export class FakeClock implements Clock {
  t: number;
  constructor(iso = '2026-10-12T09:00:00+09:00') {
    this.t = Date.parse(iso);
  }
  now() {
    return this.t;
  }
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
  advanceDays(days: number) {
    this.t += days * 86_400_000;
  }
}

export function seqIds(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** 保存を意図的に失敗させられるラッパー */
export class FlakyStorage implements StorageAdapter {
  failNextSaves = 0;
  saves = 0;
  readonly inner: StorageAdapter;
  constructor(inner: StorageAdapter) {
    this.inner = inner;
  }
  load(): Promise<StorageLoad> {
    return this.inner.load();
  }
  async save(state: CoreState) {
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error('disk full (injected)');
    }
    this.saves++;
    await this.inner.save(state);
  }
}

export interface Rig {
  core: StudyCore;
  clock: FakeClock;
  storage: StorageAdapter;
  events: CoreEvent[];
}

export async function openCore(opts: {
  storage?: StorageAdapter;
  clock?: FakeClock;
  content?: ContentProvider;
  config?: Partial<CoreConfig>;
  idPrefix?: string;
} = {}): Promise<Rig> {
  const storage = opts.storage ?? new MemoryStorage();
  const clock = opts.clock ?? new FakeClock();
  const core = await StudyCore.open({
    storage, clock,
    content: opts.content ?? new BitPatternsContent(),
    newId: seqIds(opts.idPrefix ?? 'stage'),
    config: { ...DEMO_CONFIG, ...opts.config },
  });
  const events: CoreEvent[] = [];
  core.subscribe((e) => {
    events.push(e);
  });
  return { core, clock, storage, events };
}

export async function tempJsonPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cert-garden-test-'));
  return join(dir, 'state.json');
}

/** 現在の問題の正解IDを、保存済み状態（コア内部）から得る。テスト専用 */
export function correctIdOf(core: StudyCore, stageId: string): string {
  const s = core.getState().stages[stageId]!;
  return s.questions[s.currentIndex]!.options.find((o) => o.isCorrect)!.id;
}

export function wrongIdOf(core: StudyCore, stageId: string, misconception?: string): string {
  const s = core.getState().stages[stageId]!;
  const q = s.questions[s.currentIndex]!;
  const o = q.options.find((x) => !x.isCorrect && (misconception === undefined || x.misconception === misconception))!;
  return o.id;
}

/** 導入→説明まで進めて最初の問題を出す */
export async function toFirstQuestion(core: StudyCore, v: StageView): Promise<StageView> {
  let cur = v;
  while (cur.phase === 'intro' || cur.phase === 'explain') cur = (await core.advance(cur.stageId, cur.step)).view;
  return cur;
}

/** 現在の問題へ正解して次へ。完了なら completion を返す */
export async function answerAndNext(core: StudyCore, v: StageView, pick: 'correct' | 'wrong' | 'unknown' = 'correct') {
  const qid = v.question!.id;
  let after: StageView;
  if (pick === 'unknown') after = await core.dontKnow(v.stageId, qid);
  else {
    const opt = pick === 'correct' ? correctIdOf(core, v.stageId) : wrongIdOf(core, v.stageId);
    await core.select(v.stageId, qid, opt);
    after = await core.confirm(v.stageId, qid);
  }
  return core.advance(after.stageId, after.step);
}

export function stubTheme(over: Partial<ThemeContent> & { longExplanation?: string } = {}): ThemeContent {
  const mk = (id: string, ok: string): Question => ({
    id,
    concept: 'stub',
    prompt: `問題${id}`,
    options: [
      { id: 'a', text: 'あ', isCorrect: ok === 'a' },
      { id: 'b', text: 'い', isCorrect: ok === 'b', misconception: 'm1', whyWrong: '違う理由' },
      { id: 'c', text: 'う', isCorrect: ok === 'c', misconception: 'm2' },
    ],
    explanation: over.longExplanation ?? '解説',
    hint: 'ヒント',
    sources: [],
  });
  return {
    qualificationId: 'it-passport',
    themeId: 'bit-patterns',
    version: over.version ?? 'stub.1',
    title: 'stub',
    intro: 'intro',
    explanation: ['e1'],
    coreQuestions: [mk('c1', 'a'), mk('c2', 'b')],
    buildRecheck: () => [mk('r1', 'c'), mk('r2', 'a')],
    ...over,
  };
}

export class StubContent implements ContentProvider {
  theme: ThemeContent | Error;
  constructor(theme: ThemeContent | Error = stubTheme()) {
    this.theme = theme;
  }
  async loadTheme() {
    if (this.theme instanceof Error) throw this.theme;
    return this.theme;
  }
}
