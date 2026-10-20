// EAS へ送るソースの事前検査（ローカルだけ。EAS CLI も、ネットワークも、書き込みも使わない）。
// 送ってよいのは「公開済みの写し」だけ: 専用の Git（clean）で、HEAD・index・作業ツリーのバイトが PUBLISH_MANIFEST.json と一致するもの。
// 元の AI制作 のフォルダ（専用 Git ではなく、私的な指示を含む）は拒否が正しい。manifest を書き換えて通すことはしない（読むだけ）。
// 根拠: https://docs.expo.dev/build-reference/build-with-monorepos/ （アプリは mobile、兄弟の依存を含む root を送る）
//       https://docs.expo.dev/build-reference/easignore/ （.easignore は .gitignore より優先。これだけで安全とは言わない）
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkSourceTree, realFs } from './buildPolicy.mjs';

export const MANIFEST_NAME = 'PUBLISH_MANIFEST.json';
export const MANIFEST_OWNER = 'cert-garden-release-mirror/v1';
/** 作業ツリーの走査で入らないフォルダ（生成物。Git は無視する）。.git は内容を見ない */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-ios-design', 'dist-native', 'dist-native-compare', 'dist-native-flag', '.expo', '.wrangler', '.tmp']);
const REQUIRED = ['package.json', 'src/mobile.ts', 'mobile/package.json', 'mobile/eas.json', 'mobile/app.json', 'mobile/release-selection.json', 'mobile/index.ts', 'design-assets'];
const MAX_PATH = 400;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** Git の blob の ID（"blob <size>\0" + 内容 の SHA-1）。HEAD と作業ツリーの一致を、ファイルごとにプロセスを起動せず確かめる */
const gitBlobOid = (b) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const lower = (p) => p.replaceAll('\\', '/').toLowerCase();

/** manifest 内のパスが安全か（絶対・.. ・ドライブ・バックスラッシュ・NUL・空要素・.git・長すぎ・制御文字） */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || p === '' || p.length > MAX_PATH) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p) || /[\x00-\x1f]/.test(p)) return false;
  const segs = p.split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git' && !/[<>:"|?*]/.test(s) && !/[. ]$/.test(s));
}

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0 && !r.error, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? Buffer.alloc(0)).toString('utf8').trim().slice(0, 200), spawnError: r.error };
}

/** この mobile フォルダから見て、Git の作業ツリーの根（.git があるフォルダ）。無ければ null（git の自己申告ではなく、フォルダを順にたどる） */
export function findGitRoot(startDir) {
  let cur = resolve(startDir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** 作業ツリーを辿る。リンク（symlink / junction）・realpath が根の外へ出る物・読めない物は error。循環はリンクを辿らないので起きない */
function walk(dir, rel, realRoot, files, errors) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    errors.push(`読めないフォルダ: ${rel || '.'}`);
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const full = join(dir, e.name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      errors.push(`状態を読めない: ${r}`);
      continue;
    }
    if (st.isSymbolicLink()) {
      errors.push(`リンク（symlink / junction）は送れません: ${r}`);
      continue;
    }
    let real;
    try {
      real = realpathSync.native(full);
    } catch {
      errors.push(`実体を確かめられない: ${r}`);
      continue;
    }
    // reparse point 等、lstat で見えないリンクも、実体が「根 + 相対パス」と違えば拒否
    if (lower(real) !== lower(join(realRoot, ...r.split('/')))) {
      errors.push(`実体が想定の場所と違います（リンクの疑い）: ${r}`);
      continue;
    }
    if (st.isDirectory()) walk(full, r, realRoot, files, errors);
    else if (st.isFile()) files.set(r, full);
    else errors.push(`通常のファイルではありません: ${r}`);
  }
}

