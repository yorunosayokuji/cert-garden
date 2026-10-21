// 親のCua確認で見つかった不具合の修理（候補2の文字・Web操作の選択状態・シートの焦点・結果の整理・依存・dev client）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { problems } from '../scripts/iosConfigCheck.mjs';
import { wrapIndex } from '../src/ios/webFocus.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('dev client: developmentClient のビルドには expo-dev-client が要り、無ければビルド前の検査が止める。development に比較入口の環境変数がある', () => {
  const app = JSON.parse(read('../app.json'));
  const eas = JSON.parse(read('../eas.json'));
  const pkg = JSON.parse(read('../package.json'));
  assert.ok(pkg.dependencies['expo-dev-client'], '導入済み');
  assert.deepEqual(problems(app, eas, pkg), []);
  const deps = { ...pkg.dependencies };
  delete deps['expo-dev-client'];
  assert.ok(problems(app, eas, { ...pkg, dependencies: deps }).some((p: string) => p.includes('expo-dev-client')));
  assert.equal(eas.build.development.env.EXPO_PUBLIC_IOS_DESIGN, '1');
  assert.equal(eas.build.simulator.extends, 'development');
  // preview/production の env は公開してよい Google iOS client ID だけ（比較入口の環境変数は無い）
  assert.deepEqual(Object.keys(eas.build.preview.env), ['EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID']);
  assert.deepEqual(Object.keys(eas.build.production.env), ['EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID']);
  assert.equal(eas.build.development.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID, '99697541013-7vqs8qopvg0vtdi5q9kmc2k0jjl0fhgv.apps.googleusercontent.com');
  assert.ok(problems(app, { build: { ...eas.build, development: { ...eas.build.development, env: {} } } }, pkg).some((p: string) => p.includes('EXPO_PUBLIC_IOS_DESIGN')));
});

test('Web出力: 通常版は確認用フラグを空にして変換キャッシュを使わず、確認用版は別の出力先。キャッシュ由来の取り違えを起こさない', () => {
  const s = JSON.parse(read('../package.json')).scripts;
  assert.match(s['export:web'], /EXPO_PUBLIC_IOS_DESIGN= -- expo export --platform web --clear/);
  assert.match(s['export:web:ios-design'], /EXPO_PUBLIC_IOS_DESIGN=1 -- expo export --platform web --clear --output-dir dist-ios-design/);
  assert.match(s['check:ios-config:build'], /--build/);
});

test('依存: uuid の上書き(xcode配下だけ)後も xcode が UUID を作れる。上書きは他に及ばない', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.deepEqual(pkg.overrides, { xcode: { uuid: '^11.1.1' } });
  const req = createRequire(new URL('../package.json', import.meta.url));
  const xcodeReq = createRequire(req.resolve('xcode'));
  assert.match(xcodeReq('uuid/package.json').version, /^11\./);
  // xcode が使うのは uuid.v4() だけ（バッファ指定の v3/v5/v6 は呼ばない＝助言の対象外でもある）
  assert.match(xcodeReq('uuid').v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(typeof req('xcode').project, 'function');
  assert.match(readFileSync(req.resolve('xcode/lib/pbxProject.js'), 'utf8'), /uuid\.v4\(\)/);
});

test('Web操作: タブ/ラジオの選択状態を実DOMの aria-selected / aria-checked でも伝え、native の accessibilityState は残す', () => {
  const press = read('../src/ios/Press.tsx');
  assert.match(press, /'aria-selected': state\.selected/);
  assert.match(press, /'aria-checked': state\.checked/);
  assert.match(press, /accessibilityState=\{\{ disabled: !!disabled, \.\.\.state \}\}/);
  assert.match(press, /role=\{role\}/);
  const chrome = read('../src/ios/CompareChrome.tsx');
  assert.match(chrome, /role="radio"/);
  assert.match(chrome, /aria-checked=\{on\}/);
  assert.match(read('../src/ios/Nav.tsx'), /role="tablist"/);
});

