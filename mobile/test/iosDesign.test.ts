import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BitPatternsContent, CoreError, StudyCore } from '../../src/mobile.ts';
import { COMPARE_KEY, CompareStore, DEFAULT_COMPARE, FaultKv, IOS_DESIGN_PREFIX, PrefixedKv, parseCompare } from '../src/ios/namespace.ts';
import { VARIANTS, buildCompareSearch, isIosDesignEnabled, mergeCompare, minShowRemaining, minShowVisible, parseCompareSearch, pickerKeyAction, type KeyInfo } from '../src/ios/compare.ts';
import { MemoryKv } from '../src/state/kv.ts';
import { CORE_KEY, KvStorage } from '../src/state/kvStorage.ts';
import { NotebookStore, SettingsStore, DEFAULT_SETTINGS } from '../src/state/notebook.ts';
import { RoomStore } from '../src/state/room.ts';
import { RosterStore, defaultRoster } from '../src/state/roster.ts';
import { LayoutStore, starterLayout } from '../src/state/furniture.ts';
import { LearnPrefsStore } from '../src/state/learnPrefs.ts';
import { missingForBuild, problems } from '../scripts/iosConfigCheck.mjs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const T0 = Date.parse('2026-10-20T09:00:00+09:00');
const open = (kv: MemoryKv) => StudyCore.open({ storage: new KvStorage(kv), content: new BitPatternsContent(), clock: { now: () => T0 } });

// ---- 隔離 ----

test('隔離: 接頭辞は本体の certgarden: と重ならない。重なる指定は作れない', () => {
  assert.ok(!IOS_DESIGN_PREFIX.startsWith('certgarden:'));
  assert.ok(!'certgarden:'.startsWith(IOS_DESIGN_PREFIX));
  const base = new MemoryKv();
  for (const bad of ['', 'certgarden:', 'certgarden:core:', 'c']) assert.throws(() => new PrefixedKv(base, bad));
});

test('隔離: 学習・手帳・設定・部屋・編成・家具・学ぶ設定を保存しても、本体のキーは1つも増えず、本体の画面は初期のまま', async () => {
  const base = new MemoryKv();
  const kv = new PrefixedKv(base);
  const core = await open(kv as unknown as MemoryKv);
  await core.startStage('it-passport', 'bit-patterns');
  await new NotebookStore(kv).save([{ id: 'n1', name: '比較用', date: '', memo: '' }]);
  await new SettingsStore(kv).save({ ...DEFAULT_SETTINGS, reduceMotion: true });
  await new RoomStore(kv).save('forest');
  await new RosterStore(kv).save(defaultRoster());
  await new LayoutStore(kv).save(starterLayout());
  await new LearnPrefsStore(kv).save('it-passport');
  const keys = [...base.map.keys()];
  assert.ok(keys.length >= 7, `名前空間の中に保存された: ${keys.join(',')}`);
  assert.ok(keys.every((k) => k.startsWith(IOS_DESIGN_PREFIX)), `接頭辞の外に書いていない: ${keys.join(',')}`);
  assert.ok(keys.every((k) => !k.startsWith('certgarden:')));
  // 本体として同じ保存を開くと、学習は初期（実が満タンで途中の学習なし）
  const adopted = await open(new MemoryKv());
  assert.equal(adopted.findResumable(), undefined);
  const mine = await StudyCore.open({ storage: new KvStorage(kv), content: new BitPatternsContent(), clock: { now: () => T0 } });
  assert.ok(mine.findResumable(), '名前空間の側は途中の学習を覚えている');
});

test('隔離: 本体の保存が先にあっても、比較側は読まず・書き換えず、初期値から始まる（学習完了や取得済み合格を偽らない）', async () => {
  const base = new MemoryKv();
  const adopted = await open(base as MemoryKv);
  await adopted.startStage('it-passport', 'bit-patterns');
  const before = base.map.get(CORE_KEY);
  assert.ok(before);
  const kv = new PrefixedKv(base);
  assert.deepEqual(await new KvStorage(kv).load(), { kind: 'empty' });
  assert.deepEqual(await new NotebookStore(kv).load(), []);
  const mine = await StudyCore.open({ storage: new KvStorage(kv), content: new BitPatternsContent(), clock: { now: () => T0 } });
  assert.equal(mine.findResumable(), undefined);
  assert.deepEqual(mine.getGardenSnapshot().completedThemes, []);
  await mine.startStage('it-passport', 'bit-patterns');
  assert.equal(base.map.get(CORE_KEY), before, '本体の保存は1バイトも変わらない');
});

