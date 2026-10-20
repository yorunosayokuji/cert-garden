// 新規の全身パーツ5枚（胴・頭・尾・前脚・後脚）を、30姿勢の連続変形で全身へ組んで歩行30コマ＋休止1コマを描く。
// 原画の再生成ではなく、パーツの皮膚（メッシュ）を変形して合成した絵。30枚の新規手描きではない。
//
// 使い方（親が実行）:
//   node scripts/render-full-walk.mjs --canvas-module <@napi-rs/canvas の絶対パス> --out <出力フォルダ>
//   任意: --parts <パーツPNG> --bounds <parts-bounds.json>（既定は ../../design-assets/motion-v4/ の2つ）
// canvas は PNG の読み書き（loadImage / getImageData / putImageData / toBuffer）にだけ使う。描画は自前の三角形ラスタライザ。
// 原PNGは読むだけで書き換えない。秘密・認証情報は読まない。追加インストールなし。

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './fullWalkCore.mjs';

const {
  FRAMES, DURATION_MS, CELL_W, CELL_H, COLS, ROWS, ANCHOR, REFERENCE_WIDTH, ALPHA_CUTOFF, PART_RECTS, DST_RECTS, LEG_NAMES, LEGS, LEG_KINDS,
} = core;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`不明な引数: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${a} の値がありません`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (!args['canvas-module'] || !args.out) {
  fail('使い方: node scripts/render-full-walk.mjs --canvas-module <@napi-rs/canvas の絶対パス> --out <出力フォルダ>');
}
if (!path.isAbsolute(args['canvas-module'])) fail('--canvas-module は絶対パスで指定してください');
const partsPath = path.resolve(args.parts ?? path.join(here, '..', '..', 'design-assets', 'motion-v4', 'apricot-fullbody-parts.png'));
const boundsPath = path.resolve(args.bounds ?? path.join(here, '..', '..', 'design-assets', 'motion-v4', 'parts-bounds.json'));
const outDir = path.resolve(args.out);
if (!existsSync(partsPath)) fail(`パーツPNGがありません: ${partsPath}`);
if (!existsSync(boundsPath)) fail(`parts-bounds.json がありません: ${boundsPath}`);

const canvasMod = createRequire(import.meta.url)(args['canvas-module']);
for (const k of ['createCanvas', 'loadImage']) if (typeof canvasMod[k] !== 'function') fail(`--canvas-module に ${k} がありません`);

const SS = 4;
const W = CELL_W * SS;
const H = CELL_H * SS;
const WALK_W = CELL_W * COLS;
const WALK_H = CELL_H * ROWS;
const BARY_EPS = 1e-4;
const FAR_SHADE = 0.8;
const KEY_FRAMES = [0, 4, 8, 11, 15, 19, 23, 26];
const KEY_SCALE = 3;

// ---------- PNG の読み書き ----------

