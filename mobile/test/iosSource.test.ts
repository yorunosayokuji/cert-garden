// I5 点検後の修理: EAS へ送るソースの検査（実Gitの一時リポジトリ）・native 書き出しの種類・Expo設定（ATS / FaceID）・製品から動きの見くらべを外す。
// 注意: 実際のEAS送信・ネイティブのコンパイル・署名・実機は確認していない。ここは検査そのものを実際に動かして確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HERMES_MAGIC, MODES, exportArgs, hasString, verifyNativeExport } from '../scripts/nativeExport.mjs';
import { checkSourceRoot, isSafeRelPath } from '../scripts/sourcePreflight.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, '..');
const read = (p: string) => readFileSync(join(mobile, p), 'utf8');
const PKG = JSON.parse(read('package.json'));

// ================= EAS へ送るソースの検査（実Git） =================

function sh(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, '.no-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const BASE_FILES: Record<string, string> = {
  'package.json': '{"name":"cert-garden-core"}\n',
  'src/mobile.ts': 'export const x = 1;\n',
  'mobile/package.json': '{}\n',
  'mobile/eas.json': '{}\n',
  'mobile/app.json': '{}\n',
  'mobile/index.ts': 'export {};\n',
  'mobile/release-selection.json': '{"approvedVariant":null}\n',
  'design-assets/a.png': 'PNG-bytes-a',
  '.gitattributes': '* -text\n',
  // 公開用の写しのテンプレート(release/template/gitignore.txt)と同じ種類の生成物の無視
  '.gitignore': 'node_modules/\ndist/\ndist-native/\ndist-native-compare/\ndist-native-flag/\n.expo/\n.env\n.env.*\n',
};
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

interface Mirror {
  parent: string;
  app: string;
  mobile: string;
}
/** 公開済みの写しと同じ形（PUBLISH_MANIFEST.json + 専用 Git + 1コミット）を作る。opts で壊し方を指定する */
function makeMirror(opts: { manifestFiles?: (f: { path: string; size: number; sha256: string }[]) => unknown[]; manifestOwner?: string; extraCommitted?: Record<string, string>; skipGit?: boolean; gitAt?: 'app' | 'parent'; noCommit?: boolean; omitManifest?: boolean; transform?: (files: Record<string, string>) => void } = {}): Mirror {
  const parent = mkdtempSync(join(tmpdir(), 'cg-mirror-'));
  const app = join(parent, 'app');
  const files = { ...BASE_FILES, ...(opts.extraCommitted ?? {}) };
  opts.transform?.(files);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(app, p)), { recursive: true });
    writeFileSync(join(app, p), c);
  }
  const listed = Object.entries(BASE_FILES).map(([path, c]) => ({ path, size: Buffer.byteLength(c), sha256: sha(c) }));
  if (!opts.omitManifest) writeFileSync(join(app, 'PUBLISH_MANIFEST.json'), JSON.stringify({ owner: opts.manifestOwner ?? 'cert-garden-release-mirror/v1', schema: 1, files: opts.manifestFiles ? opts.manifestFiles(listed) : listed }));
  if (!opts.skipGit) {
    const g = opts.gitAt === 'parent' ? parent : app;
    sh(g, 'init', '-q');
    sh(g, 'config', 'core.autocrlf', 'false');
    sh(g, 'add', '-A');
    if (!opts.noCommit) sh(g, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x');
  }
  return { parent, app, mobile: join(app, 'mobile') };
}

