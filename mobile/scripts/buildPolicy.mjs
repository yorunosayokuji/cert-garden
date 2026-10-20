// EAS ビルド前の検査（純粋関数。Node の組み込みだけで動き、依存の install より前に走らせられる）。
// 根拠: https://docs.expo.dev/build-reference/npm-hooks/ （eas-build-pre-install は npm install より前）
//       https://docs.expo.dev/eas/environment-variables/usage/ （EAS_BUILD_PROFILE / EAS_BUILD_PLATFORM は build job 内のシステム値）
// ID・owner・endpoint・署名は捏造しない: 揃っていなければ止める。EAS CLI は呼ばない。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GOOGLE_IOS_CLIENT_ID, isProductionApiBase, problems } from './iosConfigCheck.mjs';

export const DEV_PROFILES = ['development', 'simulator'];
export const PRODUCT_PROFILES = ['preview', 'production'];

/** entry.ts の parseSelection と同じ規則（試験で一致を確認する）。形が違えば null=無効 */
export function parseSelectionRaw(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw.approvedVariant;
  if (v === null) return { approvedVariant: null };
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) return { approvedVariant: v };
  return null;
}

const SECRETISH = /^EXPO_PUBLIC_.*(SECRET|PRIVATE|TOKEN|PASSWORD|KEY|P8|CREDENTIAL)/i;

/** eas.json の profile の env。`extends` を（深さ5まで）たどって親の env も含める（EAS の解決と同じ向き: 子が親を上書き） */
export function resolveProfileEnv(easJson, name, depth = 0) {
  const p = easJson?.build?.[name];
  if (!p || depth > 5) return {};
  const parent = typeof p.extends === 'string' ? resolveProfileEnv(easJson, p.extends, depth + 1) : {};
  return { ...parent, ...(p.env ?? {}) };
}

/** 本物のファイルシステムを見る道具（試験では偽物を渡す） */
export function realFs(root) {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    isDir: (rel) => {
      try {
        return statSync(join(root, rel)).isDirectory();
      } catch {
        return false;
      }
    },
    list: (rel) => {
      try {
        return readdirSync(join(root, rel));
      } catch {
        return [];
      }
    },
  };
}

/** EAS へ送るソースの形: 兄弟の学習コアと素材が揃い、公開できない物が混ざっていない。root = mobile フォルダ */
export function checkSourceTree(fs) {
  const errors = [];
  for (const rel of ['../package.json', '../src/mobile.ts', '../design-assets']) {
    if (!fs.exists(rel)) errors.push(`必要なソースが無い: ${rel}（EAS の作業ディレクトリは mobile で、兄弟の学習コアと素材も一緒に送られている必要があります）`);
  }
  const privateRoots = ['../AGENTS.md', '../CLAUDE.md', '../資格箱庭デザイン.md', '../data', '../motion-preview-v13', '../motion-preview-kokemaru-20261016', '../motion-preview-kokemaru-walk-20261019', '../.claude', '../.codex'];
  for (const rel of privateRoots) if (fs.exists(rel)) errors.push(`公開できない物が混ざっている: ${rel}`);
  for (const name of fs.list('../design-assets')) if (/^ios-release-|^dot-review-|参考|reference|livly|リヴリー|duolingo/i.test(name)) errors.push(`公開できない素材の置き場が混ざっている: ../design-assets/${name}`);
  for (const dir of ['.', '..']) {
    for (const name of fs.list(dir)) {
      if (/^\.env(\..*)?$/i.test(name) || /^\.dev\.vars(\..*)?$/i.test(name) || /\.(p8|pem|p12|mobileprovision|jks|keystore)$/i.test(name)) errors.push(`秘密になりうるファイルが混ざっている: ${dir}/${name}`);
      if (dir === '.' && /RECEIPT.*\.json$/i.test(name)) errors.push(`私的な受領記録が混ざっている: ${name}`);
    }
  }
  return errors;
}