test('Web操作: Tab は端で一周し、範囲の外から入ったら先頭/末尾へ。空なら移動しない', () => {
  assert.equal(wrapIndex(3, 2, false), 0);
  assert.equal(wrapIndex(3, 0, true), 2);
  assert.equal(wrapIndex(3, 1, false), 2);
  assert.equal(wrapIndex(3, 1, true), 0);
  assert.equal(wrapIndex(3, -1, false), 0);
  assert.equal(wrapIndex(3, -1, true), 2);
  assert.equal(wrapIndex(0, -1, false), -1);
});

test('シート: 開いたら中へ焦点・Tab一周・背景inert・閉じたら焦点を戻す。native の modal 指定は維持。画面外ページは inert', () => {
  const sheet = read('../src/ios/Sheet.tsx');
  assert.match(sheet, /inertOutside\(el\)/);
  assert.match(sheet, /trapTab\(el, e\)/);
  assert.match(sheet, /prev\.focus\(/);
  assert.match(sheet, /accessibilityViewIsModal/);
  assert.match(sheet, /aria-modal/);
  assert.match(sheet, /e\.key === 'Escape'/);
  assert.match(sheet, /focusable=\{false\}/);
  assert.match(read('../src/ios/webFocus.ts'), /data-product-frame/);
  assert.match(read('../src/ios/Runner.tsx'), /productFrame: '1'/);
  const v = read('../src/ios/Variants.tsx');
  assert.match(v, /setInert\(pages\.current\[0\]/);
  assert.match(v, /index !== 1/);
});

test('候補2: 暗い面の説明は明るい面の上の濃い文字。部屋の大きさは変えず、本体(standard)は変えない', () => {
  const home = read('../src/ui/Home.tsx');
  assert.match(home, /noteOnDark: \{ color: C\.ink, backgroundColor: C\.card/);
  assert.match(home, /const onDark = overlay && noteText !== ''/);
  assert.match(home, /chrome = 'standard'/);
});

test('結果(plain): 結果→正解数→行(学習時間・ポイント・合計・次の復習)→短い注意。重複見出しも長い免責もなく、本体の結果画面は残る', () => {
  const c = read('../src/ui/Complete.tsx');
  const start = c.indexOf('if (plain) {');
  const plain = c.slice(start, c.indexOf('\n  return (', start + 20));
  assert.match(plain, />結果<\/Text>/);
  assert.doesNotMatch(plain, /今回の結果/);
  assert.doesNotMatch(plain, /ごほうび/);
  assert.match(plain, /基礎テーマ1つの記録です。試験範囲すべての完了や合格を示すものではありません。/);
  assert.match(plain, /label: 'ポイント'/);
  assert.match(plain, /label: '次の復習'/);
  assert.match(c, /今回の結果/);
  assert.match(c, /ごほうび（仮）/);
});

test('比較帯: 選択肢の多い「読込を固定」は折り返して全項目を出し、タッチ目標は縮めない。畳める。比較帯の中だけの変更で、製品UIと本体には混ぜない', () => {
  const chrome = read('../src/ios/CompareChrome.tsx');
  assert.match(chrome, /toggle: \{[^}]*flexWrap: 'wrap'[^}]*maxWidth: '100%'/);
  assert.match(chrome, /toggleWide: \{ width: '100%'/);
  assert.match(chrome, /<Toggle wide label="読込を固定"/);
  assert.match(chrome, /minHeight: Platform\.OS === 'web' \? 36 : 44, minWidth: 44/, '選択肢の大きさは従来のまま');
  assert.match(chrome, /fold: \{[^}]*minHeight: 44/);
  assert.match(chrome, /aria-expanded=\{open\}/);
  for (const f of ['../src/App.tsx', '../src/Root.tsx', '../src/ui/common.tsx', '../src/ui/theme.ts']) assert.doesNotMatch(read(f), /CompareChrome|読込を固定|toggleWide/, f);
});