const dirs: string[] = [];
function mk(opts: Parameters<typeof makeMirror>[0] = {}, after?: (m: Mirror) => void) {
  const m = makeMirror(opts);
  dirs.push(m.parent);
  after?.(m);
  return { m, r: checkSourceRoot(m.mobile) as { ok: boolean; errors: string[] } };
}
const has = (r: { errors: string[] }, re: RegExp) => r.errors.some((e) => re.test(e));
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('ソース検査(実Git): 公開済みの写し(clean・専用Git・HEAD=index=作業ツリー=manifest のバイト)だけが通る。生成物(node_modules / dist-native)が増えても通る', () => {
  const { r } = mk({}, (m) => {
    mkdirSync(join(m.mobile, 'node_modules/x'), { recursive: true });
    writeFileSync(join(m.mobile, 'node_modules/x/i.js'), 'x');
    mkdirSync(join(m.mobile, 'dist-native'), { recursive: true });
    writeFileSync(join(m.mobile, 'dist-native/b.hbc'), 'x');
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('ソース検査(実Git): 同じ大きさの改変・dirty・staged・untracked・コミット前・削除の準備済みを拒否する', () => {
  // 同じ大きさの改変（コミット済みなので Git は clean。manifest の sha256 だけが違う）
  const same = mk({ transform: (f) => (f['src/mobile.ts'] = 'export const x = 2;\n') });
  assert.equal(same.r.ok, false);
  assert.ok(has(same.r, /同じ大きさの改変/), same.r.errors.join(' / '));
  // 作業ツリーの未コミットの変更（dirty）
  const dirty = mk({}, (m) => writeFileSync(join(m.app, 'src/mobile.ts'), 'export const x = 3;\n'));
  assert.ok(has(dirty.r, /clean ではありません/) && has(dirty.r, /同じ大きさの改変|HEAD の内容と作業ツリーが違う/));
  // staged（git add 済み・未コミットの新規）
  const staged = mk({}, (m) => {
    writeFileSync(join(m.app, 'extra.ts'), 'x');
    sh(m.app, 'add', 'extra.ts');
  });
  assert.ok(has(staged.r, /clean ではありません/) && has(staged.r, /index にあって HEAD に無い/));
  // untracked
  const untracked = mk({}, (m) => writeFileSync(join(m.app, 'note.txt'), 'private'));
  assert.ok(has(untracked.r, /clean ではありません/) && has(untracked.r, /追跡されていない/));
  // 削除の準備済み（git rm）
  const removed = mk({}, (m) => sh(m.app, 'rm', '-q', 'design-assets/a.png'));
  assert.ok(has(removed.r, /clean ではありません/) && has(removed.r, /manifest にあるファイルが無い|HEAD にあって index に無い/));
  // コミットが無い
  const noCommit = mk({ noCommit: true });
  assert.ok(has(noCommit.r, /コミット\(HEAD\)がありません/));
});

test('ソース検査(実Git): 私的な物(AGENTS.md・.env・受領記録)は、コミット済み・manifest 記載でも拒否。manifest に無い追跡ファイルも拒否', () => {
  for (const [p, c] of [['AGENTS.md', '私的な指示'], ['mobile/IOS_NATIVE_RECEIPT.json', '{}'], ['mobile/.env', 'SECRET=1']] as const) {
    const { r } = mk({
      extraCommitted: { [p]: c },
      manifestFiles: (l) => [...l, { path: p, size: Buffer.byteLength(c), sha256: sha(c) }],
    });
    assert.equal(r.ok, false, p);
    assert.ok(has(r, /公開できない物が混ざっている|秘密になりうる|私的な受領記録/), `${p}: ${r.errors.join(' / ')}`);
  }
  const tracked = mk({ extraCommitted: { 'server/note.ts': 'x' } });
  assert.ok(has(tracked.r, /manifest に無いファイルが追跡されています: server\/note\.ts/));
});

test('ソース検査(実Git): Git の根が違う/Git が無い/manifest の欠落・不正(パス・重複・sha・owner・自己記載)・必要ソースの欠落を拒否', () => {
  assert.ok(has(mk({ gitAt: 'parent' }).r, /専用ではありません/));
  assert.ok(has(mk({ skipGit: true }).r, /Git の作業ツリーがありません/));
  assert.ok(has(mk({ omitManifest: true }).r, /PUBLISH_MANIFEST\.json がありません/));
  assert.ok(has(mk({ manifestOwner: 'someone-else' }).r, /形が正しくありません/));
  const bad = (name: string, fn: (l: { path: string; size: number; sha256: string }[]) => unknown[], re: RegExp) => assert.ok(has(mk({ manifestFiles: fn }).r, re), name);
  bad('パスに ..', (l) => [...l, { path: '../outside.txt', size: 1, sha256: sha('x') }], /不正な項目/);
  bad('絶対パス', (l) => [...l, { path: '/etc/x', size: 1, sha256: sha('x') }], /不正な項目/);
  bad('バックスラッシュ', (l) => [...l, { path: 'a\\b.txt', size: 1, sha256: sha('x') }], /不正な項目/);
  bad('ドライブ', (l) => [...l, { path: 'C:/x.txt', size: 1, sha256: sha('x') }], /不正な項目/);
  bad('.git の中', (l) => [...l, { path: '.git/config', size: 1, sha256: sha('x') }], /不正な項目/);
  bad('sha256 が不正', (l) => l.map((f, i) => (i === 0 ? { ...f, sha256: 'zz' } : f)), /不正な項目/);
  bad('size が負', (l) => l.map((f, i) => (i === 0 ? { ...f, size: -1 } : f)), /不正な項目/);
  bad('パスの重複', (l) => [...l, l[0]!], /重複/);
  bad('大文字小文字だけ違う重複', (l) => [...l, { ...l[0]!, path: l[0]!.path.toUpperCase() }], /重複|不正/);
  bad('自分自身', (l) => [...l, { path: 'PUBLISH_MANIFEST.json', size: 1, sha256: sha('x') }], /自分自身/);
  bad('manifest にあるが無いファイル', (l) => [...l, { path: 'nope.ts', size: 1, sha256: sha('x') }], /manifest にあるファイルが HEAD に無い|manifest にあるファイルが無い/);
  bad('manifest の項目が欠けている(追跡が余る)', (l) => l.slice(1), /manifest に無いファイルが追跡されています/);
  const noReq = mk({ transform: (f) => delete f['mobile/release-selection.json'], manifestFiles: (l) => l.filter((x) => x.path !== 'mobile/release-selection.json') });
  assert.ok(has(noReq.r, /必要なソースが無い: mobile\/release-selection\.json/));
});

test('ソース検査(実Git): root の外へ出るリンク(junction / symlink)・循環するリンク・mobile 自体のリンクを拒否する。リンクの先は辿らない', () => {
  const outside = mkdtempSync(join(tmpdir(), 'cg-outside-'));
  dirs.push(outside);
  writeFileSync(join(outside, 'secret.txt'), 'private');
  const out = mk({}, (m) => symlinkSync(outside, join(m.app, 'linked-out'), 'junction'));
  assert.equal(out.r.ok, false);
  assert.ok(has(out.r, /リンク/), out.r.errors.join(' / '));
  assert.ok(!out.r.errors.some((e) => /追跡されていない.*secret\.txt|manifest.*secret\.txt/.test(e)), '先のファイルを自分では辿らない（git status の一覧は別）');
  // 循環: 自分の親を指す junction（辿ると無限に深くなる）
  const loop = mk({}, (m) => symlinkSync(m.app, join(m.mobile, 'loop'), 'junction'));
  assert.equal(loop.r.ok, false);
  assert.ok(has(loop.r, /リンク/));
  // ファイルの symlink（権限が無い環境では作れないので、作れた時だけ確かめる）
  let fileLinkTested = false;
  const fl = mk({}, (m) => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(m.app, 'secret-link.txt'), 'file');
      fileLinkTested = true;
    } catch {
      /* EPERM: Windows の権限。junction の試験で代える */
    }
  });
  if (fileLinkTested) assert.ok(has(fl.r, /リンク/));
  // mobile 自体が別の場所への junction
  const real = mk({});
  const mobileLinked = mkdtempSync(join(tmpdir(), 'cg-mlink-'));
  dirs.push(mobileLinked);
  mkdirSync(join(mobileLinked, 'app'));
  symlinkSync(real.m.mobile, join(mobileLinked, 'app/mobile'), 'junction');
  const viaLink = checkSourceRoot(join(mobileLinked, 'app/mobile')) as { ok: boolean; errors: string[] };
  assert.equal(viaLink.ok, false);
});

test('ソース検査: パスの安全性の規則と、元の AI制作 フォルダでの拒否(スクリプトの終了コード1)。EAS の build / submit は呼ばない。manifest は書き換えない', () => {
  for (const ok of ['a.ts', 'mobile/src/a.tsx', '.gitattributes', '.github/workflows/ci.yml', 'design-assets/a b.png']) assert.equal(isSafeRelPath(ok), true, ok);
  for (const bad of ['', '/a', '../a', 'a/../b', 'a//b', './a', 'a\\b', 'C:/a', '.git/x', 'a/.GIT/b', 'a\0b', 'a/', 'a/b ', 'a/b.', 'x'.repeat(401), 'a:b', 'a?b', 5, null, undefined]) assert.equal(isSafeRelPath(bad as string), false, String(bad));
  const script = spawnSync(process.execPath, [join(mobile, 'scripts/check-eas-source.mjs')], { cwd: mobile, encoding: 'utf8', timeout: 90_000 });
  if (existsSync(join(mobile, '..', 'AGENTS.md')) || existsSync(join(mobile, '..', 'design-assets', 'ios-release-20261020'))) {
    assert.equal(script.status, 1, '元のフォルダは拒否が正しい');
    assert.match(script.stderr, /Git|PUBLISH_MANIFEST|公開できない/);
  } else {
    assert.equal(script.status, (checkSourceRoot(mobile) as { ok: boolean }).ok ? 0 : 1);
  }
  const src = read('scripts/sourcePreflight.mjs');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /writeFileSync|rmSync|unlinkSync|renameSync|appendFileSync|'push'|'commit'|'add'|spawn(Sync)?\([^)]*['"]eas['"]|fetch\(/, '読むだけ。書き込み・push・EAS・通信なし');
});

// ================= native の書き出しの種類 =================

test('書き出しの種類: product は配布相当(--dev なし)、compare-dev は --dev + 比較フラグ、flag-release はフラグだけの補助出力で、出力先が別', () => {
  assert.deepEqual(exportArgs('product'), ['export', '--platform', 'ios', '--output-dir', 'dist-native', '--clear']);
  assert.deepEqual(exportArgs('flag-release'), ['export', '--platform', 'ios', '--output-dir', 'dist-native-flag', '--clear']);
  assert.deepEqual(exportArgs('compare-dev'), ['export', '--platform', 'ios', '--output-dir', 'dist-native-compare', '--clear', '--dev', '--no-minify']);
  for (const m of ['product', 'flag-release']) assert.ok(!exportArgs(m).some((a) => /^--(dev|no-minify|no-bytecode)$/.test(a)), `${m} は配布相当`);
  assert.deepEqual(Object.values(MODES).map((m) => m.flag), ['', '1', '1']);
  assert.equal(new Set(Object.values(MODES).map((m) => m.out)).size, 3);
  assert.throws(() => exportArgs('compare'));
  // expo CLI が実際にこれらの引数を持つ（インストール済み SDK57 の @expo/cli の export）
  const cli = readFileSync(join(mobile, 'node_modules/expo/node_modules/@expo/cli/build/src/export/index.js'), 'utf8');
  for (const f of ['--dev', '--no-minify', '--no-bytecode', '--output-dir', '--clear', '--platform']) assert.ok(cli.includes(`'${f}'`), f);
  const s = read('scripts/export-native.mjs');
  assert.match(s, /exportArgs\(mode\)/);
  assert.equal(PKG.scripts['export:ios'], 'node scripts/export-native.mjs product');
  assert.equal(PKG.scripts['export:ios:compare-dev'], 'node scripts/export-native.mjs compare-dev');
  assert.equal(PKG.scripts['export:ios:flag-release'], 'node scripts/export-native.mjs flag-release');
  assert.equal(PKG.scripts['export:ios:ios-design'], undefined, '紛らわしい旧名は残さない');
});

function fakeExport(bundle: Buffer, opts: { assets?: number; platforms?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-exp-'));
  dirs.push(dir);
  const rel = '_expo/static/js/ios/index-x.hbc';
  mkdirSync(join(dir, '_expo/static/js/ios'), { recursive: true });
  writeFileSync(join(dir, rel), bundle);
  const assets = [];
  for (let i = 0; i < (opts.assets ?? 3); i++) {
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, `assets/a${i}`), 'img');
    assets.push({ path: `assets/a${i}`, ext: 'png' });
  }
  const fileMetadata: Record<string, unknown> = { ios: { bundle: rel, assets } };
  for (const p of opts.platforms ?? []) fileMetadata[p] = { bundle: 'x', assets: [] };
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ version: 0, bundler: 'metro', fileMetadata }));
  return dir;
}
const u16 = (...s: string[]) => s.map((x) => Buffer.from(x, 'utf16le'));
const hbc = (...s: string[]) => Buffer.concat([HERMES_MAGIC, Buffer.alloc(120_000, 1), ...u16(...s)]);
const esc = (s: string) => [...s].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('');
/** 開発用のJS(プレーンテキスト。日本語は \uXXXX)の見本 */
const devJs = (opts: { dev?: boolean; flag?: boolean; lab?: boolean; chrome?: boolean } = {}) =>
  Buffer.from(
    `${'/*pad*/'.repeat(20_000)}\nvar __DEV__=${opts.dev === false ? 'false' : 'true'};\nvar cfg={buildFlag:${opts.flag === false ? 'void 0' : '"1"'}};\n` +
      `${opts.chrome === false ? '' : `"${esc('読込を固定')}";"compare:v1";`}${opts.lab === false ? '' : `"${esc('見かたの注意')}";"${esc('26匹の待機と、左右へすすむ動きを確かめる画面です')}";"${esc('反転や逆再生はしていません')}";`}`,
  );
