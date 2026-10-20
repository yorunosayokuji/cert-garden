// I5: iOS の製品の入口・native の書き出し・EAS ビルド前の検査・EAS へ送るソースの検査。
// 注意: 実際のネイティブのコンパイル・署名・TestFlight・実機・実OAuth は確認していない。ここは判定と検査そのものを実際に動かして確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BitPatternsContent, StudyCore } from '../../src/mobile.ts';
import { GenerationKv, BACKUP_KEYS } from '../src/account/backup.ts';
import { decideEntry, isIosDesignEnabled, parseProductPreview, parseSelection, productConfig, type EntryContext } from '../src/ios/entry.ts';
import { IOS_DESIGN_PREFIX, PRODUCT_META_PREFIX, PRODUCT_PREVIEW_PREFIX, PrefixedKv, ProductKv } from '../src/ios/storage.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { KvStorage } from '../src/state/kvStorage.ts';
import { NotebookStore } from '../src/state/notebook.ts';
import { DEV_PROFILES, PRODUCT_PROFILES, checkSourceTree, evaluateBuild, parseSelectionRaw } from '../scripts/buildPolicy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const read = (p: string) => readFileSync(join(mobile, p.replace(/^\.\.\//, '')), 'utf8'); // mobile フォルダからの相対（先頭の ../ は付けても付けなくてもよい）
const T0 = Date.parse('2026-10-20T09:00:00+09:00');

// ================= 入口の判定 =================

const base = (over: Partial<EntryContext>): EntryContext => ({ platform: 'ios', isDev: false, buildFlag: undefined, search: '', selection: { approvedVariant: null }, ...over });

test('入口(iOS): 署名版・通常の実行は常に製品。未選択なら起動を拒否し、旧画面へは戻らない。承認された案があればその案だけ', () => {
  assert.deepEqual(decideEntry(base({})), { kind: 'refuse', reason: 'noSelection' });
  assert.deepEqual(decideEntry(base({ isDev: true })), { kind: 'refuse', reason: 'noSelection' }, '開発の実行でもフラグが無ければ旧画面ではなく製品の判定');
  for (const n of [1, 2, 3, 4, 5]) assert.deepEqual(decideEntry(base({ selection: { approvedVariant: n } })), { kind: 'product', variant: n, space: 'device' });
  for (const bad of [0, 6, -1, 1.5, '3', true, [], {}, undefined, NaN]) {
    const sel = bad === undefined ? {} : { approvedVariant: bad };
    assert.deepEqual(decideEntry(base({ selection: sel })), { kind: 'refuse', reason: 'badSelection' }, JSON.stringify(sel));
  }
  for (const raw of [null, undefined, 3, 'x', []]) assert.deepEqual(decideEntry(base({ selection: raw })), { kind: 'refuse', reason: 'badSelection' });
  assert.ok(![decideEntry(base({})), decideEntry(base({ selection: { approvedVariant: 2 } }))].some((e) => e.kind === 'legacy'));
});

test('入口(iOS): 画面の案は URL・環境変数・開発フラグから上書きできない。比較は開発の実行かつフラグ1の時だけで、署名版では開かない', () => {
  // URL（native には無いが、渡されても無視）
  assert.deepEqual(decideEntry(base({ search: '?iosProductPreview=4&iosDesign=1&v=3', selection: { approvedVariant: 2 } })), { kind: 'product', variant: 2, space: 'device' });
  // 比較フラグ: 署名版（isDev=false）では開かない
  assert.deepEqual(decideEntry(base({ buildFlag: '1', selection: { approvedVariant: 5 } })), { kind: 'product', variant: 5, space: 'device' });
  assert.deepEqual(decideEntry(base({ buildFlag: '1' })), { kind: 'refuse', reason: 'noSelection' });
  assert.deepEqual(decideEntry(base({ isDev: true, buildFlag: '1' })), { kind: 'compare' });
  assert.deepEqual(decideEntry(base({ isDev: true, buildFlag: '0' })), { kind: 'refuse', reason: 'noSelection' });
  // 入力に variant を指定する項目そのものが無い
  assert.deepEqual(Object.keys(base({})).sort(), ['buildFlag', 'isDev', 'platform', 'search', 'selection']);
  assert.ok(!read('../src/Root.tsx').includes('process.env.EXPO_PUBLIC_VARIANT'));
});

