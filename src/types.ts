// 学習コアの型。画面・素材には依存しない。

export type QuestionPhase = 'core' | 'recheck' | 'review';
export type StagePhase = 'intro' | 'explain' | 'core' | 'recheck' | 'completed';
export type StageStatus = 'active' | 'paused' | 'completed' | 'ended';
export type StageKind = 'learn' | 'review';

export interface Source {
  url: string;
  section?: string;
  checked: string;
  /** 出典の役割（例: syllabus = 出題範囲の確認用。問題の正解の証拠ではない） */
  role?: string;
  /** 出典の確認状態。落とさず利用者に見せられるよう保持する */
  status?: string;
  /** 資料名（任意）。無ければ画面ではホスト名などの平易な表示にする */
  title?: string;
}

/** 解説の参考として画面に出す資料。確定後のビューにだけ載る。内部の状態文字列や英語コードは含めない */
export interface SourceView {
  title: string;
  /** https のものだけ。押したときだけ開く（事前の取得や送信はしない） */
  url: string | null;
  section: string | null;
  checked: string;
  /** 資料の役割（日本語）。出題範囲の確認元か、考え方の参考か */
  roleLabel: string;
  /** 確認の範囲（日本語）。正解の検証済みを意味しない */
  scopeNote: string;
}
export interface ReferenceView {
  sources: SourceView[];
  /** 教材の注記（アプリ独自の問題である旨など） */
  note: string | null;
  /** この問題の確認状態（日本語）。専門家の監修ではない */
  checkNote: string;
  contentVersion: string;
}

export interface Option {
  id: string;
  text: string;
  /** 数値問題の機械検算用。意味問題では省略する */
  value?: number;
  isCorrect: boolean;
  /** 誤選択肢が表す誤解のタグ（再確認の優先付けに使う） */
  misconception?: string;
  whyWrong?: string;
}

export type Validation =
  | { type: 'bit_patterns'; bits: number }
  | { type: 'bits_for_patterns'; patterns: number };

export interface Question {
  id: string;
  concept: string;
  prompt: string;
  options: Option[];
  explanation: string;
  hint: string;
  sources: Source[];
  sourceNote?: string;
  /** あれば機械検算する。無い問題は構造検査（正解1つ・重複なし）のみ */
  validation?: Validation;
  /** 再確認問題が由来する中心問題 */
  derivedFromQuestionId?: string;
  /** 教材原稿の検証状態（explicit_arithmetic / definition_or_scenario など）。無印のまま「確認済み」と表示しない */
  verification?: Record<string, unknown>;
  /** 記入式の入口（検算可能な数値問題のみ。次の小工程で使う） */
  shortAnswer?: Record<string, unknown>;
}

export interface WeakSignal {
  questionId: string;
  /** 誤選択肢の誤解タグ。わからない時は 'unknown' */
  misconception: string;
  correctPosition: number;
}

export interface ThemeContent {
  qualificationId: string;
  themeId: string;
  /** 教材版。変わると途中のステージは再開できない */
  version: string;
  title: string;
  intro: string;
  explanation: string[];
  coreQuestions: Question[];
  /** 自分の学習で保留した問題が多く、新しく始められないときの理由（始める前に拒否し、実は使わない）。続きの再開は妨げない */
  blocked?: string;
  buildRecheck(ctx: { seed: string; weak: WeakSignal[]; coreQuestions: Question[] }): Question[];
}

export interface ContentProvider {
  loadTheme(qualificationId: string, themeId: string): Promise<ThemeContent>;
}

export type AnswerOutcome = 'correct' | 'hint_correct' | 'wrong' | 'unknown';
/** choice = 4択、number = 数字を入力（検算できる数値の問題だけ。ほかの問題は4択のまま） */
export type AnswerMode = 'choice' | 'number';
export type AnswerRelation ='first' | 'same_day_recheck' | 'later_review';