const run = (b: Buffer, mode: string, o: { assets?: number; platforms?: string[] } = {}) => verifyNativeExport(fakeExport(b, o), mode as never) as { ok: boolean; errors: string[]; info: { hermes: boolean; dev: boolean } };

test('書き出しの検査: product は Hermes 必須で、比較の道具・動きの見くらべ・旧画面の文字列があれば拒否', () => {
  assert.deepEqual(run(hbc('起動できません', '結果'), 'product').errors, []);
  assert.equal(run(hbc('結果'), 'product').ok, false, '製品の文字列が無い');
  for (const s of ['読込を固定', '見かたの注意', '26匹の待機と、左右へすすむ動きを確かめる画面です', '反転や逆再生はしていません', 'armReadFailure']) {
    assert.equal(run(hbc('起動できません', '結果', s), 'product').ok, false, s);
  }
  assert.ok(run(Buffer.concat([hbc('起動できません', '結果'), Buffer.from('compare:v1')]), 'product').errors.some((e) => /compare:v1/.test(e)), 'ASCII でも検出');
  assert.ok(run(Buffer.concat([hbc('起動できません', '結果'), Buffer.from(esc('見かたの注意'))]), 'product').errors.some((e) => /見かたの注意/.test(e)), '\\uXXXX でも検出');
  assert.ok(run(hbc('起動できません', '結果', '箱庭をひらいています…'), 'product').errors.some((e) => /旧画面/.test(e)));
  assert.ok(run(Buffer.alloc(200_000, 7), 'product').errors.some((e) => /Hermes/.test(e)), 'Hermes でない(--no-bytecode / --dev 相当)は配布用にしない');
  assert.ok(run(devJs(), 'product').errors.some((e) => /Hermes/.test(e)));
  assert.ok(run(hbc('起動できません', '結果'), 'product', { assets: 0 }).errors.some((e) => /assets が0件/.test(e)));
  assert.ok(run(hbc('起動できません', '結果'), 'product', { platforms: ['android'] }).errors.some((e) => /ios 以外/.test(e)));
  assert.equal(verifyNativeExport('C:/no/such/dir', 'product').ok, false);
  assert.equal(verifyNativeExport(fakeExport(hbc('x')), 'compare' as never).ok, false, '旧名は受け付けない');
  assert.ok(hasString(Buffer.from('abc'), 'abc') && hasString(Buffer.from('あ', 'utf16le'), 'あ') && hasString(Buffer.from('\\u3042'), 'あ') && hasString(Buffer.from('\\u3042'.toUpperCase().replace('\\U', '\\u')), 'あ') && !hasString(Buffer.from('abc'), 'abd'));
});