function parseManifest(appRoot, errors) {
  const p = join(appRoot, MANIFEST_NAME);
  if (!existsSync(p)) {
    errors.push(`${MANIFEST_NAME} がありません（公開用の写しではありません）`);
    return null;
  }
  let m;
  try {
    m = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    errors.push(`${MANIFEST_NAME} が読めません`);
    return null;
  }
  if (!m || m.owner !== MANIFEST_OWNER || !Array.isArray(m.files)) {
    errors.push(`${MANIFEST_NAME} の形が正しくありません`);
    return null;
  }
  const listed = new Map();
  const seenLower = new Set();
  for (const f of m.files) {
    if (!f || typeof f !== 'object' || !isSafeRelPath(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      errors.push(`${MANIFEST_NAME} に不正な項目があります${typeof f?.path === 'string' ? `: ${f.path.slice(0, 80)}` : ''}`);
      continue;
    }
    if (f.path === MANIFEST_NAME) {
      errors.push(`${MANIFEST_NAME} が自分自身を載せています`);
      continue;
    }
    if (listed.has(f.path) || seenLower.has(f.path.toLowerCase())) {
      errors.push(`${MANIFEST_NAME} にパスの重複があります: ${f.path}`);
      continue;
    }
    seenLower.add(f.path.toLowerCase());
    listed.set(f.path, { size: f.size, sha256: f.sha256 });
  }
  return listed;
}

/**
 * @param {string} mobileDir mobile フォルダの絶対パス
 * @returns {{ ok: boolean, errors: string[], gitRoot: string|null }}
 */
export function checkSourceRoot(mobileDir) {
  const errors = [];
  const mobile = resolve(mobileDir);
  const appRoot = dirname(mobile);
  const gitRoot = findGitRoot(mobile);

  // 1. 専用の Git の根
  if (gitRoot === null) errors.push('Git の作業ツリーがありません。EAS へは、公開済みの写し（またはその clone）の mobile から実行します');
  else if (lower(resolve(gitRoot)) !== lower(appRoot)) errors.push(`Git の根がこのアプリ専用ではありません（根: ${gitRoot}）。アプリの写しだけを Git にした場所から実行してください`);

  // 2. 根・mobile が実フォルダで、根の外へ出ていない
  let realRoot = null;
  try {
    realRoot = realpathSync.native(appRoot);
    if (lower(realpathSync.native(mobile)) !== lower(join(realRoot, 'mobile'))) errors.push('mobile フォルダが根の外を指しています（リンクの疑い）');
  } catch {
    errors.push('アプリのフォルダの実体を確かめられません');
  }

  const listed = parseManifest(appRoot, errors);
  for (const rel of REQUIRED) if (!existsSync(join(appRoot, ...rel.split('/')))) errors.push(`必要なソースが無い: ${rel}`);

  // 3. Git の状態: clean（staged / unstaged / untracked なし）・HEAD がある・追跡の集合が manifest と一致
  const gitOk = gitRoot !== null && lower(resolve(gitRoot)) === lower(appRoot);
  let headBlobs = null;
  if (gitOk) {
    const head = git(appRoot, ['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) errors.push(`コミット(HEAD)がありません、または Git を実行できません${head.err ? `: ${head.err}` : ''}`);
    else {
      const status = git(appRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (!status.ok) errors.push(`git status を実行できません: ${status.err}`);
      else if (status.out.length > 0) {
        const shown = status.out.toString('utf8').split('\0').filter(Boolean).slice(0, 5).map((l) => l.slice(0, 100));
        errors.push(`作業ツリーが clean ではありません（変更・追加済み・未追跡のいずれか）: ${shown.join(' | ')}`);
      }
      const tree = git(appRoot, ['ls-tree', '-r', '-z', 'HEAD']);
      if (!tree.ok) errors.push(`git ls-tree を実行できません: ${tree.err}`);
      else {
        headBlobs = new Map();
        for (const rec of tree.out.toString('utf8').split('\0').filter(Boolean)) {
          const m = /^(\d+) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
          if (!m) {
            errors.push('git ls-tree の出力を読めません');
            continue;
          }
          if (m[1] === '120000' || m[2] !== 'blob') errors.push(`HEAD にリンク/サブモジュールがあります: ${m[4]}`);
          headBlobs.set(m[4], m[3]);
        }
      }
      const idx = git(appRoot, ['ls-files', '-z']);
      if (!idx.ok) errors.push(`git ls-files を実行できません: ${idx.err}`);
      else if (headBlobs) {
        const indexed = new Set(idx.out.toString('utf8').split('\0').filter(Boolean));
        for (const p of indexed) if (!headBlobs.has(p)) errors.push(`index にあって HEAD に無い: ${p}`);
        for (const p of headBlobs.keys()) if (!indexed.has(p)) errors.push(`HEAD にあって index に無い（削除の準備済み）: ${p}`);
      }
    }
  }

  // 4. manifest と HEAD の追跡の集合が一致（追跡されているのは manifest の物 + manifest 自身だけ）
  if (listed && headBlobs) {
    const expected = new Set([...listed.keys(), MANIFEST_NAME]);
    for (const p of headBlobs.keys()) if (!expected.has(p)) errors.push(`manifest に無いファイルが追跡されています: ${p}`);
    for (const p of expected) if (!headBlobs.has(p)) errors.push(`manifest にあるファイルが HEAD に無い: ${p}`);
  }

  // 5. 作業ツリー: リンク逸脱なし・追跡されていないファイルなし・manifest の sha256/size と実バイトが一致・HEAD の blob と一致
  if (realRoot) {
    const files = new Map();
    walk(appRoot, '', realRoot, files, errors);
    const tracked = headBlobs ? new Set(headBlobs.keys()) : listed ? new Set([...listed.keys(), MANIFEST_NAME]) : new Set();
    for (const rel of files.keys()) if (!tracked.has(rel)) errors.push(`追跡されていない/manifest に無いファイルが混ざっている: ${rel}`);
    if (listed) {
      for (const [rel, want] of listed) {
        const full = files.get(rel);
        if (!full) {
          errors.push(`manifest にあるファイルが無い: ${rel}`);
          continue;
        }
        let bytes;
        try {
          bytes = readFileSync(full);
        } catch {
          errors.push(`読めないファイル: ${rel}`);
          continue;
        }
        if (bytes.length !== want.size) errors.push(`manifest と大きさが違う: ${rel}`);
        else if (sha256(bytes) !== want.sha256) errors.push(`manifest とバイトが違う（同じ大きさの改変）: ${rel}`);
        if (headBlobs?.has(rel) && gitBlobOid(bytes) !== headBlobs.get(rel)) errors.push(`HEAD の内容と作業ツリーが違う: ${rel}`);
      }
    }
  }

  errors.push(...checkSourceTree(realFs(mobile)));
  return { ok: errors.length === 0, errors: [...new Set(errors)], gitRoot };
}