test('入口(Web・Android): 通常は旧画面と既存の保存。?iosDesign=1 は開発サーバーか比較ビルドだけ。?iosProductPreview=N は開発サーバーだけ。本番ではクエリで開かない', () => {
  const web = (over: Partial<EntryContext>) => decideEntry(base({ platform: 'web', ...over }));
  assert.deepEqual(web({}), { kind: 'legacy' });
  assert.deepEqual(web({ search: '?iosDesign=1' }), { kind: 'legacy' }, '本番のWeb出力');
  assert.deepEqual(web({ search: '?iosProductPreview=4' }), { kind: 'legacy' }, '本番のWeb出力');
  assert.deepEqual(web({ isDev: true, search: '?iosDesign=1' }), { kind: 'compare' });
  assert.deepEqual(web({ buildFlag: '1', search: '?iosDesign=1' }), { kind: 'compare' }, '比較ビルド');
  assert.deepEqual(web({ buildFlag: '1', search: '?iosProductPreview=4' }), { kind: 'legacy' }, '比較ビルドでも製品の検品は開発サーバーだけ');
  assert.deepEqual(web({ isDev: true, search: '?iosProductPreview=4' }), { kind: 'product', variant: 4, space: 'preview' });
  for (const bad of ['0', '6', 'x', '', '2.5', '10', '-1']) assert.deepEqual(web({ isDev: true, search: `?iosProductPreview=${bad}` }), { kind: 'legacy' }, bad);
  assert.deepEqual(web({ isDev: true, search: '?iosProductPreview=3&iosDesign=1' }), { kind: 'compare' }, '比較が優先');
  // Web では release-selection の承認があっても旧画面（Web は旧画面と既存保存を維持）
  assert.deepEqual(web({ selection: { approvedVariant: 3 } }), { kind: 'legacy' });
  assert.deepEqual(decideEntry(base({ platform: 'android' })), { kind: 'legacy' });
  assert.equal(parseProductPreview('?iosProductPreview=5'), 5);
  assert.equal(isIosDesignEnabled({ platform: 'ios', isDev: true, buildFlag: '1', search: '' }), true);
});

test('製品の設定: スケルトンON・人工の待ち0。release-selection.json は本人が選ぶまで null で、1〜5のどれも採用していない', () => {
  assert.deepEqual(productConfig(3), { variant: 3, skeleton: true, delayMs: 0 });
  const sel = JSON.parse(read('../release-selection.json'));
  // 本人が選んだ後は、この試験も一緒に更新する（今は未選択が正しい）
  assert.deepEqual(sel, { approvedVariant: null });
  assert.deepEqual(parseSelection(sel), { approvedVariant: null });
});

test('選択の検査: TypeScript 側(entry.ts)と EAS 前の検査(buildPolicy.mjs)は同じ規則', () => {
  const cases: unknown[] = [{ approvedVariant: null }, { approvedVariant: 1 }, { approvedVariant: 5 }, { approvedVariant: 0 }, { approvedVariant: 6 }, { approvedVariant: '2' }, { approvedVariant: 2.5 }, {}, null, [], 'x', undefined, { approvedVariant: true }];
  for (const c of cases) assert.deepEqual(parseSelection(c), parseSelectionRaw(c), JSON.stringify(c));
});

// ================= 保存 =================

test('製品の保存(端末): 学習の9キーは既存の保存をそのままゲストの原本として読み、世代・結び付けは別の接頭辞へ。既存のキーを変えない', async () => {
  const base = new MemoryKv();
  // 既存の保存（旧画面と同じ書き方）
  const legacy = await StudyCore.open({ storage: new KvStorage(base), content: new BitPatternsContent(), clock: { now: () => T0 } });
  const v = await legacy.startStage('it-passport', 'bit-patterns');
  await legacy.interrupt(v.stageId);
  await new NotebookStore(base).save([{ id: 'n1', name: 'ITパスポート', date: '', memo: '旧画面のメモ' }]);
  const before = JSON.stringify([...base.map.entries()]);
  // 製品の層
  const gen = new GenerationKv(new ProductKv(base));
  assert.equal((await new NotebookStore(gen).load())[0]!.memo, '旧画面のメモ', 'ゲストの原本をそのまま読む');
  const core = await StudyCore.open({ storage: new KvStorage(gen), content: new BitPatternsContent(), clock: { now: () => T0 } });
  assert.equal(core.findResumable()?.id, v.stageId, '途中の学習が残っている');
  assert.equal(JSON.stringify([...base.map.entries()]), before, '読むだけでは何も書き換えない');
  // アカウントのコピーは別のキー。ゲストの原本は変わらない
  const snapshot = new Map(base.map);
  const entries = Object.fromEntries(BACKUP_KEYS.map((k) => [k, k === 'certgarden:notebook:v1' ? '[]' : (base.map.get(k) ?? '{}')]));
  await gen.commit(entries as never, 'u-A');
  for (const k of BACKUP_KEYS) assert.equal(base.map.get(k), snapshot.get(k), `${k} は変わっていない`);
  assert.ok([...base.map.keys()].some((k) => k.startsWith(`${PRODUCT_META_PREFIX}g1/`)), '復元した世代は専用の接頭辞の下');
  const keys = [...base.map.keys()];
  assert.ok(keys.every((k) => k.startsWith('certgarden:') || k.startsWith(PRODUCT_META_PREFIX)), `想定外の名前のキー: ${keys.join(',')}`);
});