test('再読込: 名前空間の中の学習・家具・手帳は復帰し、比較設定も別キーで復帰する', async () => {
  const base = new MemoryKv();
  const kv = new PrefixedKv(base);
  const a = await StudyCore.open({ storage: new KvStorage(kv), content: new BitPatternsContent(), clock: { now: () => T0 } });
  const v = await a.startStage('it-passport', 'bit-patterns');
  await a.interrupt(v.stageId);
  await new NotebookStore(kv).save([{ id: 'n1', name: '記録', date: '', memo: '' }]);
  const store = new CompareStore(kv);
  await store.save({ variant: 4, skeleton: false, delayMs: 0 });
  // 再読込相当
  const kv2 = new PrefixedKv(base);
  const b = await StudyCore.open({ storage: new KvStorage(kv2), content: new BitPatternsContent(), clock: { now: () => T0 } });
  assert.equal(b.findResumable()?.id, v.stageId);
  assert.equal((await new NotebookStore(kv2).load()).length, 1);
  assert.deepEqual(await new CompareStore(kv2).load(), { variant: 4, skeleton: false, delayMs: 0 });
  assert.ok(base.map.has(IOS_DESIGN_PREFIX + COMPARE_KEY));
});

test('比較設定: 壊れた保存・知らない値は既定に戻り、例外で止まらない', async () => {
  const base = new MemoryKv();
  base.map.set(IOS_DESIGN_PREFIX + COMPARE_KEY, '{broken');
  assert.deepEqual(await new CompareStore(new PrefixedKv(base)).load(), DEFAULT_COMPARE);
  assert.deepEqual(parseCompare({ variant: 9, skeleton: 'yes', delayMs: 5 }), DEFAULT_COMPARE);
  assert.deepEqual(parseCompare({ variant: 3, skeleton: false, delayMs: 0 }), { variant: 3, skeleton: false, delayMs: 0 });
});

// ---- 読込の成功・失敗・再試行 ----

test('読込失敗: 次の1回だけ失敗し、保存データは書き換えず、再試行は成功する（本物のコアの読込エラー経路）', async () => {
  const base = new MemoryKv();
  const prefixed = new PrefixedKv(base);
  const seed = await StudyCore.open({ storage: new KvStorage(prefixed), content: new BitPatternsContent(), clock: { now: () => T0 } });
  await seed.startStage('it-passport', 'bit-patterns');
  const snapshotBefore = JSON.stringify([...base.map.entries()]);
  const fault = new FaultKv(prefixed);
  fault.armReadFailure(CORE_KEY);
  await assert.rejects(StudyCore.open({ storage: new KvStorage(fault), content: new BitPatternsContent(), clock: { now: () => T0 } }), (e: unknown) => e instanceof CoreError && e.code === 'CORRUPT_STORAGE');
  assert.equal(JSON.stringify([...base.map.entries()]), snapshotBefore, '失敗しても保存は変わらない');
  assert.equal(fault.isArmed, false, '1回で解除される');
  const retry = await StudyCore.open({ storage: new KvStorage(fault), content: new BitPatternsContent(), clock: { now: () => T0 } });
  assert.ok(retry.findResumable(), '再試行で同じ学習が戻る');
});

test('読込失敗: 指定したキー以外の読み取りと、書き込みには影響しない', async () => {
  const kv = new FaultKv(new PrefixedKv(new MemoryKv()));
  kv.armReadFailure(CORE_KEY);
  await kv.setItem('x', '1');
  assert.equal(await kv.getItem('x'), '1');
  await assert.rejects(kv.getItem(CORE_KEY));
  assert.equal(await kv.getItem(CORE_KEY), null);
});

