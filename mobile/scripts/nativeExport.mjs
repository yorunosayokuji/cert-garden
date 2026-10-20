// `expo export --platform ios` の出力を確かめる（純粋な検査）。
// これは JS(Hermes) と assets の書き出しの確認で、ネイティブのコンパイル・署名・TestFlight・実機とは別物。
// 根拠: https://docs.expo.dev/more/expo-cli/#exporting （export は JS と assets。native runtime の compile とは別）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 書き出しの種類。出力先・比較フラグ・--dev の有無をここで一つに決める（export-native.mjs と試験が同じ表を使う） */
export const MODES = {
  /** 製品相当（配布）: Hermes バイトコード・minify。比較フラグなし。署名版と同じ判定で製品/起動拒否に入る */
  product: { out: 'dist-native', flag: '', dev: false },
  /** 比較の開発ビルド相当: --dev（__DEV__=true）+ EXPO_PUBLIC_IOS_DESIGN=1。native で比較の入口に入る条件と同じ。配布物ではない */
  'compare-dev': { out: 'dist-native-compare', flag: '1', dev: true },
  /** 補助検査: 配布相当にフラグだけ付けた出力。__DEV__ が false なので native では比較に入らない（署名版に比較フラグが混ざっても開かない確認用。比較 native の検証には数えない） */
  'flag-release': { out: 'dist-native-flag', flag: '1', dev: false },
};

/** expo CLI へ渡す引数。配布相当（product / flag-release）には --dev / --no-minify / --no-bytecode を付けない */
export function exportArgs(mode) {
  const m = MODES[mode];
  if (!m) throw new Error(`未知の書き出し: ${mode}`);
  return ['export', '--platform', 'ios', '--output-dir', m.out, '--clear', ...(m.dev ? ['--dev', '--no-minify'] : [])];
}

/** Hermes のバイトコードの先頭の印（0x1F1903C103BC1FC6 のリトルエンディアン） */
export const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

/** 文字列の有無（Hermes の文字列表は ASCII か UTF-16 のどちらかで持つので両方を探す） */
export function hasString(buf, s) {
  if (buf.includes(Buffer.from(s, 'utf8')) || buf.includes(Buffer.from(s, 'utf16le'))) return true;
  // 開発用のJSは日本語を \uXXXX の形で持つことがある（小文字/大文字どちらの16進も探す）
  if (/[^\x00-\x7f]/.test(s)) {
    const esc = [...s].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('');
    if (buf.includes(Buffer.from(esc, 'utf8')) || buf.includes(Buffer.from(esc.replace(/\\u([0-9a-f]{4})/g, (_, h) => `\\u${h.toUpperCase()}`), 'utf8'))) return true;
  }
  return false;
}

/** 比較用の道具にだけある文字列（製品の書き出しに入ってはいけない） */
export const COMPARE_ONLY = ['読込を固定', 'compare:v1', 'armReadFailure', 'proto-picker'];
/** 動きの見くらべ(lab)の画面にだけある文字列（製品の書き出しに入ってはいけない。比較には全26体の既存labがある） */
// （箱庭の「新しい動き」ボタンの文言は Home の共有部品に残る＝onOpenLab が無いと描かれない。ここでは画面の中身にだけある文を見る）
export const LAB_ONLY = ['見かたの注意', '26匹の待機と、左右へすすむ動きを確かめる画面です', '反転や逆再生はしていません'];
/** 旧画面(App.tsx)にだけある文字列（iOS の書き出しに入ってはいけない＝旧画面へ戻る経路が無い） */
export const LEGACY_ONLY = ['箱庭をひらいています'];
/** 製品にある文字列 */
export const PRODUCT_MARKERS = ['起動できません', '結果'];