async function decodeRgba(buf) {
  const img = await canvasMod.loadImage(buf);
  const c = canvasMod.createCanvas(img.width, img.height);
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const id = cx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data: id.data };
}
function encodePng(width, height, rgba) {
  const c = canvasMod.createCanvas(width, height);
  const cx = c.getContext('2d');
  const id = cx.createImageData(width, height);
  id.data.set(rgba);
  cx.putImageData(id, 0, 0);
  return c.toBuffer('image/png');
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------- 描画用の一時 texture（原PNGは加工しない） ----------

const oddWin = (v) => Math.max(1, 2 * Math.round((v - 1) / 2) + 1);

/** rect を切り出し、alpha>=180 だけを不透明にした一時 texture。積分画像で箱フィルタ（最終の約4倍解像度へ縮める）をかける */
function makeTexture(img, rect, srcPerSs) {
  const [rx, ry, w, h] = rect;
  const win = oddWin(srcPerSs);
  const half = (win - 1) / 2;
  const stride = w + 1;
  const sat = new Float64Array(stride * (h + 1) * 4);
  const alpha = new Uint8Array(w * h);
  let opaque = 0;
  for (let y = 0; y < h; y++) {
    let rr = 0;
    let gg = 0;
    let bb = 0;
    let aa = 0;
    for (let x = 0; x < w; x++) {
      const si = ((ry + y) * img.width + rx + x) * 4;
      if (img.data[si + 3] >= ALPHA_CUTOFF) {
        rr += img.data[si];
        gg += img.data[si + 1];
        bb += img.data[si + 2];
        aa += 1;
        alpha[y * w + x] = 1;
        opaque++;
      }
      const di = ((y + 1) * stride + x + 1) * 4;
      const up = (y * stride + x + 1) * 4;
      sat[di] = sat[up] + rr;
      sat[di + 1] = sat[up + 1] + gg;
      sat[di + 2] = sat[up + 2] + bb;
      sat[di + 3] = sat[up + 3] + aa;
    }
  }
  return {
    w,
    h,
    win,
    opaque,
    opaqueAt(lx, ly) {
      const cx = Math.floor(lx);
      const cy = Math.floor(ly);
      return cx >= 0 && cy >= 0 && cx < w && cy < h && alpha[cy * w + cx] === 1;
    },
    /** (lx,ly) は rect 内の元座標。窓の中の不透明率が半分以上なら true で out に平均色を入れる */
    sample(lx, ly, out) {
      const cx = Math.floor(Math.min(lx, w - 1e-6));
      const cy = Math.floor(Math.min(ly, h - 1e-6));
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return false;
      const x0 = Math.max(0, cx - half);
      const y0 = Math.max(0, cy - half);
      const x1 = Math.min(w, cx + half + 1);
      const y1 = Math.min(h, cy + half + 1);
      const area = (x1 - x0) * (y1 - y0);
      const iA = (y0 * stride + x0) * 4;
      const iB = (y0 * stride + x1) * 4;
      const iC = (y1 * stride + x0) * 4;
      const iD = (y1 * stride + x1) * 4;
      const a = sat[iD + 3] - sat[iB + 3] - sat[iC + 3] + sat[iA + 3];
      if (a * 2 < area) return false;
      out[0] = (sat[iD] - sat[iB] - sat[iC] + sat[iA]) / a;
      out[1] = (sat[iD + 1] - sat[iB + 1] - sat[iC + 1] + sat[iA + 1]) / a;
      out[2] = (sat[iD + 2] - sat[iB + 2] - sat[iC + 2] + sat[iA + 2]) / a;
      return true;
    },
  };
}

// ---------- メッシュと三角形ラスタライザ（SS 倍の格子へ描く） ----------

const newLayer = () => new Uint8Array(W * H * 4);

function gridMesh(rw, rh, nx, ny, mapFn) {
  const count = (nx + 1) * (ny + 1);
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const dxy = new Float64Array(count * 2);
  for (let gy = 0; gy <= ny; gy++) {
    for (let gx = 0; gx <= nx; gx++) {
      const v = gy * (nx + 1) + gx;
      sx[v] = (gx / nx) * rw;
      sy[v] = (gy / ny) * rh;
      const p = mapFn(sx[v], sy[v]);
      dxy[v * 2] = p[0];
      dxy[v * 2 + 1] = p[1];
    }
  }
  return { nx, ny, sx, sy, dxy };
}

const col = [0, 0, 0];
function rasterTri(layer, m, tex, shade, stats, a, b, c) {
  const x0 = m.dxy[a * 2] * SS;
  const y0 = m.dxy[a * 2 + 1] * SS;
  const x1 = m.dxy[b * 2] * SS;
  const y1 = m.dxy[b * 2 + 1] * SS;
  const x2 = m.dxy[c * 2] * SS;
  const y2 = m.dxy[c * 2 + 1] * SS;
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return;
  const srcArea = (m.sx[b] - m.sx[a]) * (m.sy[c] - m.sy[a]) - (m.sx[c] - m.sx[a]) * (m.sy[b] - m.sy[a]);
  if (srcArea * area < 0 && tex.opaqueAt((m.sx[a] + m.sx[b] + m.sx[c]) / 3, (m.sy[a] + m.sy[b] + m.sy[c]) / 3)) stats.flipped++;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
  const inv = 1 / area;
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const l1 = ((cx - x0) * (y2 - y0) - (cy - y0) * (x2 - x0)) * inv;
      const l2 = ((x1 - x0) * (cy - y0) - (cx - x0) * (y1 - y0)) * inv;
      const l0 = 1 - l1 - l2;
      if (l0 < -BARY_EPS || l1 < -BARY_EPS || l2 < -BARY_EPS) continue;
      const u = l0 * m.sx[a] + l1 * m.sx[b] + l2 * m.sx[c];
      const v = l0 * m.sy[a] + l1 * m.sy[b] + l2 * m.sy[c];
      if (!tex.sample(u, v, col)) continue;
      const o = (py * W + px) * 4;
      layer[o] = Math.round(col[0] * shade);
      layer[o + 1] = Math.round(col[1] * shade);
      layer[o + 2] = Math.round(col[2] * shade);
      layer[o + 3] = 255;
    }
  }
}