// ---- 入口 ----

test('入口: 通常起動は本体。web は明示 ?iosDesign=1 と(開発 or 確認用ビルド)、native は開発かつ環境フラグの時だけ。署名ビルドでは開かない', () => {
  const on = (i: Partial<Parameters<typeof isIosDesignEnabled>[0]>) => isIosDesignEnabled({ platform: 'web', isDev: true, buildFlag: undefined, search: '', ...i });
  assert.equal(on({}), false);
  assert.equal(on({ search: '?iosDesign=1' }), true);
  assert.equal(on({ search: '?iosDesign=0' }), false);
  assert.equal(on({ search: '?v=2' }), false, 'v だけでは開かない');
  assert.equal(on({ isDev: false, search: '?iosDesign=1' }), false, '通常のWeb出力では開かない');
  assert.equal(on({ isDev: false, buildFlag: '1', search: '?iosDesign=1' }), true, '確認用のWeb出力では開く');
  assert.equal(on({ platform: 'ios', isDev: true, buildFlag: '1' }), true);
  assert.equal(on({ platform: 'ios', isDev: true, buildFlag: undefined }), false);
  assert.equal(on({ platform: 'ios', isDev: false, buildFlag: '1' }), false, '署名ビルドでは開かない');
});

test('入口: Root が本体と候補を切り替え、index は Root を登録する。App.tsx は候補を知らない', () => {
  const root = read('../src/Root.tsx');
  assert.match(root, /decideEntry\(/);
  assert.match(root, /require\('\.\/App'\)/);
  assert.match(root, /require\('\.\/ios\/IosDesignApp'\)/);
  assert.match(root, /require\('\.\/ios\/ProductApp'\)/);
  assert.match(read('../index.ts'), /registerRootComponent\(Root\)/);
  assert.doesNotMatch(read('../src/App.tsx'), /ios\//);
  // 端末の保存(asyncKv)を直接渡すのは、比較の入口(名前空間つき)と製品の入口(既存9キーをゲストの原本として読む)だけ
  for (const f of readdirSync(new URL('../src/ios/', import.meta.url))) {
    const text = read(`../src/ios/${f}`);
    if (f === 'IosDesignApp.tsx') assert.match(text, /new PrefixedKv\(asyncKv\)/);
    else if (f === 'ProductApp.tsx') assert.match(text, /new ProductKv\(asyncKv\)[\s\S]*new PrefixedKv\(asyncKv, PRODUCT_PREVIEW_PREFIX\)/);
    else assert.doesNotMatch(text, /asyncKv|AsyncStorage/, f);
  }
});

test('隔離: 本体の保存キーはすべて certgarden: で始まる（接頭辞と衝突しない前提の確認）', () => {
  for (const f of readdirSync(new URL('../src/state/', import.meta.url))) {
    const text = read(`../src/state/${f}`);
    for (const m of text.matchAll(/_KEY = '([^']+)'/g)) assert.ok(m[1]!.startsWith('certgarden:'), `${f}: ${m[1]}`);
  }
});

// ---- URL / picker ----

test('URL: v・skel・delay を読み、書き戻しても iosDesign=1 などの他の指定を残す', () => {
  assert.deepEqual(parseCompareSearch('?iosDesign=1&v=2&skel=0&delay=0'), { variant: 2, skeleton: false, delayMs: 0 });
  assert.deepEqual(parseCompareSearch('?v=9&skel=x&delay=5'), {});
  assert.deepEqual(mergeCompare({ variant: 1, skeleton: true, delayMs: 1200 }, { variant: 5 }), { variant: 5, skeleton: true, delayMs: 1200 });
  const s = buildCompareSearch('?iosDesign=1&foo=bar', { variant: 3, skeleton: false, delayMs: 0 });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(s)), { iosDesign: '1', foo: 'bar', v: '3', skel: '0', delay: '0' });
});

const key = (k: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, targetTag: 'BODY', targetEditable: false, ...extra });