/**
 * EAS ビルド前の判定。
 *  - 空や未知の profile、iOS 以外の platform は止める（勝手に本番相当へ通さない）
 *  - development / simulator: 比較用の開発ビルド。画面の案が未選択でも止めない（それが正しい今の状態）
 *  - preview / production: 本人が選んだ案(1〜5)・bundle ID・owner・projectId・API(HTTPS)・Google クライアントIDが揃うこと。比較用フラグ・秘密らしい公開変数が無いこと
 * @returns {{ ok: boolean, kind: 'dev'|'product'|'rejected', errors: string[] }}
 */
export function evaluateBuild({ profile, platform, env, appJson, easJson, pkgJson, selection, fs }) {
  const errors = [];
  if (!profile) return { ok: false, kind: 'rejected', errors: ['EAS_BUILD_PROFILE が空です。profile が分からないビルドは通しません'] };
  const isDev = DEV_PROFILES.includes(profile);
  const isProduct = PRODUCT_PROFILES.includes(profile);
  if (!isDev && !isProduct) return { ok: false, kind: 'rejected', errors: [`未知の profile です: ${profile}（development / simulator / preview / production のみ）`] };
  if (platform !== 'ios') errors.push(`この製品は iPhone 専用です（EAS_BUILD_PLATFORM=${platform || '(空)'}）`);

  errors.push(...problems(appJson, easJson, pkgJson));
  errors.push(...checkSourceTree(fs));
  if (selection === undefined) errors.push('release-selection.json が読めません');
  const sel = parseSelectionRaw(selection);
  if (sel === null) errors.push('release-selection.json の形が正しくありません（approvedVariant は null または 1〜5）');

  const profileEnv = resolveProfileEnv(easJson, profile);
  const eff = (k) => (env?.[k] !== undefined && env[k] !== '' ? env[k] : profileEnv[k]);
  for (const k of Object.keys({ ...profileEnv, ...(env ?? {}) })) if (SECRETISH.test(k)) errors.push(`${k}: 秘密になりうる名前を EXPO_PUBLIC_ に置いている（アプリに同梱されてしまう）`);

  if (isDev) {
    if (eff('EXPO_PUBLIC_IOS_DESIGN') !== '1') errors.push(`${profile}: 比較用の入口(EXPO_PUBLIC_IOS_DESIGN=1)が有効になっていません`);
    return { ok: errors.length === 0, kind: 'dev', errors };
  }

  // preview / production
  if (sel && sel.approvedVariant === null) errors.push('画面のデザインが未選択です（release-selection.json の approvedVariant が null）。本人が1〜5から選ぶまで署名ビルドは作れません');
  if (env?.EXPO_PUBLIC_IOS_DESIGN || profileEnv.EXPO_PUBLIC_IOS_DESIGN) errors.push(`${profile}: 比較用フラグ(EXPO_PUBLIC_IOS_DESIGN)が混ざっています`);
  const e = appJson?.expo ?? {};
  if (typeof e.ios?.bundleIdentifier !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(e.ios.bundleIdentifier)) errors.push('expo.ios.bundleIdentifier が未設定/不正です');
  if (typeof e.owner !== 'string' || e.owner.trim() === '') errors.push('expo.owner が未設定です');
  if (typeof e.extra?.eas?.projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(e.extra.eas.projectId)) errors.push('expo.extra.eas.projectId が未設定/不正です');
  if (!isProductionApiBase(eff('EXPO_PUBLIC_API_BASE_URL'))) errors.push('EXPO_PUBLIC_API_BASE_URL が HTTPS の本番URLではありません（未設定・http・localhost は不可）');
  if (!GOOGLE_IOS_CLIENT_ID.test(String(eff('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID') ?? ''))) errors.push('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID が未設定/不正です');
  return { ok: errors.length === 0, kind: 'product', errors };
}