test('書き出しの検査: compare-dev は本当の開発入口に達するJS(__DEV__=true・比較フラグ"1"・比較の道具・動きの見くらべ)。flag-only や Hermes の出力を比較 native の証明にしない', () => {
  const ok = run(devJs(), 'compare-dev');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.info.hermes, false);
  assert.equal(ok.info.dev, true);
  // 直前の誤り（フラグだけの release 出力を比較 native として通す）を拒否する
  assert.ok(run(devJs({ dev: false }), 'compare-dev').errors.some((e) => /__DEV__ が true/.test(e)), '__DEV__ が false の出力は比較の入口に達しない');
  assert.ok(run(devJs({ flag: false }), 'compare-dev').errors.some((e) => /比較フラグ/.test(e)));
  assert.ok(run(devJs({ lab: false }), 'compare-dev').errors.some((e) => /動きの見くらべ/.test(e)));
  assert.ok(run(devJs({ chrome: false }), 'compare-dev').errors.some((e) => /読込を固定|compare:v1/.test(e)));
  assert.ok(run(hbc('読込を固定', 'compare:v1', '見かたの注意', '26匹の待機と、左右へすすむ動きを確かめる画面です', '反転や逆再生はしていません'), 'compare-dev').errors.some((e) => /Hermes/.test(e)), 'Hermes の出力は --dev が効いていない');
  // flag-release: 配布相当(Hermes)で、比較の道具は入る(フラグだけ)。旧画面の文字列は無い。比較 native の検証には数えない
  assert.equal(run(hbc('読込を固定', 'compare:v1'), 'flag-release').ok, true);
  assert.equal(run(devJs(), 'flag-release').ok, false);
  assert.ok(run(hbc('読込を固定', 'compare:v1', '箱庭をひらいています'), 'flag-release').errors.some((e) => /旧画面/.test(e)));
});

