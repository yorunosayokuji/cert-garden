import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ClipLoadError, ClipLoader, assetUriOf } from '../src/state/clipLoader.ts';
import { clipLabel, moveWord, motionLabel, parseCatalog } from '../src/state/roomMotion.ts';

const raw = JSON.parse(readFileSync(new URL('../../design-assets/app-completion-20261020/runtime-motion-catalog-v2.json', import.meta.url), 'utf8')) as unknown;
const catalog = parseCatalog(raw);
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('準備: 頼んだファイルだけを読み、同じファイルの同時依頼は1回、読み終えるまで ready にならない', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const loader = new ClipLoader(async (f) => { calls.push(f); await gate; return true; });
  const files = ['a/1.png', 'a/2.png'];
  assert.equal(loader.isReady(files), false);
  const p1 = loader.ensure(files);
  const p2 = loader.ensure(['a/2.png', 'a/1.png']);
  assert.equal(loader.isReady(files), false, '読み込み中は ready ではない（時計を進めない）');
  release();
  await Promise.all([p1, p2]);
  assert.deepEqual(calls.sort(), ['a/1.png', 'a/2.png'], '同時依頼でも1回ずつ');
  assert.equal(loader.isReady(files), true);
  assert.equal(loader.isReady(['b/1.png']), false, '頼んでいない個体は準備しない（全26体の一斉先読みなし）');
  await loader.ensure(files);
  assert.equal(calls.length, 2, '準備済みは再読込しない');
});

test('失敗は黙った空白にせず ClipLoadError（失敗した枚数つき）。覚えずに再試行でき、成功すれば ready', async () => {
  let fail = true;
  const loader = new ClipLoader(async (f) => {
    if (f === 'x/2.png' && fail) throw new Error('network');
    if (f === 'x/3.png' && fail) return false;
    return true;
  });
  const files = ['x/1.png', 'x/2.png', 'x/3.png'];
  await assert.rejects(loader.ensure(files), (e: unknown) => e instanceof ClipLoadError && e.files.length === 2 && e.files.includes('x/2.png') && e.files.includes('x/3.png'));
  assert.equal(loader.isReady(files), false);
  assert.equal(loader.isReady(['x/1.png']), true, '読めた分は残る');
  fail = false;
  await loader.ensure(files);
  assert.equal(loader.isReady(files), true);
  loader.warm(['y/1.png']);
  const bad = new ClipLoader(async () => { throw new Error('x'); });
  assert.doesNotThrow(() => bad.warm(['z/1.png']), '先読みの失敗は表示を止めない');
});