export interface AnswerRecord {
  questionId: string;
  phase: QuestionPhase;
  optionId: string | null; // null = わからない、または数字入力（このときは input がある）
  /** 数字入力で答えたときの、実際に入力した値（誤答でも残す。選択肢に対応させない） */
  input?: { raw: string; value: number };
  outcome: AnswerOutcome;
  correct: boolean;
  hintUsed: boolean;
  relation: AnswerRelation;
  misconception?: string;
  answeredAt: number;
  localDate: string;
}

export interface Stage {
  id: string;
  kind: StageKind;
  qualificationId: string;
  themeId: string;
  contentVersion: string;
  status: StageStatus;
  phase: StagePhase;
  /** 操作ごとに増える。連打・古い画面からの操作を弾く */
  step: number;
  questions: Question[];
  coreCount: number;
  currentIndex: number;
  qState: 'choosing' | 'feedback';
  selectedOptionId: string | null;
  hintUsedFor: string[];
  /** 開始時に選んだ入力方式。ステージと一緒に保存し、再起動でも戻さない。無ければ（旧保存）4択 */
  answerMode?: AnswerMode;
  answers: AnswerRecord[];
  fruitConsumed: boolean;
  startedAt: number;
  lastActionAt: number;
  activeSeconds: number;
  learnedDate: string;
  completionId: string | null;
}

export interface ReviewItem {
  qualificationId: string;
  themeId: string;
  contentVersion: string;
  /** 0=翌日, 1=3日後, 2=7日後, 3=14日後（仮の間隔） */
  step: number;
  dueDate: string;
  learnedDate: string;
}

export type MasteryLevel = 'seen' | 'same_day_only' | 'recalled_later';

export interface Mastery {
  firstCorrect: number;
  hintCorrect: number;
  sameDayRecheckCorrect: number;
  laterCorrect: number;
  wrong: number;
  unknown: number;
  level: MasteryLevel;
}

export interface CompletionRecord {
  completionId: string;
  stageId: string;
  kind: StageKind;
  qualificationId: string;
  themeId: string;
  pointsAwarded: number;
  completedAt: number;
}

export interface CoreState {
  schemaVersion: 1;
  wallet: { fruits: number; maxFruits: number };
  points: number;
  /** 資格ID → 学習秒数 */
  studySeconds: Record<string, number>;
  /** "資格ID/テーマID" → 完了情報 */
  completedThemes: Record<string, { completedAt: number; contentVersion: string }>;
  reviews: Record<string, ReviewItem>;
  mastery: Record<string, Mastery>;
  stages: Record<string, Stage>;
  completions: Record<string, CompletionRecord>;
  log: { type: string; stageId?: string; at: number }[];
  /** 仮ポイントで入手した家具。ポイントの減算と同じ保存で書く（二重支払い・支払いだけの状態を作らない）。旧保存には無い */
  furniture?: { owned: string[] };
  /** 実の回復の時計（仮ルール）。旧保存には無く、最初の処理から始める */
  fruitClock?: { lastDay: string; anchor: number; maxSeen: number };
  /** 今日のミッション（JST日ごと。過去日へは戻さない） */
  daily?: { day: string; learn: { completionId: string | null; claimed: boolean }; review: { completionId: string | null; claimed: boolean } };
  /** 受け取り済みの完了ID → 受け取った日（二重受取を防ぐ台帳） */
  claimed?: Record<string, string>;
  /** 木の世話（学習またはおさらいを完了した日ごとに1回、累計） */
  tree?: { total: number; lastDay: string };
  /** 実の時計・ミッション・木の導入前の完了記録を引き継ぎ済み（再起動で二重に配らない印） */
  growthMigrated?: boolean;
}

// ---- 相棒・箱庭へ渡すイベント ----
// 正解情報は answer_correct / encouragement（確定後）にだけ載る。choice_selected には載せない。
export type CompanionCue = 'idle' | 'sleep' | 'roll' | 'cheer' | 'encourage' | 'celebrate';

