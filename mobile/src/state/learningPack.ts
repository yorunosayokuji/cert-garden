// 親（Codex）が作る教材原稿 design-assets/app-completion-20261020/learning-pack.json を読む（読み取り専用）。
// 基礎コースであり、試験範囲の全体ではない。人の専門監修は無く、意味問題の独立確認は未了。
import raw from '../../../design-assets/app-completion-20261020/learning-pack.json';
import { CompositeContent, HoldFilteredContent, PackContent, THEMES, listPackThemes, type LearningPack, type QuestionHolds } from '../../../src/mobile.ts';

export const LEARNING_PACK = raw as unknown as LearningPack;

export interface CourseTheme {
  qualificationId: string;
  themeId: string;
  title: string;
  minutes: number;
  questionCount: number;
  /** 数字を入力して答えられる問題の数（0なら4択だけ） */
  numericCount: number;
  /** 'sample' = 以前からあるビット列の見本テーマ */
  kind: 'foundation' | 'sample';
}

/** 選べるテーマ一覧（資格→テーマ）。既存のビット列テーマ＋原稿の20テーマ */
export const COURSE_THEMES: CourseTheme[] = [
  ...THEMES.map((t): CourseTheme => ({ qualificationId: t.qualificationId, themeId: t.id, title: t.title, minutes: 5, questionCount: 8, numericCount: 0, kind: 'sample' })),
  ...listPackThemes(LEARNING_PACK).map((t): CourseTheme => ({
    qualificationId: t.qualificationId, themeId: t.themeId, title: t.title, minutes: t.estimatedMinutes, questionCount: t.questionCount + 2, numericCount: t.numericCount, kind: 'foundation',
  })),
];

export const themesOf = (qualificationId: string) => COURSE_THEMES.filter((t) => t.qualificationId === qualificationId);

/** 教材。holds を渡すと、自分の学習で保留した問題を新しく作る出題から外す（原稿そのものは変えない） */
export const createContent = (holds?: QuestionHolds) => {
  const base = new CompositeContent(new PackContent(LEARNING_PACK));
  return holds ? new HoldFilteredContent(base, holds) : base;
};

/** 原稿のテーマの教材版（ビット列の見本テーマは対象外） */
export const versionOfTheme = (qualificationId: string, themeId: string) => LEARNING_PACK.themes.find((t) => t.qualificationId === qualificationId && t.themeId === themeId)?.version;

/** 保留の一覧に出すテーマ名 */
export const themeTitle = (qualificationId: string, themeId: string) => COURSE_THEMES.find((t) => t.qualificationId === qualificationId && t.themeId === themeId)?.title ?? themeId;