test('製品の保存(Webの開発検品): 通常の保存・比較の保存のどちらにも触れない専用の接頭辞', async () => {
  assert.notEqual(PRODUCT_PREVIEW_PREFIX, IOS_DESIGN_PREFIX);
  assert.ok(!PRODUCT_PREVIEW_PREFIX.startsWith('certgarden:'));
  assert.throws(() => new PrefixedKv(new MemoryKv(), 'certgarden:'));
  const raw = new MemoryKv();
  raw.map.set('certgarden:notebook:v1', '[]');
  raw.map.set(`${IOS_DESIGN_PREFIX}certgarden:notebook:v1`, '[1]');
  const snapshot = JSON.stringify([...raw.map.entries()]);
  const p = new GenerationKv(new PrefixedKv(raw, PRODUCT_PREVIEW_PREFIX));
  assert.equal(await p.getItem('certgarden:notebook:v1'), null, '通常・比較の保存は見えない');
  await new NotebookStore(p).save([{ id: 'a', name: '検品', date: '', memo: '' }]);
  assert.equal(JSON.stringify([...raw.map.entries()].filter(([k]) => !k.startsWith(PRODUCT_PREVIEW_PREFIX))), snapshot, '通常・比較の保存は変わらない');
  assert.ok([...raw.map.keys()].some((k) => k.startsWith(PRODUCT_PREVIEW_PREFIX)));
});

// ================= 製品の経路に比較の道具を混ぜない =================

function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(mobile, entry)];
  const re = /^[ \t]*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(re)) {
      const spec = (m[1] ?? m[2])!;
      const target = resolve(dirname(f), spec);
      if (!target.startsWith(join(mobile, 'src'))) continue; // コアなど src の外は見ない
      const stem = target.replace(/\.(ts|tsx)$/, '');
      for (const ext of ['.ts', '.tsx', '.web.ts', '.web.tsx']) if (existsSync(stem + ext)) stack.push(stem + ext);
    }
  }
  return new Set([...seen].map((p) => p.slice(mobile.length + 1).replaceAll('\\', '/')));
}

test('経路の分離: 製品(ProductApp)の依存に、比較の操作帯・picker・比較設定・故障の差し込み・旧画面は含まれない。比較(IosDesignApp)には含まれる（調べ方の確認）', () => {
  const product = graph('src/ios/ProductApp.tsx');
  const compare = graph('src/ios/IosDesignApp.tsx');
  for (const f of ['src/ios/CompareChrome.tsx', 'src/ios/Picker.tsx', 'src/ios/Picker.web.tsx', 'src/ios/namespace.ts', 'src/ios/compare.ts', 'src/ios/IosDesignApp.tsx', 'src/App.tsx', 'src/ios/ReleaseBlocked.tsx']) {
    assert.ok(!product.has(f), `製品の依存に ${f} がある`);
  }
  for (const f of ['src/ios/Runner.tsx', 'src/ios/Variants.tsx', 'src/ios/Skeletons.tsx', 'src/account/native.ts', 'src/ios/storage.ts', 'src/ios/entry.ts', 'src/ios/minShow.ts']) assert.ok(product.has(f), `製品の依存に ${f} が無い（調べ方の誤り）`);
  for (const f of ['src/ios/CompareChrome.tsx', 'src/ios/Picker.tsx', 'src/ios/Picker.web.tsx', 'src/ios/namespace.ts', 'src/ios/Runner.tsx']) assert.ok(compare.has(f), `比較の依存に ${f} が無い（調べ方の誤り）`);
  const text = [...product].map((f) => readFileSync(join(mobile, f), 'utf8')).join('\n');
  for (const s of ['FaultKv', 'armReadFailure', '読込を固定', 'proto-picker']) assert.ok(!text.includes(s), `製品の依存のソースに ${s} がある`);
  // 製品は人工の待ちも故障も受け付けない
  const productApp = read('../src/ios/ProductApp.tsx');
  assert.doesNotMatch(productApp, /compare=|armFailure|delayMs:\s*[1-9]/);
  assert.match(productApp, /productConfig\(variant\)/);
  assert.match(read('../src/ios/Runner.tsx'), /if \(!compare \|\| flowRef\.current \|\| bootBusyRef\.current\) return/);
});