test('picker: 1〜5・左右(循環)・R。入力欄/編集可能/修飾キーは無視。範囲外の数字は無視', () => {
  assert.equal(VARIANTS.length, 5);
  assert.deepEqual(pickerKeyAction(key('3'), 1), { type: 'set', variant: 3 });
  assert.equal(pickerKeyAction(key('6'), 1), null);
  assert.equal(pickerKeyAction(key('0'), 1), null);
  assert.deepEqual(pickerKeyAction(key('ArrowRight'), 5), { type: 'set', variant: 1 });
  assert.deepEqual(pickerKeyAction(key('ArrowLeft'), 1), { type: 'set', variant: 5 });
  assert.deepEqual(pickerKeyAction(key('r'), 2), { type: 'replay' });
  assert.deepEqual(pickerKeyAction(key('R'), 2), { type: 'replay' });
  assert.equal(pickerKeyAction(key('2', { targetTag: 'INPUT' }), 1), null);
  assert.equal(pickerKeyAction(key('2', { targetTag: 'TEXTAREA' }), 1), null);
  assert.equal(pickerKeyAction(key('r', { targetEditable: true }), 1), null);
  assert.equal(pickerKeyAction(key('2', { metaKey: true }), 1), null);
  assert.equal(pickerKeyAction(key('r', { ctrlKey: true }), 1), null);
  assert.equal(pickerKeyAction(key('ArrowRight', { altKey: true }), 1), null);
});

test('候補: 5つの名前と違いの軸は Apple参照と候補.md のとおりで、色違いではなくナビの軸が違う', () => {
  assert.deepEqual(VARIANTS.map((v) => v.name), ['標準タブ', '全景ルーム', '学習カード', '2つの主役', 'スワイプ往復']);
  assert.equal(new Set(VARIANTS.map((v) => v.axis)).size, 5);
  const v = read('../src/ios/Variants.tsx');
  assert.match(v, /TABS4/);
  assert.match(v, /floating/); // 2: 浮いたタブ
  assert.match(v, /StudyCard/); // 3: 学習カード
  assert.match(v, /TABS2/); // 4: 2タブ + シート
  assert.match(v, /PanResponder/); // 5: スワイプ
  assert.match(v, /onSelect=\{\(i\) => setTab/); // 5: タップでも移動できる
});

// ---- 比較用の最低表示（本番に待ちを足さない） ----

test('最低表示: 準備中は必ず表示。準備後は開始から待ち時間が過ぎるまで。待ち0なら実際の準備だけで進む', () => {
  assert.equal(minShowVisible(1000, true, 5000, 1200), true);
  assert.equal(minShowVisible(1000, false, 1500, 1200), true);
  assert.equal(minShowVisible(1000, false, 2200, 1200), false);
  assert.equal(minShowVisible(1000, false, 1001, 0), false, '待ち0: 準備が終われば即時');
  assert.equal(minShowVisible(null, false, 1001, 1200), false);
  assert.equal(minShowRemaining(1000, 1500, 1200), 700);
  assert.equal(minShowRemaining(1000, 9000, 1200), 0);
  assert.equal(minShowRemaining(1000, 1500, 0), 0);
});

test('最低表示: 本番(本体)の経路に最低待機は無い。待ちを持つのは候補側の useMinShow だけ', () => {
  const app = read('../src/App.tsx');
  assert.doesNotMatch(app, /useMinShow|minShow|delayMs|setTimeout/);
  const ios = read('../src/ios/Runner.tsx');
  assert.match(ios, /useMinShow\('boot', bootLoading, cfg\.delayMs, nonce\)/);
  assert.match(ios, /void c\.load\(\)/);
});

// ---- スケルトン・動き・アクセシビリティ ----

test('スケルトン: 箱庭/学ぶ/手帳/お店/設問/結果の6画面すべてに専用部品があり、あり/なしは同じ準備完了で切り替わる', () => {
  const sk = read('../src/ios/Skeletons.tsx');
  for (const name of ['HomeSkeleton', 'LearnSkeleton', 'NotebookSkeleton', 'ShopSkeleton', 'QuestionSkeleton', 'ResultSkeleton']) assert.match(sk, new RegExp(`export function ${name}`));
  assert.match(sk, /skeleton \? SKELETONS\[kind\]\(\) : <PlainLoader/);
  assert.match(sk, /accessibilityState=\{\{ busy: true \}\}/);
  assert.match(sk, /accessibilityRole="alert"/);
  assert.match(sk, /onPress=\{onRetry\}|onPress=\{onRetry\}/);
  const screens = read('../src/ios/Screens.tsx');
  assert.match(screens, /if \(bootVisible \|\| ctx\.pin === kind\) return <LoadView/);
  assert.match(screens, /c\.boot\.kind === 'error'/);
});

test('動き: シマー・シート・押下は、動きを減らす時とアプリが前面にない間は止め、キャラの画素を拡縮しない', () => {
  const sk = read('../src/ios/Skeletons.tsx');
  assert.match(sk, /if \(reduce \|\| !active\)/);
  assert.match(read('../src/ios/Press.tsx'), /if \(reduce\) v\.setValue\(1\)/);
  assert.match(read('../src/ios/Sheet.tsx'), /if \(reduce\)/);
  assert.match(read('../src/ios/Nav.tsx'), /if \(reduce\) v\.setValue/);
  for (const f of readdirSync(new URL('../src/ios/', import.meta.url))) assert.doesNotMatch(read(`../src/ios/${f}`), /CharacterSprite|MotionSprite|RoomCreature/, `${f}: キャラの絵は既存部品に任せ、ここで拡縮しない`);
});

test('飾り文: 候補側は部屋の雰囲気の一言とキャラの口上を出さず、必要な説明だけにする', () => {
  const home = read('../src/ui/Home.tsx');
  assert.match(home, /plainNote = false/);
  assert.match(read('../src/ios/Screens.tsx'), /plainNote/);
  assert.match(read('../src/ios/Flow.tsx'), /plain onHome/);
  const ios = readdirSync(new URL('../src/ios/', import.meta.url)).map((f) => read(`../src/ios/${f}`)).join('\n');
  for (const s of ['のんびり', '波の音', 'きこえそう', 'できたね', 'ゆったり']) assert.ok(!ios.includes(s), s);
});

test('触覚: 実機のiOSだけで鳴り、Webでは何もしない。誤答・わからないでは鳴らさない', () => {
  assert.match(read('../src/ios/haptics.ts'), /Platform\.OS !== 'ios'\) return/);
  assert.match(read('../src/ios/useGardenRuntime.ts'), /cue === 'cheer' \|\| cue === 'celebrate'/);
});