test('実装: 時計は画像がそろうまで進めず、準備前は別の個体の絵を出さない（箱庭・相棒・確認画面）', () => {
  const crowd = read('../src/ui/RoomCrowd.tsx');
  assert.match(crowd, /useClipsReady\(chars/);
  assert.match(crowd, /!opts\.run \|\| !ready/);
  const sprite = read('../src/ui/CharacterSprite.tsx');
  assert.match(sprite, /run && status === 'ready'/);
  const check = read('../src/ui/MotionCheck.tsx');
  assert.match(check, /wantPlay && ready && active && !reduce/);
  assert.match(check, /lastShown\.current\?\.id === id/);
  assert.match(check, /読み込めませんでした/);
  assert.ok(!/prepareClips/.test(crowd + sprite + check), '準備の完了を待たない旧い先読みは使わない');
  const cat = read('../src/ui/motionCatalog.ts');
  assert.ok(!/MOTION_CATALOG\.characters[^;]{0,160}(ensureClips|warmClips|loader\.ensure|loader\.warm)/.test(cat), '全26体を一斉に先読みしない');
  for (const f of ['RoomCrowd.tsx', 'CharacterSprite.tsx', 'MotionCheck.tsx', 'useClips.ts']) assert.ok(!/MOTION_CATALOG\.characters/.test(read(`../src/ui/${f}`)), `${f} は全26体を走査しない`);
});

test('確認画面: 画面が前面でない/動きを減らすで止め、再生中は読み上げを更新せず停止中のコマ変更だけ知らせる', () => {
  const s = read('../src/ui/MotionCheck.tsx');
  assert.match(s, /useAppActive/);
  assert.match(s, /useReduceMotion/);
  assert.match(s, /accessibilityLiveRegion=\{playing \? 'none' : 'polite'\}/);
  assert.match(s, /aria-live=\{playing \? 'off' : 'polite'\}/);
  assert.match(s, /setWantPlay\(false\)/, 'コマ送りは停止して送る');
  assert.match(s, /clearTimeout/);
});

test('ラベル: 「歩く」固定をやめ、左右へすすむ等の共通語と、種類に合うことば。画像の説明も待機/移動/停止に合う', () => {
  assert.equal(clipLabel('walk_left'), '左へすすむ');
  assert.equal(clipLabel('walk_right'), '右へすすむ');
  assert.equal(clipLabel('idle'), '待機');
  assert.equal(clipLabel('start_right'), 'うごきだし（右）');
  assert.equal(clipLabel('stop_left'), 'とまる（左）');
  const by = (id: string) => catalog.characters.find((c) => c.id === id)!;
  assert.equal(moveWord('hopper'), 'はねて');
  assert.equal(moveWord('floating'), 'ふわふわと');
  assert.equal(moveWord('quadruped'), 'すすんで');
  assert.match(motionLabel(by('lavender'), { phase: 'walk', dir: 'right' }), /はねて/);
  assert.match(motionLabel(by('mint'), { phase: 'walk', dir: 'left' }), /ふわふわと/);
  assert.match(motionLabel(by('anzu'), { phase: 'idle', dir: 'left' }), /くつろいでいます/);
  assert.match(motionLabel(by('anzu'), { phase: 'stop', dir: 'left' }), /とまろう/);
  for (const c of catalog.characters) {
    for (const ph of ['idle', 'start', 'walk', 'stop']) assert.ok(!/歩/.test(motionLabel(c, { phase: ph, dir: 'left' })), `${c.id}/${ph}: 脚のない個体も含め「歩く」と言わない`);
  }
  for (const f of ['MotionCheck.tsx', 'Home.tsx']) assert.ok(!/ラベル.*歩|'歩く/.test(read(`../src/ui/${f}`)), f);
});

test('Webの実装に無いAPIを前提にしない: react-native-web の Image に resolveAssetSource は無く prefetch はある。アプリは前者を呼ばず Expo Asset で解決する', () => {
  const rnw = read('../node_modules/react-native-web/dist/exports/Image/index.js');
  assert.ok(!/resolveAssetSource/.test(rnw), 'この環境の react-native-web には Image.resolveAssetSource が無い');
  assert.match(rnw, /prefetch/);
  const cat = read('../src/ui/motionCatalog.ts');
  assert.ok(!/Image\.resolveAssetSource|resolveAssetSource\(/.test(cat), 'Webに無いNative APIを呼ばない');
  assert.match(cat, /from 'expo-asset'/);
  assert.match(cat, /Asset\.fromModule\(/);
  assert.match(cat, /Image\.prefetch\(uri\)/);
  const pkg = JSON.parse(read('../package.json')) as { dependencies: Record<string, string> };
  const installed = JSON.parse(read('../node_modules/expo-asset/package.json')) as { version: string };
  assert.equal(pkg.dependencies['expo-asset'], installed.version, '明示依存はインストール済みの版と一致');
  const lock = JSON.parse(read('../package-lock.json')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
  assert.equal(lock.packages['']!.dependencies!['expo-asset'], installed.version);
  assert.equal(lock.packages['node_modules/expo-asset']!.version, installed.version);
});

test('Expo Asset のURI: localUri 優先、無ければ uri。http(s)/file/data/サーバー相対だけ。空や不正は例外（空白でごまかさない）', () => {
  assert.equal(assetUriOf({ uri: '/assets/a.png' }), '/assets/a.png');
  assert.equal(assetUriOf({ uri: 'http://127.0.0.1:8098/assets/_a/01.png?platform=web' }), 'http://127.0.0.1:8098/assets/_a/01.png?platform=web');
  assert.equal(assetUriOf({ uri: 'http://x/a.png', localUri: 'file:///cache/a.png' }), 'file:///cache/a.png');
  assert.equal(assetUriOf({ uri: 'http://x/a.png', localUri: null }), 'http://x/a.png');
  for (const bad of [{}, { uri: '' }, { uri: 5 }, { uri: 'a.png' }, { uri: undefined, localUri: '' }]) assert.throws(() => assetUriOf(bad as never), /URI/);
});

test('実在する Image と同じ形の注入: resolveAssetSource を持たない Image で準備が成功する（Webの形）', async () => {
  const webImage = { prefetch: async (_u: string) => true } as { prefetch: (u: string) => Promise<boolean>; resolveAssetSource?: unknown };
  assert.equal(webImage.resolveAssetSource, undefined);
  const seen: string[] = [];
  const loader = new ClipLoader(async (f) => {
    const uri = assetUriOf({ uri: `/assets/${f}` }); // Expo Asset の形
    seen.push(uri);
    return webImage.prefetch(uri);
  });
  await loader.ensure(['a/1.png', 'a/2.png']);
  assert.deepEqual(seen.sort(), ['/assets/a/1.png', '/assets/a/2.png']);
  assert.equal(loader.isReady(['a/1.png', 'a/2.png']), true);
});

test('結果画面: 旧3体の固定表示をやめ、選んだ学習の相棒を待機の姿で出す。未制作の喜び動作を作らない', () => {
  const s = read('../src/ui/Complete.tsx');
  assert.match(s, /companion: CharacterId/);
  assert.match(s, /<CharacterSprite id=\{companion\}/);
  assert.ok(!/COMPANION_IDS|COMPANION_NAMES|<Sprite|celebrate|クリーム|ラベンダー|アプリコット/.test(s));
  assert.match(s, /といっしょに終えました/);
  const app = read('../src/App.tsx');
  assert.match(app, /companion=\{c\.roster\.companion\}/);
});