// ================= 入口の判定は dev の有無で変わる（native） =================

test('入口(native): 比較フラグだけ(__DEV__=false)の出力は比較へ入らず、--dev + フラグの出力は比較へ入る。署名版が比較を開けない境界は弱めていない', async () => {
  const { decideEntry } = await import('../src/ios/entry.ts');
  const ctx = (isDev: boolean, buildFlag?: string) => ({ platform: 'ios', isDev, buildFlag, search: '', selection: { approvedVariant: null } });
  assert.equal(decideEntry(ctx(true, '1')).kind, 'compare', 'compare-dev の出力が達する入口');
  assert.equal(decideEntry(ctx(false, '1')).kind, 'refuse', 'flag-release の出力が達する入口（署名版と同じ）');
  assert.equal(decideEntry(ctx(false, undefined)).kind, 'refuse');
  assert.equal(decideEntry({ ...ctx(false, '1'), selection: { approvedVariant: 4 } }).kind, 'product');
});

// ================= Expo の設定（実CLI introspect）: ATS と FaceID =================

function introspect(env: Record<string, string | undefined>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(EAS_|EXPO_PUBLIC_)/.test(k)) clean[k] = v;
  const r = spawnSync(process.execPath, [join(mobile, 'node_modules/expo/bin/cli'), 'config', '--type', 'introspect', '--json'], { cwd: mobile, env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 180_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
}
const CLIENT = '123456789012-abcdefghijklmnop.apps.googleusercontent.com'; // ダミー（形だけ）

test('Expo設定(実CLI introspect): 製品相当のビルドは ATS を無効にせず(NSAllowsArbitraryLoads=false・例外なし)、使っていない FaceID の文言を要求しない', () => {
  for (const env of [{ EAS_BUILD_PROFILE: 'production' }, { EAS_BUILD_PROFILE: 'preview' }, { EAS_BUILD_PROFILE: 'staging' }, {}]) {
    const cfg = introspect({ ...env, EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: CLIENT });
    assert.deepEqual(cfg.ios.infoPlist.NSAppTransportSecurity, { NSAllowsArbitraryLoads: false }, JSON.stringify(env));
    assert.equal(cfg.ios.infoPlist.NSFaceIDUsageDescription, undefined, `FaceID の文言: ${JSON.stringify(env)}`);
    assert.deepEqual(cfg.ios.entitlements['com.apple.developer.applesignin'], ['Default']);
    assert.equal(cfg.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
    assert.equal(cfg.ios.supportsTablet, false);
    const schemes = cfg.ios.infoPlist.CFBundleURLTypes.flatMap((t: { CFBundleURLSchemes: string[] }) => t.CFBundleURLSchemes);
    assert.ok(schemes.includes('certgarden') && schemes.includes('com.googleusercontent.apps.123456789012-abcdefghijklmnop'));
    assert.equal(cfg.ios.bundleIdentifier, 'com.placeholder.appid', 'Expo が補う仮の値。本物のIDは作っていない');
  }
});

test('Expo設定(実CLI introspect): 開発のビルド(EAS の development / simulator、または EAS の外で比較フラグ=1)は Expo の既定の ATS（開発サーバーへの http）を残す。FaceID の文言はここでも要求しない', () => {
  const baseline = introspect({ EAS_BUILD_PROFILE: 'production' }).ios.infoPlist.NSAppTransportSecurity;
  for (const env of [{ EAS_BUILD_PROFILE: 'development' }, { EAS_BUILD_PROFILE: 'simulator' }, { EXPO_PUBLIC_IOS_DESIGN: '1' }]) {
    const cfg = introspect(env);
    const ats = cfg.ios.infoPlist.NSAppTransportSecurity;
    assert.notDeepEqual(ats, baseline, `開発は製品と同じ設定にしない: ${JSON.stringify(env)}`);
    assert.equal(ats.NSAllowsArbitraryLoads, true, `Expo の既定（開発用）を保つ: ${JSON.stringify(env)}`);
    assert.equal(cfg.ios.infoPlist.NSFaceIDUsageDescription, undefined);
  }
  // profile が分かる時は profile が優先: 製品の profile に比較フラグが混ざっても、ATS は緩めない
  assert.deepEqual(introspect({ EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_IOS_DESIGN: '1' }).ios.infoPlist.NSAppTransportSecurity, { NSAllowsArbitraryLoads: false });
});

test('Expo設定: app.config.js の判定は純粋関数で、app.json に FaceID を生体認証の用途で書き足していない(生体認証の機能は追加しない)', async () => {
  const mod = (await import('../app.config.js')) as unknown as { isDevBuild: (e: Record<string, string>) => boolean };
  const isDev = mod.isDevBuild;
  assert.equal(isDev({ EAS_BUILD_PROFILE: 'development' }), true);
  assert.equal(isDev({ EAS_BUILD_PROFILE: 'simulator' }), true);
  for (const p of ['preview', 'production', 'staging', 'Development', ' development']) assert.equal(isDev({ EAS_BUILD_PROFILE: p, EXPO_PUBLIC_IOS_DESIGN: '1' }), false, p);
  assert.equal(isDev({ EXPO_PUBLIC_IOS_DESIGN: '1' }), true);
  assert.equal(isDev({ EXPO_PUBLIC_IOS_DESIGN: '0' }), false);
  assert.equal(isDev({}), false);
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-secure-store'), ['expo-secure-store', { faceIDPermission: false }]);
  assert.ok(!JSON.stringify(app).includes('NSFaceIDUsageDescription'));
  assert.ok(!JSON.stringify(PKG.dependencies).includes('local-authentication'));
  assert.doesNotMatch(readFileSync(join(mobile, 'src/account/native.ts'), 'utf8'), /requireAuthentication/);
});

// ================= 製品から動きの見くらべ(lab)を外す・起動時の骨組み =================

function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(mobile, entry)];
  const re = /^[ \t]*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(re)) {
      const target = resolve(dirname(f), (m[1] ?? m[2])!);
      if (!target.startsWith(join(mobile, 'src'))) continue;
      const stem = target.replace(/\.(ts|tsx)$/, '');
      for (const ext of ['.ts', '.tsx', '.web.ts', '.web.tsx']) if (existsSync(stem + ext)) stack.push(stem + ext);
    }
  }
  return new Set([...seen].map((p) => p.slice(mobile.length + 1).replaceAll('\\', '/')));
}

