import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 実際に npm install を走らせる使い捨てfixture。依存のpostinstallがマーカーを書こうとしても、
// プロジェクトの .npmrc(ignore-scripts=true)があれば書けず、明示した npm run/test は動く。
// 管理外のネットワークは使わない(file:依存・--offline)。アプリ本体のnode_modules/lockには触れない。

const appRoot = new URL('..', import.meta.url);
// 外側の npm test が .npmrc から渡す npm_config_ignore_scripts を引き継がない（fixture側の .npmrc だけで判定するため）
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_ignore[-_]scripts$/i.test(k)));
const npm = (args: string[], cwd: string) =>
  spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32', env: { ...cleanEnv(), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } });

/** dep は postinstall でマーカーを書く。app は dep を file: で依存し、test/hello スクリプトを持つ */
function fixture(withNpmrc: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-inst-'));
  const dep = join(dir, 'dep');
  const app = join(dir, 'app');
  mkdirSync(dep);
  mkdirSync(app);
  const marker = join(dir, 'MARKER');
  writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { postinstall: 'node mark.js' } }));
  writeFileSync(join(dep, 'mark.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true, dependencies: { dep: 'file:../dep' }, scripts: { test: 'node -e "console.log(\'explicit-test-ran\')"', hello: 'node -e "console.log(\'explicit-run-ran\')"' } }));
  if (withNpmrc) writeFileSync(join(app, '.npmrc'), readFileSync(new URL('.npmrc', appRoot), 'utf8'));
  return { dir, app, marker };
}

test('実fixture: ignore-scripts=true なら依存のpostinstallは実行されず、明示したnpm test/runは動く', () => {
  const f = fixture(true);
  try {
    const i = npm(['install', '--offline'], f.app);
    assert.equal(i.status, 0, i.stderr);
    assert.ok(existsSync(join(f.app, 'node_modules', 'dep')), '依存は入っている');
    assert.equal(existsSync(f.marker), false, 'postinstallは実行されない');
    const t = npm(['test'], f.app);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /explicit-test-ran/);
    const r = npm(['run', 'hello'], f.app);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /explicit-run-ran/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('対照: .npmrc が無ければ同じfixtureでpostinstallが実行される（試験が実際に差を見ている証拠）', () => {
  const f = fixture(false);
  try {
    const i = npm(['install', '--offline'], f.app);
    assert.equal(i.status, 0, i.stderr);
    assert.equal(existsSync(f.marker), true, '制限が無ければ依存のscriptが走る');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('実アプリの3境界: .npmrc は ignore-scripts=true だけ、npm版は固定、CIのinstallも --ignore-scripts', () => {
  for (const d of ['', 'mobile/', 'server/']) {
    const rc = readFileSync(new URL(`${d}.npmrc`, appRoot), 'utf8').split(/\r?\n/).filter((l) => l.trim());
    assert.deepEqual(rc, ['ignore-scripts=true'], d || 'root');
    const pkg = JSON.parse(readFileSync(new URL(`${d}package.json`, appRoot), 'utf8')) as { packageManager?: string };
    assert.equal(pkg.packageManager, 'npm@11.19.0', d || 'root');
  }
  // CIテンプレートは公開束の元(release/)にだけある。公開側の写しには無いので、あれば検査する（公開束側の検査は release の npmcheck/selftest）
  const ciPath = new URL(['release', 'template', 'ci.yml'].join('/'), appRoot);
  if (existsSync(ciPath)) {
    const installs = readFileSync(ciPath, 'utf8').split(/\r?\n/).filter((l) => /run:\s*npm (ci|install|i)\b/.test(l));
    assert.ok(installs.length >= 6, 'npm ci 3 + npm -g 3');
    assert.ok(installs.every((l) => /--ignore-scripts/.test(l)), installs.join(String.fromCharCode(10)));
  }
});