// ---- iOS設定 ----

test('iOS設定: 暗号申告・iPhone専用・scheme・4プロファイルが揃い、確認用入口の環境変数が preview/production に無い', () => {
  const app = JSON.parse(read('../app.json'));
  const eas = JSON.parse(read('../eas.json'));
  assert.deepEqual(problems(app, eas), []);
  assert.equal(eas.build.simulator.ios.simulator, true);
  assert.equal(eas.build.production.env, undefined);
});

test('iOS設定: bundle ID・owner・projectId は捏造せず未設定のまま。ビルド前の検査がそれを報告する', () => {
  const app = JSON.parse(read('../app.json'));
  const miss = missingForBuild(app);
  assert.equal(miss.length, 3);
  assert.equal(app.expo.owner, undefined);
  assert.equal(app.expo.ios.bundleIdentifier, undefined);
  assert.equal(app.expo.extra?.eas?.projectId, undefined);
  const filled = { expo: { ...app.expo, owner: 'someone', ios: { ...app.expo.ios, bundleIdentifier: 'com.someone.certgarden' }, extra: { eas: { projectId: '00000000-0000-4000-8000-000000000000' } } } };
  assert.deepEqual(missingForBuild(filled), []);
  assert.ok(problems({ expo: { ...app.expo, ios: { supportsTablet: false } } }, JSON.parse(read('../eas.json'))).length > 0, '暗号申告が消えたら検出する');
  assert.ok(problems(app, { build: { ...JSON.parse(read('../eas.json')).build, production: { env: { EXPO_PUBLIC_IOS_DESIGN: '1' } } } }).length > 0, '署名ビルドへの候補入口の混入を検出する');
});