test('Root: 旧画面の読み込みは iOS 以外だけ、比較は開発か比較ビルドだけ、製品は iOS か開発だけ（書き出しで不要な側が外れる条件）', () => {
  const root = read('../src/Root.tsx');
  assert.match(root, /if \(Platform\.OS !== 'ios'\) \{\s*loadLegacy/);
  assert.match(root, /if \(__DEV__ \|\| process\.env\.EXPO_PUBLIC_IOS_DESIGN === '1'\) \{\s*loadCompare/);
  assert.match(root, /if \(Platform\.OS === 'ios' \|\| __DEV__\) \{\s*loadProduct/);
  assert.match(root, /ReleaseBlocked/);
  assert.doesNotMatch(root, /EXPO_PUBLIC_(VARIANT|APPROVED)/);
  assert.match(read('../src/ios/ReleaseBlocked.tsx'), /起動できません/);
});

// ================= EAS ビルド前の検査 =================

const GOOD_APP = { expo: { name: 'x', slug: 'x', scheme: 'certgarden', ios: { supportsTablet: false, usesAppleSignIn: true, config: { usesNonExemptEncryption: false }, bundleIdentifier: 'com.someone.certgarden' }, owner: 'someone', extra: { eas: { projectId: '00000000-0000-4000-8000-000000000000' } } } };
const CLIENT = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'; // ダミー（形だけ）
const PUBLIC_ENV = { EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: CLIENT };
const REAL_EAS = JSON.parse(read('eas.json'));
const GOOD_EAS = { ...REAL_EAS, build: { ...REAL_EAS.build, preview: { ...REAL_EAS.build.preview, env: PUBLIC_ENV }, production: { ...REAL_EAS.build.production, env: PUBLIC_ENV } } };
const PKG = JSON.parse(read('package.json'));
const cleanFs = (extra: string[] = [], missing: string[] = []) => {
  const present = new Set(['../package.json', '../src/mobile.ts', '../design-assets', ...extra]);
  for (const m of missing) present.delete(m);
  return { exists: (r: string) => present.has(r), isDir: (r: string) => r === '../design-assets', list: (r: string) => [...present].filter((p) => p.startsWith(`${r}/`) && !p.slice(r.length + 1).includes('/')).map((p) => p.slice(r.length + 1)) };
};
const ev = (over: Record<string, unknown>) => evaluateBuild({ profile: 'production', platform: 'ios', env: {}, appJson: GOOD_APP, easJson: GOOD_EAS, pkgJson: PKG, selection: { approvedVariant: 3 }, fs: cleanFs(), ...over } as never);

test('ビルド前の検査: 揃った製品ビルド(preview/production)は通る。本人の選択・ID・API・Googleクライアント・比較フラグの混入のどれが欠けても止まる', () => {
  for (const p of PRODUCT_PROFILES) assert.deepEqual(ev({ profile: p }), { ok: true, kind: 'product', errors: [] }, p);
  const fails = (name: string, over: Record<string, unknown>, re: RegExp) => {
    const r = ev(over) as { ok: boolean; errors: string[] };
    assert.equal(r.ok, false, name);
    assert.ok(r.errors.some((e) => re.test(e)), `${name}: ${r.errors.join(' / ')}`);
  };
  fails('未選択', { selection: { approvedVariant: null } }, /未選択/);
  fails('選択が壊れている', { selection: { approvedVariant: 9 } }, /形が正しくありません/);
  fails('選択ファイルが読めない', { selection: undefined }, /読めません/);
  fails('bundle ID 無し', { appJson: { expo: { ...GOOD_APP.expo, ios: { ...GOOD_APP.expo.ios, bundleIdentifier: undefined } } } }, /bundleIdentifier/);
  fails('owner 無し', { appJson: { expo: { ...GOOD_APP.expo, owner: undefined } } }, /owner/);
  fails('projectId 無し', { appJson: { expo: { ...GOOD_APP.expo, extra: {} } } }, /projectId/);
  fails('API が http', { env: { EXPO_PUBLIC_API_BASE_URL: 'http://api.example.test' } }, /API_BASE_URL/);
  fails('API が localhost', { env: { EXPO_PUBLIC_API_BASE_URL: 'https://localhost:8799' } }, /API_BASE_URL/);
  fails('API 未設定', { easJson: { ...GOOD_EAS, build: { ...GOOD_EAS.build, production: { autoIncrement: true } } } }, /API_BASE_URL/);
  fails('Google 未設定', { easJson: { ...GOOD_EAS, build: { ...GOOD_EAS.build, production: { autoIncrement: true, env: { EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test' } } } } }, /GOOGLE_IOS_CLIENT_ID/);
  fails('Google の形が違う', { env: { EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'nope' } }, /GOOGLE_IOS_CLIENT_ID/);
  fails('比較フラグ(実行環境)', { env: { EXPO_PUBLIC_IOS_DESIGN: '1' } }, /比較用フラグ/);
  fails('比較フラグ(profile)', { easJson: { ...GOOD_EAS, build: { ...GOOD_EAS.build, production: { env: { ...PUBLIC_ENV, EXPO_PUBLIC_IOS_DESIGN: '1' } } } } }, /比較用フラグ/);
  fails('秘密らしい公開変数', { env: { EXPO_PUBLIC_APPLE_PRIVATE_KEY: 'x' } }, /秘密になりうる/);
  fails('Android', { platform: 'android' }, /iPhone 専用/);
  fails('platform 空', { platform: '' }, /iPhone 専用/);
  fails('Apple サインインの権限が無い', { appJson: { expo: { ...GOOD_APP.expo, ios: { ...GOOD_APP.expo.ios, usesAppleSignIn: false } } } }, /usesAppleSignIn/);
  fails('暗号申告が無い', { appJson: { expo: { ...GOOD_APP.expo, ios: { ...GOOD_APP.expo.ios, config: {} } } } }, /暗号申告/);
});

test('ビルド前の検査: 空・未知の profile は止める（本番相当へ勝手に通さない）。development / simulator は比較用で、画面の案が未選択でも止めない', () => {
  for (const p of ['', undefined, 'staging', 'Production', 'prod', 'default', ' preview']) {
    const r = ev({ profile: p }) as { ok: boolean; kind: string };
    assert.deepEqual({ ok: r.ok, kind: r.kind }, { ok: false, kind: 'rejected' }, String(p));
  }
  for (const p of DEV_PROFILES) {
    assert.deepEqual(ev({ profile: p, selection: { approvedVariant: null }, appJson: { expo: { ...GOOD_APP.expo, ios: { ...GOOD_APP.expo.ios, bundleIdentifier: undefined } } } }), { ok: true, kind: 'dev', errors: [] }, p);
  }
  const bad = ev({ profile: 'development', easJson: { ...GOOD_EAS, build: { ...GOOD_EAS.build, development: { developmentClient: true, distribution: 'internal' } } } }) as { ok: boolean; errors: string[] };
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /EXPO_PUBLIC_IOS_DESIGN/.test(e)));
  // 実際の eas.json / app.json: 今は本人の選択も ID も無いので、製品ビルドは止まり、開発ビルドは（ソースの形が正しければ）通る
  const realApp = JSON.parse(read('app.json'));
  const realSel = JSON.parse(read('release-selection.json'));
  const prod = evaluateBuild({ profile: 'production', platform: 'ios', env: {}, appJson: realApp, easJson: REAL_EAS, pkgJson: PKG, selection: realSel, fs: cleanFs() });
  assert.equal(prod.ok, false);
  for (const re of [/未選択/, /bundleIdentifier/, /owner/, /projectId/, /API_BASE_URL/, /GOOGLE_IOS_CLIENT_ID/]) assert.ok(prod.errors.some((e: string) => re.test(e)), String(re));
  assert.deepEqual(evaluateBuild({ profile: 'development', platform: 'ios', env: {}, appJson: realApp, easJson: REAL_EAS, pkgJson: PKG, selection: realSel, fs: cleanFs() }), { ok: true, kind: 'dev', errors: [] });
  assert.deepEqual(evaluateBuild({ profile: 'simulator', platform: 'ios', env: {}, appJson: realApp, easJson: REAL_EAS, pkgJson: PKG, selection: realSel, fs: cleanFs() }), { ok: true, kind: 'dev', errors: [] });
});

test('ビルド前の検査: 送られるソースに兄弟の学習コア・素材が無い/私的な物・秘密が混ざっていると止まる（開発ビルドでも）', () => {
  assert.deepEqual(checkSourceTree(cleanFs()), []);
  assert.ok(checkSourceTree(cleanFs([], ['../src/mobile.ts'])).some((e: string) => /必要なソースが無い/.test(e)));
  assert.ok(checkSourceTree(cleanFs([], ['../design-assets'])).some((e: string) => /design-assets/.test(e)));
  for (const f of ['../AGENTS.md', '../CLAUDE.md', '../資格箱庭デザイン.md', '../data']) assert.ok(checkSourceTree(cleanFs([f])).some((e: string) => e.includes(f)), f);
  assert.ok(checkSourceTree(cleanFs(['../design-assets/ios-release-20261020'])).some((e: string) => /ios-release/.test(e)));
  assert.ok(checkSourceTree(cleanFs(['./.env'])).some((e: string) => /\.env/.test(e)));
  assert.ok(checkSourceTree(cleanFs(['../server/.dev.vars'])) .length === 0, '子のフォルダは対象外（mobile と その親だけを見る）');
  assert.ok(checkSourceTree(cleanFs(['./AuthKey_X.p8'])).some((e: string) => /p8/.test(e)));
  assert.ok(checkSourceTree(cleanFs(['./IOS_NATIVE_RECEIPT.json'])).some((e: string) => /受領記録/.test(e)));
  const r = ev({ profile: 'development', fs: cleanFs(['../AGENTS.md']) }) as { ok: boolean };
  assert.equal(r.ok, false);
});

function runHook(env: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(EAS_|EXPO_PUBLIC_)/.test(k)) clean[k] = v;
  return spawnSync(process.execPath, [join(mobile, 'scripts/eas-pre-install.mjs')], { cwd: mobile, env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30_000 });
}

test('EAS の hook(実プロセス): package.json の eas-build-pre-install に接続され、空/未知の profile・Android・未選択の製品ビルドは終了コード1で止まる', () => {
  assert.equal(PKG.scripts['eas-build-pre-install'], 'node scripts/eas-pre-install.mjs');
  assert.ok(existsSync(join(mobile, 'scripts/eas-pre-install.mjs')));
  const noDeps = read('scripts/eas-pre-install.mjs') + read('scripts/buildPolicy.mjs') + read('scripts/iosConfigCheck.mjs');
  assert.ok(![...noDeps.matchAll(/from '([^']+)'/g)].some((m) => !m[1]!.startsWith('node:') && !m[1]!.startsWith('./')), 'npm install より前に動くので、組み込み以外の依存を使わない');
  const run = (env: Record<string, string>) => runHook(env);
  const empty = run({});
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /EAS_BUILD_PROFILE が空/);
  const unknown = run({ EAS_BUILD_PROFILE: 'staging', EAS_BUILD_PLATFORM: 'ios' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知の profile/);
  const android = run({ EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'android' });
  assert.equal(android.status, 1);
  assert.match(android.stderr, /iPhone 専用/);
  for (const p of ['preview', 'production']) {
    const r = run({ EAS_BUILD_PROFILE: p, EAS_BUILD_PLATFORM: 'ios' });
    assert.equal(r.status, 1, p);
    assert.match(r.stderr, /画面のデザインが未選択/);
    assert.match(r.stderr, /bundleIdentifier/);
  }
  // 比較フラグが混ざっていれば、それも理由に出る
  const flagged = run({ EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'ios', EXPO_PUBLIC_IOS_DESIGN: '1' });
  assert.equal(flagged.status, 1);
  assert.match(flagged.stderr, /比較用フラグ/);
  // 開発ビルドは、画面の案が未選択でも「選択」を理由に止めない（今の元フォルダでは、ソースの形の検査で止まるのが正しい）
  const dev = run({ EAS_BUILD_PROFILE: 'development', EAS_BUILD_PLATFORM: 'ios' });
  assert.doesNotMatch(dev.stderr, /未選択/);
  assert.doesNotMatch(dev.stderr, /bundleIdentifier/);
});