test('製品から lab を外す: 製品の依存の木に MotionCheck / MotionLab / MotionStudy が無く、箱庭に「新しい動き」の入口が描かれない。比較の木には全26体の既存 lab がある', () => {
  const product = graph('src/ios/ProductApp.tsx');
  const compare = graph('src/ios/IosDesignApp.tsx');
  for (const f of product) assert.doesNotMatch(f, /Motion(Check|Lab|Study)|motionStudy|motionLab|RigWalker|gaitRig|LabSprite/i, `製品の依存に ${f}`);
  assert.ok(compare.has('src/ui/MotionCheck.tsx'), '比較には既存の lab が残っている');
  assert.ok(!product.has('src/ui/MotionCheck.tsx'));
  // 構造: Home は onOpenLab が渡された時だけ入口を描く／製品は渡さない／比較だけが renderLab を渡す
  assert.match(read('src/ui/Home.tsx'), /\{onOpenLab \? \(\s*<Pressable onPress=\{\(\) => onOpenLab\('v3'\)\}/);
  assert.match(read('src/ui/Home.tsx'), /onOpenLab\?: \(tab: LabTab\) => void/);
  assert.match(read('src/ios/Runner.tsx'), /openLab: compare\?\.renderLab \? setLab : undefined/);
  assert.match(read('src/ios/Flow.tsx'), /if \(lab && renderLab\) return renderLab\(/);
  assert.doesNotMatch(read('src/ios/Flow.tsx'), /MotionCheck/);
  assert.match(read('src/ios/IosDesignApp.tsx'), /renderLab: \(initialId: string, onBack: \(\) => void\) => <MotionCheck/);
  assert.doesNotMatch(read('src/ios/ProductApp.tsx'), /renderLab|MotionCheck|compare=/);
  // 旧画面は従来どおり入口を渡す（Web の通常は変えない）
  assert.match(read('src/App.tsx'), /onOpenLab=\{setLab\}/);
});

test('起動時の骨組み: ProductApp は見える空間の確定前に個人のデータを描かず、全画面の骨組みを出す。人工の待ちはなく、確定(account.init の完了)で切り替わる', () => {
  const s = read('src/ios/ProductApp.tsx');
  assert.match(s, /accountReady \? <Runner [^>]*\/> : <BootSkeleton \/>/);
  assert.doesNotMatch(s, /accountReady \? <Runner[^:]*: null/);
  const code = s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /setTimeout|delayMs:\s*[1-9]|minShow|useMinShow/);
  assert.match(s, /<LoadView kind="home" skeleton \/>/);
  assert.match(s, /useOsReduceMotion\(\)/);
  assert.match(s, /void account\.init\(\)\.finally\(\(\) => alive && setAccountReady\(true\)\)/);
  assert.match(read('src/ios/Skeletons.tsx'), /accessibilityState=\{\{ busy: true \}\}/);
  assert.match(read('src/ios/Skeletons.tsx'), /if \(reduce \|\| !active\)/);
});