export type CoreEvent =
  | { type: 'stage_started'; stageId: string; qualificationId: string; themeId: string }
  | { type: 'fruit_consumed'; stageId: string; remaining: number }
  | { type: 'stage_resumed'; stageId: string }
  | { type: 'stage_interrupted'; stageId: string }
  | { type: 'stage_ended'; stageId: string }
  | { type: 'choice_selected'; stageId: string; questionId: string; optionId: string; cue: CompanionCue }
  | { type: 'answer_correct'; stageId: string; questionId: string; hintUsed: boolean; cue: CompanionCue }
  | { type: 'encouragement'; stageId: string; questionId: string; reason: 'wrong' | 'unknown'; cue: CompanionCue }
  | { type: 'stage_completed'; stageId: string; completionId: string; pointsAwarded: number; cue: CompanionCue }
  | { type: 'review_scheduled'; qualificationId: string; themeId: string; dueDate: string }
  | { type: 'garden_outcome'; snapshot: GardenSnapshot };

export interface GardenSnapshot {
  fruits: number;
  maxFruits: number;
  points: number;
  studySeconds: Record<string, number>;
  completedThemes: string[];
  /** 仮ポイントで入手済みの家具ID（スターターは含まない） */
  ownedFurniture: string[];
  /** "資格/テーマ" → 後日思い出せたか(recalled_later)／同日の確認だけか(same_day_only)／見ただけ(seen) */
  masteryLevels: Record<string, MasteryLevel>;
  /** 次に実が1個回復する時刻(ms)。満タンなら null。表示用で、保存はしない */
  nextFruitAt: number | null;
  /** 次のJST日付の始まり(ms)。この時刻に満タンになる */
  nextDayAt: number;
  /** 今日のミッションの状態 */
  missions: { day: string; learn: { done: boolean; claimed: boolean }; review: { done: boolean; claimed: boolean } };
  /** 木の世話: 累計・段階・今日の世話ずみか */
  tree: { total: number; stage: 'seed' | 'sprout' | 'leaf' | 'fruit'; caredToday: boolean };
  nextReviews: { qualificationId: string; themeId: string; dueDate: string; step: number }[];
}

// ---- 画面向けビュー（確定前は正解・解説を含まない） ----
export interface PublicOption {
  id: string;
  text: string;
}

export interface StageView {
  stageId: string;
  status: StageStatus;
  phase: StagePhase;
  step: number;
  title?: string;
  intro?: string;
  explanation?: string[];
  progress: { index: number; total: number };
  qState?: 'choosing' | 'feedback';
  /** このステージの入力方式（旧保存は choice） */
  answerMode?: AnswerMode;
  /** 再確認・おさらいの段階で、同じ日の確認か後日の思い出しか（定着の判定ではない） */
  recall?: 'same_day' | 'later';
  question?: {
    id: string;
    prompt: string;
    /** 数字入力の問題では空（選択肢に答えが含まれるため出さない） */
    options: PublicOption[];
    selectedOptionId: string | null;
    hintShown: boolean;
    /** 数字入力の問題。解答キーは含めない（単位だけ） */
    input?: { kind: 'number'; unit: string };
  };
  feedback?: {
    outcome: AnswerOutcome;
    correctOptionId: string;
    explanation: string;
    whyWrong?: string;
    /** 数字入力: 実際に入力した値と、確認後の正しい答え（単位つき） */
    input?: { entered: string; correctAnswer: string };
    /** 解説の参考（確定後のみ） */
    references?: ReferenceView;
  };
}

export interface CompletionResult {
  completionId: string;
  duplicate: boolean;
  pointsAwarded: number;
  totalPoints: number;
  studySeconds: number;
  nextReview: { dueDate: string; step: number } | null;
}

// ---- 保存アダプター ----
export type StorageLoad = { kind: 'empty' } | { kind: 'ok'; state: CoreState };

export interface StorageAdapter {
  load(): Promise<StorageLoad>;
  save(state: CoreState): Promise<void>;
}

export interface Clock {
  now(): number;
}