function readMeta(dir) {
  const p = join(dir, 'metadata.json');
  if (!existsSync(p)) throw new Error('metadata.json がありません');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * 書き出しの検査。
 *  product      : Hermes 必須。比較の道具・lab・旧画面の文字列が無く、製品の文字列がある
 *  compare-dev  : 開発用JS（Hermes を求めない・配布物ではない）。比較の道具と lab がある。__DEV__ と比較フラグ"1"が実際に入っている
 *  flag-release : Hermes 必須（配布相当）。比較の道具は入る（フラグだけ）が、旧画面の文字列は無い。比較 native の検証には数えない
 * @param {string} dir 書き出し先
 * @param {'product'|'compare-dev'|'flag-release'} mode
 * @returns {{ ok: boolean, errors: string[], info: { bundleBytes: number, assets: number, hermes: boolean, dev: boolean } }}
 */
export function verifyNativeExport(dir, mode) {
  const errors = [];
  const info = { bundleBytes: 0, assets: 0, hermes: false, dev: false };
  if (!MODES[mode]) return { ok: false, errors: [`未知の書き出し: ${mode}`], info };
  let meta;
  try {
    meta = readMeta(dir);
  } catch (e) {
    return { ok: false, errors: [String(e.message)], info };
  }
  const ios = meta?.fileMetadata?.ios;
  if (!ios || typeof ios.bundle !== 'string') return { ok: false, errors: ['metadata.json に ios の bundle がありません'], info };
  if (meta.fileMetadata.android || meta.fileMetadata.web) errors.push('ios 以外の書き出しが混ざっています');
  const bundlePath = join(dir, ios.bundle);
  if (!existsSync(bundlePath)) return { ok: false, errors: [`bundle が無い: ${ios.bundle}`], info };
  const buf = readFileSync(bundlePath);
  info.bundleBytes = buf.length;
  info.assets = Array.isArray(ios.assets) ? ios.assets.length : 0;
  info.hermes = buf.subarray(0, 8).equals(HERMES_MAGIC);
  if (buf.length < 100_000) errors.push(`bundle が小さすぎます（${buf.length} バイト）`);
  const wantDev = MODES[mode].dev;
  if (!wantDev && !info.hermes) errors.push('Hermes のバイトコードではありません（--no-bytecode や --dev は配布用にしない）');
  if (wantDev && info.hermes) errors.push('開発用の出力のはずが Hermes のバイトコードです（--dev が効いていません）');
  if (info.assets === 0) errors.push('assets が0件です');
  for (const a of ios.assets ?? []) if (!existsSync(join(dir, a.path)) || statSync(join(dir, a.path)).size === 0) errors.push(`assets が欠けている/空: ${a.path}`);
  if (!wantDev) for (const s of LEGACY_ONLY) if (hasString(buf, s)) errors.push(`旧画面だけの文字列が入っています: ${s}`);
  if (mode === 'product') {
    for (const s of [...COMPARE_ONLY, ...LAB_ONLY]) if (hasString(buf, s)) errors.push(`比較用の道具/動きの見くらべの文字列が製品の書き出しに入っています: ${s}`);
    for (const s of PRODUCT_MARKERS) if (!hasString(buf, s)) errors.push(`製品の文字列が入っていません: ${s}`);
  } else {
    for (const s of ['読込を固定', 'compare:v1']) if (!hasString(buf, s)) errors.push(`比較用の書き出しに入っているはずの文字列がありません: ${s}`);
    if (mode === 'compare-dev') {
      // 本当の開発入口に達する出力: lab（全26体の既存画面）があり、__DEV__ が true、比較フラグが "1" で入っている
      for (const s of LAB_ONLY) if (!hasString(buf, s)) errors.push(`比較の書き出しに入っているはずの動きの見くらべがありません: ${s}`);
      const text = buf.toString('utf8');
      info.dev = /__DEV__\s*=\s*true|__DEV__=!0|__DEV__\s*:\s*true/.test(text) || /\b__DEV__\b[^;\n]{0,40}\btrue\b/.test(text);
      if (!info.dev) errors.push('__DEV__ が true の開発用の出力だと確認できません');
      if (!/EXPO_PUBLIC_IOS_DESIGN[^\n]{0,40}"1"|buildFlag:\s*"1"/.test(text)) errors.push('比較フラグ(EXPO_PUBLIC_IOS_DESIGN=1)が実際に入っていません');
    }
  }
  return { ok: errors.length === 0, errors, info };
}

export function listOutput(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