function rasterMesh(layer, m, tex, shade, stats) {
  const stride = m.nx + 1;
  for (let j = 0; j < m.ny; j++) {
    for (let i = 0; i < m.nx; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      rasterTri(layer, m, tex, shade, stats, a, b, c);
      rasterTri(layer, m, tex, shade, stats, b, d, c);
    }
  }
}

function compose(layers) {
  const out = new Uint8Array(W * H * 4);
  for (const L of layers) {
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (L[o + 3] === 0) continue;
      out[o] = L[o];
      out[o + 1] = L[o + 1];
      out[o + 2] = L[o + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/** SS×SS の被覆が半分以上なら不透明（色は覆われた副画素の平均）。半透明の縁は作らない */
function downsample(ss) {
  const out = new Uint8ClampedArray(CELL_W * CELL_H * 4);
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = ((y * SS + sy) * W + x * SS + sx) * 4;
          if (ss[p + 3] === 0) continue;
          n++;
          r += ss[p];
          g += ss[p + 1];
          b += ss[p + 2];
        }
      }
      if (n * 2 < SS * SS) continue;
      const o = (y * CELL_W + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------- 入力の読み込みと検査 ----------

const partsBuf = readFileSync(partsPath);
const partsSha = sha256(partsBuf);
const bounds = JSON.parse(readFileSync(boundsPath, 'utf8'));
const boundsByPart = Object.fromEntries(bounds.map((b) => [b.part, b.rect]));
for (const [name, rect] of Object.entries(PART_RECTS)) {
  const got = boundsByPart[name];
  if (!got || got.length !== 4 || got.some((v, i) => v !== rect[i])) fail(`parts-bounds.json の ${name} が指示の rect と違います: ${JSON.stringify(got)} / 期待 ${JSON.stringify(rect)}`);
}
const parts = await decodeRgba(partsBuf);
if (parts.width !== 1536 || parts.height !== 1024) fail(`パーツPNGの大きさが 1536x1024 ではありません: ${parts.width}x${parts.height}`);

const scaleOf = (r, d) => d / r;
const tex = {
  body: makeTexture(parts, PART_RECTS.body, 1 / (scaleOf(PART_RECTS.body[2], DST_RECTS.body[2]) * SS)),
  head: makeTexture(parts, PART_RECTS.head, 1 / (scaleOf(PART_RECTS.head[2], DST_RECTS.head[2]) * SS)),
  tail: makeTexture(parts, PART_RECTS.tail, 1 / (scaleOf(PART_RECTS.tail[2], DST_RECTS.tail[2]) * SS)),
};
const LEG_RECT = { fore: PART_RECTS.foreleg, hind: PART_RECTS.hindleg };

/** 足裏から約20元px上までの各行の不透明な横幅（元px）の中央値 = 白い足先の幅 */
function pawWidthSrc(t, sole) {
  const widths = [];
  for (let y = Math.max(0, Math.floor(sole[1]) - 20); y <= Math.min(t.h - 1, Math.floor(sole[1]) - 2); y++) {
    let lo = -1;
    let hi = -1;
    for (let x = 0; x < t.w; x++) {
      if (!t.opaqueAt(x, y)) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo >= 0) widths.push(hi - lo + 1);
  }
  if (!widths.length) return 0;
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}
/** 脚の幅の倍率 k は fullWalkCore.mjs の LEG_KINDS の値（前後とも .060）をそのまま使う。白い足先の幅は測って pose-checks に残すだけで、k は変えない */
const legInfo = {};
for (const kind of ['fore', 'hind']) {
  const k = LEG_KINDS[kind].k;
  const t = makeTexture(parts, LEG_RECT[kind], 1 / (k * SS));
  const widthSrc = pawWidthSrc(t, LEG_KINDS[kind].src[LEG_KINDS[kind].src.length - 1]);
  if (widthSrc <= 0) fail(`${kind} の足先の幅を測れませんでした（足裏の座標付近に不透明画素がありません）`);
  legInfo[kind] = { k, pawWidthSrcPx: widthSrc, pawWidthLogicalPx: Math.round(widthSrc * k * 100) / 100, inRange8to10: widthSrc * k >= 8 - 1e-9 && widthSrc * k <= 10 + 1e-9 };
  tex[kind] = t;
}
for (const [k, t] of Object.entries(tex)) if (t.opaque < 1000) fail(`${k} の texture に不透明画素が少なすぎます（${t.opaque}）。alpha>=${ALPHA_CUTOFF} の切り出しを確認してください`);

const skins = { fore: core.buildSkin('fore', 12, 32, legInfo.fore.k), hind: core.buildSkin('hind', 12, 32, legInfo.hind.k) };
const legBuf = { fore: new Float64Array(skins.fore.count * 2), hind: new Float64Array(skins.hind.count * 2) };

/** 脚の上端（texture の最初に不透明が並ぶ行のすぐ下）の頂点。胴に隠れるかの確認用 */
const rootProbeVerts = {};
for (const kind of ['fore', 'hind']) {
  const t = tex[kind];
  const sk = skins[kind];
  let topY = 0;
  for (let y = 0; y < t.h; y++) {
    let n = 0;
    for (let x = 0; x < t.w; x++) if (t.opaqueAt(x, y)) n++;
    if (n >= 5) {
      topY = y;
      break;
    }
  }
  const gy = Math.min(sk.ny, Math.max(0, Math.round(((topY + 8) / t.h) * sk.ny)));
  const verts = [];
  for (let gx = 0; gx <= sk.nx; gx++) {
    const v = gy * (sk.nx + 1) + gx;
    if (t.opaqueAt(sk.sx[v], sk.sy[v])) verts.push(v);
  }
  if (!verts.length) fail(`${kind} の脚の上端の頂点が見つかりません`);
  rootProbeVerts[kind] = verts;
}

// 尾の根元の被り確認用の点（尾 rect の左下の不透明な元座標）
const tailProbes = [];
for (let sy = PART_RECTS.tail[3] * 0.8; sy < PART_RECTS.tail[3]; sy += 6) {
  for (let sx = 0; sx < PART_RECTS.tail[2] * 0.3; sx += 6) if (tex.tail.opaqueAt(sx, sy)) tailProbes.push([sx, sy]);
}

// ---------- 1コマを描く ----------

function renderPose(pose) {
  const t = pose.t;
  const stats = { flipped: 0 };
  const layers = {};
  const rootProbes = {};
  layers.tail = newLayer();
  rasterMesh(layers.tail, gridMesh(PART_RECTS.tail[2], PART_RECTS.tail[3], 10, 14, (sx, sy) => core.tailMap(t, sx, sy)), tex.tail, 1, stats);
  for (const name of LEG_NAMES) {
    const kind = LEGS[name].kind;
    const skin = skins[kind];
    core.skinPositions(skin, core.targetFrames(skin, pose.legs[name]), legBuf[kind]);
    rootProbes[name] = rootProbeVerts[kind].map((v) => [legBuf[kind][v * 2], legBuf[kind][v * 2 + 1]]);
    layers[name] = newLayer();
    rasterMesh(layers[name], { nx: skin.nx, ny: skin.ny, sx: skin.sx, sy: skin.sy, dxy: legBuf[kind] }, tex[kind], LEGS[name].far ? FAR_SHADE : 1, stats);
  }
  layers.body = newLayer();
  rasterMesh(layers.body, gridMesh(PART_RECTS.body[2], PART_RECTS.body[3], 24, 20, (sx, sy) => core.bodyMap(t, sx, sy)), tex.body, 1, stats);
  layers.head = newLayer();
  rasterMesh(layers.head, gridMesh(PART_RECTS.head[2], PART_RECTS.head[3], 8, 8, (sx, sy) => core.headMap(t, sx, sy)), tex.head, 1, stats);
  const cell = downsample(compose([layers.tail, layers.RH, layers.RF, layers.LH, layers.LF, layers.body, layers.head]));
  return { cell, layers, stats, rootProbes };
}

function rasterMetrics(pose, r) {
  const { cell, layers, stats, rootProbes } = r;
  let opaque = 0;
  let minX = CELL_W;
  let minY = CELL_H;
  let maxX = -1;
  let maxY = -1;
  let groundRows = 0;
  let nonBinary = 0;
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      const a = cell[(y * CELL_W + x) * 4 + 3];
      if (a !== 0 && a !== 255) nonBinary++;
      if (a === 0) continue;
      opaque++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      if (y >= 64 && y <= 67) groundRows++;
    }
  }
  let neckPx = 0;
  for (let i = 0; i < W * H; i++) if (layers.body[i * 4 + 3] && layers.head[i * 4 + 3]) neckPx++;
  let covered = 0;
  for (const [sx, sy] of tailProbes) {
    const p = core.tailMap(pose.t, sx, sy);
    const ix = Math.floor(p[0] * SS);
    const iy = Math.floor(p[1] * SS);
    if (ix >= 0 && iy >= 0 && ix < W && iy < H && layers.body[(iy * W + ix) * 4 + 3]) covered++;
  }
  const nx = Math.floor(pose.head.neck[0] * SS);
  const ny = Math.floor(pose.head.neck[1] * SS);
  // 各脚の上端の頂点が、胴（または頭）に覆われる率。1 に近いほど脚の根元が胴に隠れる（脚が胴の外に浮いて見えない）
  const legRootCovered = {};
  for (const name of LEG_NAMES) {
    let n = 0;
    for (const [px, py] of rootProbes[name]) {
      const ix = Math.floor(px * SS);
      const iy = Math.floor(py * SS);
      if (ix >= 0 && iy >= 0 && ix < W && iy < H && (layers.body[(iy * W + ix) * 4 + 3] || layers.head[(iy * W + ix) * 4 + 3])) n++;
    }
    legRootCovered[name] = Math.round((n / rootProbes[name].length) * 1000) / 1000;
  }
  return {
    legRootCoveredByBody: legRootCovered,
    opaquePx: opaque,
    bbox: opaque ? [minX, minY, maxX, maxY] : null,
    touchesCellEdge: opaque > 0 && (minX === 0 || minY === 0 || maxX === CELL_W - 1 || maxY === CELL_H - 1),
    groundRowOpaquePx: groundRows,
    nonBinaryAlphaPx: nonBinary,
    neckOverlapLogicalPx: Math.round((neckPx / (SS * SS)) * 100) / 100,
    neckPointInBody: Boolean(layers.body[(ny * W + nx) * 4 + 3]),
    tailBaseCoveredByBody: tailProbes.length ? Math.round((covered / tailProbes.length) * 1000) / 1000 : 0,
    flippedTriangles: stats.flipped,
  };
}

// ---------- 30コマ＋休止を描く ----------

const walkCells = [];
const frameChecks = [];
const problems = [];
for (let n = 0; n < FRAMES; n++) {
  const pose = core.poseAt(n);
  if (!core.allFinite(pose)) fail(`frame ${n}: 姿勢に NaN/Infinity があります`);
  const r = renderPose(pose);
  const m = rasterMetrics(pose, r);
  if (m.opaquePx < 300) problems.push(`frame ${n}: 絵がほぼ空です（不透明 ${m.opaquePx}px）`);
  if (m.groundRowOpaquePx === 0) problems.push(`frame ${n}: 足元（y64〜67）に不透明画素がありません`);
  if (m.nonBinaryAlphaPx) problems.push(`frame ${n}: 半透明画素があります`);
  walkCells.push(r.cell);
  frameChecks.push({ ...core.poseCheck(n), raster: m });
}
const idle = core.idlePose();
if (!core.allFinite(idle)) fail('idle: 姿勢に NaN/Infinity があります');
const idleRender = renderPose(idle);
const idleMetrics = rasterMetrics(idle, idleRender);
if (idleMetrics.opaquePx < 300) problems.push(`idle: 絵がほぼ空です（${idleMetrics.opaquePx}px）`);
if (idleMetrics.groundRowOpaquePx === 0) problems.push('idle: 足元（y64〜67）に不透明画素がありません');

// 休止の前後の移行6枚ずつ。settle = t0 の姿勢で浮いた脚だけ接地へ（最後の1枚は idle と同じ）、start = 接地から浮かせ戻す（最後の1枚は歩行の0番と同じ）
const TF = core.TRANSITION_FRAMES;
const transitions = { settle: [], start: [] };
for (const kind of ['settle', 'start']) {
  for (let i = 0; i < TF; i++) {
    const liftScale = kind === 'settle' ? 1 - (i + 1) / TF : (i + 1) / TF;
    const pose = core.poseAt(0, { liftScale });
    if (!core.allFinite(pose)) fail(`${kind}#${i}: 姿勢に NaN/Infinity があります`);
    const r = renderPose(pose);
    const m = rasterMetrics(pose, r);
    if (m.opaquePx < 300) problems.push(`${kind}#${i}: 絵がほぼ空です（${m.opaquePx}px）`);
    if (m.groundRowOpaquePx === 0) problems.push(`${kind}#${i}: 足元（y64〜67）に不透明画素がありません`);
    if (m.nonBinaryAlphaPx) problems.push(`${kind}#${i}: 半透明画素があります`);
    transitions[kind].push({ cell: r.cell, check: { ...core.poseCheck(0, { liftScale }), liftScale, raster: m } });
  }
}
if (problems.length) {
  for (const p of problems) console.error(`NG: ${p}`);
  fail('描画の検査に失敗したため何も書き出しません');
}

// ---------- 書き出し ----------

// 実際に書く7ファイルが入力（原PNG・parts-bounds.json）と同じパスでないことを、何かを書く前に確かめる
const OUTPUT_FILES = ['apricot-walk-30.png', 'walk-keys8.png', 'apricot-walk-idle.png', 'apricot-walk-settle.png', 'apricot-walk-start.png', 'manifest.json', 'pose-checks.json'];
for (const f of OUTPUT_FILES) {
  const p = path.resolve(outDir, f);
  if (p === partsPath || p === boundsPath) fail(`出力先が入力と同じファイルです（書きません）: ${p}`);
}

const atlas = new Uint8ClampedArray(WALK_W * WALK_H * 4);
const frames = [];
walkCells.forEach((cell, i) => {
  const cx = (i % COLS) * CELL_W;
  const cy = Math.floor(i / COLS) * CELL_H;
  for (let y = 0; y < CELL_H; y++) atlas.set(cell.subarray(y * CELL_W * 4, (y + 1) * CELL_W * 4), ((cy + y) * WALK_W + cx) * 4);
  frames.push({ index: i, rect: [cx, cy, CELL_W, CELL_H], anchor: [...ANCHOR] });
});

const keysW = 4 * CELL_W * KEY_SCALE;
const keysH = 2 * CELL_H * KEY_SCALE;
const keys = new Uint8ClampedArray(keysW * keysH * 4);
KEY_FRAMES.forEach((f, i) => {
  const ox = (i % 4) * CELL_W * KEY_SCALE;
  const oy = Math.floor(i / 4) * CELL_H * KEY_SCALE;
  for (let y = 0; y < CELL_H * KEY_SCALE; y++) {
    for (let x = 0; x < CELL_W * KEY_SCALE; x++) {
      const s = ((Math.floor(y / KEY_SCALE)) * CELL_W + Math.floor(x / KEY_SCALE)) * 4;
      const d = ((oy + y) * keysW + ox + x) * 4;
      keys[d] = walkCells[f][s];
      keys[d + 1] = walkCells[f][s + 1];
      keys[d + 2] = walkCells[f][s + 2];
      keys[d + 3] = walkCells[f][s + 3];
    }
  }
});

/** 6枚を横1列（576x80）に並べる */
const stripOf = (list) => {
  const rgba = new Uint8ClampedArray(CELL_W * TF * CELL_H * 4);
  list.forEach((t, i) => {
    for (let y = 0; y < CELL_H; y++) rgba.set(t.cell.subarray(y * CELL_W * 4, (y + 1) * CELL_W * 4), (y * CELL_W * TF + i * CELL_W) * 4);
  });
  return rgba;
};
const stripFrames = () => Array.from({ length: TF }, (_, i) => ({ index: i, rect: [i * CELL_W, 0, CELL_W, CELL_H], anchor: [...ANCHOR] }));

const outputs = [
  { file: 'apricot-walk-30.png', width: WALK_W, height: WALK_H, rgba: atlas },
  { file: 'walk-keys8.png', width: keysW, height: keysH, rgba: keys },
  { file: 'apricot-walk-idle.png', width: CELL_W, height: CELL_H, rgba: idleRender.cell },
  { file: 'apricot-walk-settle.png', width: CELL_W * TF, height: CELL_H, rgba: stripOf(transitions.settle) },
  { file: 'apricot-walk-start.png', width: CELL_W * TF, height: CELL_H, rgba: stripOf(transitions.start) },
];
const shas = {};
const pngBufs = {};
// 3枚とも encode と読み戻し検証を先に済ませ、全部通ってから書く（途中失敗で PNG だけ残る状態を作らない）
for (const o of outputs) {
  const buf = encodePng(o.width, o.height, o.rgba);
  // encode した PNG を読み戻し、大きさ・画素・二値alphaが一致することを確かめる
  const back = await decodeRgba(buf);
  if (back.width !== o.width || back.height !== o.height) fail(`${o.file}: 読み戻した大きさが違います`);
  let diff = 0;
  for (let i = 0; i < o.rgba.length; i += 4) {
    if (back.data[i + 3] !== o.rgba[i + 3]) diff++;
    else if (o.rgba[i + 3] === 255 && (back.data[i] !== o.rgba[i] || back.data[i + 1] !== o.rgba[i + 1] || back.data[i + 2] !== o.rgba[i + 2])) diff++;
  }
  if (diff) fail(`${o.file}: 読み戻しで ${diff} 画素が一致しません`);
  pngBufs[o.file] = buf;
  shas[o.file] = sha256(buf);
}

const METHOD =
  '原画の再生成ではない。新規に作った5枚の連続した有機的パーツ（apricot-fullbody-parts.png: 胴・頭・尾・前脚・後脚）を、' +
  '30姿勢の全身へ連続変形（胴=胸腰の横位置メッシュ変形、頭=首で回転、尾=根元から先端へ遅れる変形、脚=1枚の皮膚を骨の重みで変形するスキニング）して合成した絵。' +
  '30枚の新規手描きではない。描画用の一時textureは alpha>=180 だけを不透明にし、原PNGの周辺光は使わず原PNGは加工しない。' +
  `${SS}倍の格子へ三角形を描いてから、被覆が半分以上の画素だけを不透明にして ${CELL_W}x${CELL_H} の論理格子へ戻す。`;

const manifest = {
  version: 1,
  method: METHOD,
  note: '数値は設計値（実在の動物の測定値ではない）。自然さの合否はこの JSON ではなく親の実物比較で判断する。',
  inputs: { parts: { file: path.basename(partsPath), sha256: partsSha }, bounds: { file: path.basename(boundsPath), rects: PART_RECTS } },
  parameters: {
    strideLogicalPx: core.STRIDE_PX,
    support: core.SUPPORT,
    liftLogicalPx: core.LIFT_PX,
    ankleHeight: core.ANKLE_H,
    toeCurlDeg: core.TOE_CURL_DEG,
    ground: { near: 68, far: 65.5 },
    renderSuperSample: SS,
    alphaCutoff: ALPHA_CUTOFF,
    farLegShade: FAR_SHADE,
    legWidthScale: { fore: legInfo.fore.k, hind: legInfo.hind.k },
    pawWidthLogicalPx: { fore: legInfo.fore.pawWidthLogicalPx, hind: legInfo.hind.pawWidthLogicalPx },
  },
  atlases: {
    walk: {
      file: 'apricot-walk-30.png',
      width: WALK_W,
      height: WALK_H,
      referenceWidth: REFERENCE_WIDTH,
      durationMs: DURATION_MS,
      frameCount: FRAMES,
      sha256: shas['apricot-walk-30.png'],
      frames,
    },
    idle: {
      file: 'apricot-walk-idle.png',
      width: CELL_W,
      height: CELL_H,
      referenceWidth: REFERENCE_WIDTH,
      durationMs: 0,
      frameCount: 1,
      sha256: shas['apricot-walk-idle.png'],
      frames: [{ index: 0, rect: [0, 0, CELL_W, CELL_H], anchor: [...ANCHOR] }],
      note: 't0 の胴・頭・尾・足の x のまま、浮いていた左前足だけを同じ x で接地させた4脚立ち',
    },
    settle: {
      file: 'apricot-walk-settle.png',
      width: CELL_W * TF,
      height: CELL_H,
      referenceWidth: REFERENCE_WIDTH,
      durationMs: core.TRANSITION_FRAME_MS * TF,
      frameCount: TF,
      sha256: shas['apricot-walk-settle.png'],
      frames: stripFrames(),
      note: 'poseAt(0,{liftScale:1-(i+1)/6})。胴・頭・尾と支持足の x は t0 のまま、浮いた左前足だけが接地へ。最後の1枚は idle と同じ姿勢',
    },
    start: {
      file: 'apricot-walk-start.png',
      width: CELL_W * TF,
      height: CELL_H,
      referenceWidth: REFERENCE_WIDTH,
      durationMs: core.TRANSITION_FRAME_MS * TF,
      frameCount: TF,
      sha256: shas['apricot-walk-start.png'],
      frames: stripFrames(),
      note: 'poseAt(0,{liftScale:(i+1)/6})。接地から左前足を浮かせ戻す。最後の1枚は歩行の0番と同じ姿勢',
    },
  },
};

// ---------- pose-checks.json ----------

const overextended = frameChecks.filter((f) => f.overextended.length).map((f) => ({ frame: f.frame, legs: f.overextended }));
let maxOver = 0;
for (const f of frameChecks) for (const l of Object.values(f.legs)) maxOver = Math.max(maxOver, l.reach - l.maxReach);
const flat = (v, out = []) => {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => flat(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (k === 'n' || k === 't' ? null : flat(x, out)));
  return out;
};
const a0 = flat(core.poseAt(0));
const a30 = flat(core.poseAt(FRAMES));
const loopError = Math.max(...a0.map((v, i) => Math.abs(v - a30[i])));
let maxSoleStep = 0;
for (let n = 0; n < FRAMES; n++) {
  const p = core.poseAt(n);
  const q = core.poseAt(n + 1);
  for (const name of LEG_NAMES) maxSoleStep = Math.max(maxSoleStep, Math.hypot(p.legs[name].sole[0] - q.legs[name].sole[0], p.legs[name].sole[1] - q.legs[name].sole[1]));
}
const supportCounts = frameChecks.map((f) => f.supportCount);
const poseChecks = {
  version: 1,
  method: METHOD,
  note: '設計値の検査。足の世界x・過伸展・重なりは数値で残すが、自然さの合格ではない。親が8主要姿勢と実再生を見て採否を決める。',
  summary: {
    frames: FRAMES,
    anyOverextended: overextended.length > 0,
    overextendedFrames: overextended,
    maxOverreachLogicalPx: Math.round(Math.max(0, maxOver) * 10000) / 10000,
    stanceWorldXDrift: Object.fromEntries(LEG_NAMES.map((name) => [name, core.stanceDrift(name)])),
    supportCountMin: Math.min(...supportCounts),
    supportCountMax: Math.max(...supportCounts),
    loopClosureError: loopError,
    maxSoleStepBetweenFramesLogicalPx: Math.round(maxSoleStep * 1000) / 1000,
    flippedTrianglesTotal: frameChecks.reduce((s, f) => s + f.raster.flippedTriangles, 0),
    framesTouchingCellEdge: frameChecks.filter((f) => f.raster.touchesCellEdge).map((f) => f.frame),
    minTailBaseCoveredByBody: Math.min(...frameChecks.map((f) => f.raster.tailBaseCoveredByBody)),
    minNeckOverlapLogicalPx: Math.min(...frameChecks.map((f) => f.raster.neckOverlapLogicalPx)),
    framesNeckPointOutsideBody: frameChecks.filter((f) => !f.raster.neckPointInBody).map((f) => f.frame),
    // 脚の上端の頂点が胴（または頭）に覆われる率の最小（脚ごと）。1 未満なら脚の根元が胴の外に出て浮いて見える恐れ
    minLegRootCoveredByBody: Object.fromEntries(LEG_NAMES.map((name) => [name, Math.min(...frameChecks.map((f) => f.raster.legRootCoveredByBody[name]))])),
    // 白い足先の幅（足裏から約20元px上までの不透明な横幅の中央値×k。k は .060 固定で、ここは測っただけ）。目標は 8〜10 論理px
    pawWidth: legInfo,
    // 休止の前後の移行（settle/start 各6枚）と idle の過伸展
    transitionOverextended: ['settle', 'start'].flatMap((kind) => transitions[kind].map((t, i) => ({ kind, index: i, legs: t.check.overextended }))).filter((e) => e.legs.length),
    idleOverextended: core.poseCheck(0, { liftScale: 0 }).overextended,
  },
  frames: frameChecks,
  idle: { ...core.poseCheck(0, { liftScale: 0 }), raster: idleMetrics, note: '全4脚が接地（LF だけ t0 と同じ x で y を地面へ）' },
  settle: transitions.settle.map((t) => t.check),
  start: transitions.start.map((t) => t.check),
};

// ---------- 書き出し（検査と読み戻しがすべて通ってから） ----------

mkdirSync(outDir, { recursive: true });
for (const o of outputs) writeFileSync(path.join(outDir, o.file), pngBufs[o.file]);
writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(outDir, 'pose-checks.json'), `${JSON.stringify(poseChecks, null, 2)}\n`);

