export class CoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

export const codes = {
  corruptStorage: 'CORRUPT_STORAGE',
  storageWrite: 'STORAGE_WRITE_FAILED',
  contentLoad: 'CONTENT_LOAD_FAILED',
  contentInvalid: 'CONTENT_INVALID',
  staleContent: 'STALE_CONTENT',
  noFruits: 'NO_FRUITS',
  activeStageExists: 'ACTIVE_STAGE_EXISTS',
  stageNotFound: 'STAGE_NOT_FOUND',
  questionNotFound: 'QUESTION_NOT_FOUND',
  notAllowed: 'NOT_ALLOWED',
  staleStep: 'STALE_STEP',
  nothingToReview: 'NOTHING_TO_REVIEW',
  invalidInput: 'INVALID_INPUT',
  themeOnHold: 'THEME_ON_HOLD',
  insufficientPoints: 'INSUFFICIENT_POINTS',
} as const;
