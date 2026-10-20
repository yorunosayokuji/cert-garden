// 画面に出す短い文（操作に必要な説明だけ）。token・保存内容・サーバーの本文は含めない。
import type { FailKind } from './service.ts';

export const FAIL_TEXT: Record<FailKind, string> = {
  invalidState: 'いまは実行できません。',
  busy: '処理中です。',
  cancelled: 'ログインを取り消しました。',
  denied: 'ログインが許可されませんでした。',
  timeout: '時間内に終わりませんでした。もう一度ためせます。',
  unavailable: 'この端末ではこの方法を使えません。',
  notConfigured: 'このログイン方法は、いまは使えません。',
  offline: '通信できませんでした。もう一度ためせます。',
  rejected: '確認できませんでした。もう一度ログインしてください。',
  rateLimited: 'しばらく待ってから、やり直してください。',
  server: 'サーバー側でうまくいきませんでした。時間をおいてください。',
  storage: 'この端末にログイン情報を保存できませんでした。',
  sessionLost: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  revokeFailed: 'Appleとの連携を解除できなかったため、何も削除していません。もう一度ためせます。',
  providerUnavailable: 'ログイン提供元の確認が一時的にできません。ログインは保たれています。時間をおいてやり直してください。',
  unknown: 'うまくいきませんでした。',
};

const APPLE_MANUAL = 'Appleとの連携は自動では解除できていません。端末の「設定」→ 自分の名前 →「サインインとセキュリティ」→「Appleでサインイン」からこのアプリを選び、「Appleでサインインの使用を停止」してください。';

/** 退会が成功した時の案内（Appleの連携解除の結果と、端末内の後始末の結果を正しく伝える） */
export function deleteDoneText(appleRevocation: string, localCleanup: 'done' | 'pending'): string {
  const parts = ['アカウントを削除しました。この端末のゲストのデータは残っています。'];
  if (appleRevocation === 'manual_required' || appleRevocation === 'skipped_manual_required') parts.push(APPLE_MANUAL);
  if (localCleanup === 'pending') parts.push('このアカウントの端末内のコピーの一部を消し切れませんでした。次に起動した時にもう一度消します。');
  return parts.join('');
}

export const UNSUPPORTED_TEXT = {
  web: 'ログインはiPhoneアプリで使えます（Webでは未対応です）。',
  expoGo: 'Expo Goではログインを使えません。開発ビルドまたはアプリ本体で使えます。',
  platform: 'この端末ではログインを使えません。',
} as const;

export const KEY_LABEL: Record<string, string> = {
  'certgarden:core:v1': '学習の進み',
  'certgarden:diagnostic:v1': '初回チェック',
  'certgarden:roster:v1': '同室の編成',
  'certgarden:holds:v1': '問題の記録',
  'certgarden:room:v1': '部屋',
  'certgarden:notebook:v1': '手帳',
  'certgarden:settings:v1': '設定',
  'certgarden:furniture:v1': '家具',
  'certgarden:learnprefs:v1': '学ぶの設定',
  format: '保存の形式',
};

export const labelKeys = (keys: string[]): string => keys.map((k) => KEY_LABEL[k] ?? '不明な項目').join('、');

export const UPLOAD_SCOPE = '送る内容: 学習の進み・初回チェック・同室の編成・問題の記録・部屋・手帳・設定・家具。購入や権利は含みません。';