console.log(`OK: ${outputs.map((o) => o.file).join(', ')}, manifest.json, pose-checks.json -> ${outDir}`);
const s = poseChecks.summary;
console.log(`過伸展: ${s.anyOverextended ? `あり（${s.overextendedFrames.length}コマ・最大 ${s.maxOverreachLogicalPx}px 伸ばして足を接地のまま保持）` : 'なし'}`);
console.log(`支持脚数 ${s.supportCountMin}〜${s.supportCountMax} / ループ閉じ誤差 ${s.loopClosureError.toExponential(2)} / 折れ返し三角形 ${s.flippedTrianglesTotal}`);
console.log(`移行(settle/start)の過伸展: ${s.transitionOverextended.length ? JSON.stringify(s.transitionOverextended) : 'なし'} / idle: ${JSON.stringify(s.idleOverextended)}`);
console.log(`脚の根元が胴に隠れる率の最小 ${JSON.stringify(s.minLegRootCoveredByBody)} / 白い足先の幅(論理px) 前${legInfo.fore.pawWidthLogicalPx} 後${legInfo.hind.pawWidthLogicalPx}（幅の倍率 k 前${legInfo.fore.k} 後${legInfo.hind.k}、8〜10に入る: 前${legInfo.fore.inRange8to10} 後${legInfo.hind.inRange8to10}）`);
console.log(`尾の根元が胴に隠れる率の最小 ${s.minTailBaseCoveredByBody} / 首の重なり最小 ${s.minNeckOverlapLogicalPx}px² / セル端に触れるコマ ${JSON.stringify(s.framesTouchingCellEdge)}`);
