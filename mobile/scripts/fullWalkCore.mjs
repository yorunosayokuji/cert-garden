// 全身連動の歩き30姿勢（motion-v4）の純粋計算。canvas・ファイル・画像に依存しない。
// 絵を描く render-full-walk.mjs と test/fullWalk.test.ts の両方がここを読む。
//
// 座標は 96x80 の論理格子（左向き・y下向き）。近い側の接地線は y68、奥側は y65.5。
// 数値は「設計値」であり、実在の動物を測った値ではない（親が実物を見て調整する前提）。
// 5枚の新規パーツ（胴・頭・尾・前脚・後脚）を、30姿勢ぶんの連続変形で全身へ組む。
// 旧 gaitRig.ts は参照のみ（骨の長さ・IK の考え方）。そこの分節した棒は使わない。

export const FRAMES = 30;
export const DURATION_MS = 1800;
export const CELL_W = 96;
export const CELL_H = 80;
export const COLS = 6;
export const ROWS = 5;
export const ANCHOR = [48, 68];
/** 頭から尾までの可視幅（論理px）。頭を大きくした全身で約90。アプリの STUDY_WALK.strideBody=14/90 と同じ値 */
export const REFERENCE_WIDTH = 90;
/** 休止の前後の移行（足を下げる settle / 上げる start）の枚数と、1枚の表示時間 */
export const TRANSITION_FRAMES = 6;
export const TRANSITION_FRAME_MS = 40;
export const ALPHA_CUTOFF = 180;
export const TAU = Math.PI * 2;

/** 1周期でルート（体）が左へ進む論理px。支持中の足は体に対して同じ速さで右へ動き、世界座標では止まる */
export const STRIDE_PX = 14;
export const SUPPORT = 0.65;
export const SPAN_PX = STRIDE_PX * SUPPORT;
export const LIFT_PX = 3.2;
/** 足首から足裏までの高さ */
export const ANKLE_H = 2.8;
export const TOE_CURL_DEG = 5;

/** apricot-fullbody-parts.png（1536x1024）内の実測 rect [x,y,w,h]。parts-bounds.json と同じ（描画時に突き合わせる） */
export const PART_RECTS = {
  body: [64, 138, 444, 361],
  head: [548, 143, 442, 356],
  tail: [1079, 21, 399, 484],
  foreleg: [160, 601, 231, 341],
  hindleg: [672, 601, 234, 348],
};
/** 静止姿勢での配置先 [x,y,w,h]（論理px） */
export const DST_RECTS = { body: [27, 19, 44, 35], head: [2, 20, 44, 35.4], tail: [60, 2, 30, 36.4] };

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const smoothstep = (e0, e1, x) => {
  const k = clamp((x - e0) / (e1 - e0), 0, 1);
  return k * k * (3 - 2 * k);
};

// ---------- 胴 ----------

export const CHEST_X0 = 31;
export const HIP_X0 = 61;
const BODY_TOP = DST_RECTS.body[1];
const BODY_BOTTOM = DST_RECTS.body[1] + DST_RECTS.body[3];
export const PETAL_AMP = 0.2;
export const PETAL_PHASE = 0.08;

/** 胸と腰の動き（論理px）。y は下が正。周期は胸腰とも 1周期に2回（4π）か1回 */
export const chestOffset = (t) => ({ x: 0.35 * Math.sin(TAU * t), y: 0.7 * Math.cos(2 * TAU * (t - 0.25)) });
export const hipOffset = (t) => ({ x: -0.3 * Math.sin(TAU * t), y: 0.55 * Math.cos(2 * TAU * t) });

/**
 * 胴の連続変形。静止配置後の位置 (bx,by) の変位。x=30 が胸、x=61 が腰で、その間は横位置に応じて連続に混ぜる
 * （体全体の上下移動だけにしない）。背の高い所ほど花びらの遅れ（+.20*sin）を足す。
 */
export function bodyDisplacement(t, bx, by) {
  const c = chestOffset(t);
  const h = hipOffset(t);
  const w = clamp((bx - CHEST_X0) / (HIP_X0 - CHEST_X0), 0, 1);
  const up = clamp((BODY_BOTTOM - by) / (BODY_BOTTOM - BODY_TOP), 0, 1);
  return [lerp(c.x, h.x, w), lerp(c.y, h.y, w) + PETAL_AMP * Math.sin(TAU * (t - PETAL_PHASE)) * up];
}
/** 胴 rect 内の元座標 (sx,sy) → 論理格子上の位置 */
export function bodyMap(t, sx, sy) {
  const [x, y, w, h] = DST_RECTS.body;
  const r = PART_RECTS.body;
  const bx = x + (sx * w) / r[2];
  const by = y + (sy * h) / r[3];
  const d = bodyDisplacement(t, bx, by);
  return [bx + d[0], by + d[1]];
}

// ---------- 頭 ----------

/** 首の接続点（静止時の論理座標）。頭はここを中心にわずかに回る */
export const NECK = [34, 50];
export const headOffset = (t) => ({
  dx: chestOffset(t).x,
  dy: 0.3 * Math.cos(2 * TAU * (t - 0.29)),
  rot: 0.012 * Math.sin(2 * TAU * (t - 0.29)),
});
export function headMap(t, sx, sy) {
  const [x, y, w, h] = DST_RECTS.head;
  const r = PART_RECTS.head;
  const bx = x + (sx * w) / r[2];
  const by = y + (sy * h) / r[3];
  const o = headOffset(t);
  const px = bx - NECK[0];
  const py = by - NECK[1];
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  return [NECK[0] + px * c - py * s + o.dx, NECK[1] + px * s + py * c + o.dy];
}

// ---------- 尾 ----------

/** 尾の根元（静止時の論理座標・参考）。胴の後ろ側に隠れて重なる。位置の微調整は TAIL_OFFSET だけで行う */
export const TAIL_BASE = [64, 38];
export const TAIL_OFFSET = [0, 0];
/** 先端（u=1）で根元の追従を遅らせる量（周期の割合）。設計値 */
export const TAIL_LAG = 0.1;
/** u: 尾 rect の下端=0 → 上端=1 */
export const tailU = (sy) => clamp(1 - sy / PART_RECTS.tail[3], 0, 1);
export function tailDisplacement(t, u) {
  const hp = hipOffset(t - TAIL_LAG * u);
  const e = Math.pow(u, 1.5);
  return [hp.x + 0.9 * Math.sin(TAU * (t - 0.12)) * e, hp.y + 0.7 * Math.sin(TAU * (t - 0.18)) * e];
}
export function tailMap(t, sx, sy) {
  const [x, y, w, h] = DST_RECTS.tail;
  const r = PART_RECTS.tail;
  const bx = x + TAIL_OFFSET[0] + (sx * w) / r[2];
  const by = y + TAIL_OFFSET[1] + (sy * h) / r[3];
  const d = tailDisplacement(t, tailU(sy));
  return [bx + d[0], by + d[1]];
}

// ---------- 脚 ----------

/** 描画順（奥→手前）。手前=近い側。 */
export const LEG_NAMES = ['RH', 'RF', 'LH', 'LF'];
export const LEGS = {
  LF: { kind: 'fore', far: false, phase: 0.25, root: [31, 54], center: 29, ground: 68 },
  RF: { kind: 'fore', far: true, phase: 0.75, root: [28, 52.5], center: 26, ground: 65.5 },
  LH: { kind: 'hind', far: false, phase: 0, root: [61, 51], center: 60, ground: 68 },
  RH: { kind: 'hind', far: true, phase: 0.5, root: [58, 49.5], center: 57, ground: 65.5 },
};
/** 骨の長さ（論理px）。前=肩→肘/肘→足首、後ろ=股→膝/膝→飛節/飛節→足首。短い丸い脚（届かないコマは隠さず pose-checks に残る） */
export const BONES = { fore: [6, 6.7], hind: [6, 6, 4] };
const HOCK_BASE_DEG = 30;
const HOCK_FLEX_DEG = 25;
const REACH_K = 0.995;
const DEG = Math.PI / 180;

export function legRel(name, t) {
  const rel = (t - LEGS[name].phase) % 1;
  return rel < 0 ? rel + 1 : rel;
}

/** 体に対する足裏位置。支持=一定速度で右へ、遊脚=smoothstep で前へ返しつつ持ち上げる。liftScale=0 は遊脚も同じ x で接地 */
export function footTarget(name, t, liftScale = 1) {
  const L = LEGS[name];
  const rel = legRel(name, t);
  if (rel < SUPPORT - 1e-9) {
    return { x: L.center - SPAN_PX / 2 + STRIDE_PX * rel, y: L.ground, support: true, swingS: 0, rel };
  }
  const s = clamp((rel - SUPPORT) / (1 - SUPPORT), 0, 1);
  const e = smoothstep(0, 1, s);
  return { x: L.center + SPAN_PX / 2 - SPAN_PX * e, y: L.ground - LIFT_PX * Math.sin(Math.PI * s) * liftScale, support: false, swingS: s, rel };
}

/** 2関節IK。mid は root→target の線から bendX 側（+1=右/後ろ、-1=左/前）へ折れる */
export function ik2(root, target, l1, l2, bendX) {
  const dx = target[0] - root[0];
  const dy = target[1] - root[1];
  const dist = Math.hypot(dx, dy);
  const maxD = (l1 + l2) * REACH_K;
  const minD = Math.abs(l1 - l2) + 0.5;
  const d = clamp(dist, minD, maxD);
  const ux = dist > 1e-9 ? dx / dist : 0;
  const uy = dist > 1e-9 ? dy / dist : 1;
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let px = -uy;
  let py = ux;
  if (px * bendX < 0) {
    px = -px;
    py = -py;
  }
  return { mid: [root[0] + ux * a + px * h, root[1] + uy * a + py * h], end: [root[0] + ux * d, root[1] + uy * d], clamped: d !== dist, dist, maxD };
}

/** 根元 root・足首 ankle から後ろ脚の飛節を決める。飛節は足首から後ろ（右）へ傾く。股から飛節が届かないときは傾きを減らす */
function hockFor(root, ankle, swingS, liftScale) {
  const [l1, l2, l3] = BONES.hind;
  const base = HOCK_BASE_DEG + HOCK_FLEX_DEG * Math.sin(Math.PI * swingS) * liftScale;
  const limit = (l1 + l2) * 0.985;
  let deg = base;
  let hock = [ankle[0] + l3 * Math.sin(deg * DEG), ankle[1] - l3 * Math.cos(deg * DEG)];
  for (let k = 0; Math.hypot(hock[0] - root[0], hock[1] - root[1]) > limit && k < 1000; k++) {
    deg = base - 0.1 * (k + 1);
    if (deg < -40) {
      deg = -40;
      hock = [ankle[0] + l3 * Math.sin(deg * DEG), ankle[1] - l3 * Math.cos(deg * DEG)];
      break;
    }
    hock = [ankle[0] + l3 * Math.sin(deg * DEG), ankle[1] - l3 * Math.cos(deg * DEG)];
  }
  return { hock, hockDeg: deg };
}

const angleOf = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

/**
 * 1本の脚の姿勢。joints は皮膚を動かす骨の関節列（前=[肩,肘,足首,足裏]、後ろ=[股,膝,飛節,足首,足裏]）。
 * 骨が届かないときは clamped=true と reach/maxReach を残す（隠さない）。足は目標に置いたまま（足滑りを避ける）、
 * 骨の長さのほうが目標へ伸びる（骨に沿った倍率で皮膚が伸びる）。伸びた量は reach - maxReach で分かる。
 */
export function legPose(name, t, liftScale = 1) {
  const L = LEGS[name];
  const off = L.kind === 'fore' ? chestOffset(t) : hipOffset(t);
  const root = [L.root[0] + off.x, L.root[1] + off.y];
  const tgt = footTarget(name, t, liftScale);
  const ankleT = [tgt.x, tgt.y - ANKLE_H];
  const curl = tgt.support ? 0 : -TOE_CURL_DEG * DEG * Math.sin(Math.PI * tgt.swingS) * liftScale;
  const pawDir = [-Math.sin(curl), Math.cos(curl)];
  let joints;
  let ankle;
  let clamped;
  let reach;
  let maxReach;
  let hockDeg = null;
  if (L.kind === 'fore') {
    const [l1, l2] = BONES.fore;
    const r = ik2(root, ankleT, l1, l2, 1);
    ankle = ankleT;
    joints = [root, r.mid, ankle];
    clamped = r.clamped;
    reach = r.dist;
    maxReach = r.maxD;
  } else {
    const [l1, l2] = BONES.hind;
    const h = hockFor(root, ankleT, tgt.swingS, liftScale);
    const r = ik2(root, h.hock, l1, l2, -1);
    ankle = ankleT;
    joints = [root, r.mid, h.hock, ankle];
    clamped = r.clamped;
    reach = r.dist;
    maxReach = r.maxD;
    hockDeg = h.hockDeg;
  }
  const sole = [ankle[0] + pawDir[0] * ANKLE_H, ankle[1] + pawDir[1] * ANKLE_H];
  joints.push(sole);
  // 上の骨と次の骨の折れ角（度）。前脚=肘、後ろ脚=膝
  const bendDeg = ((angleOf(joints[1], joints[2]) - angleOf(joints[0], joints[1])) * 180) / Math.PI;
  return {
    name,
    kind: L.kind,
    far: L.far,
    rel: tgt.rel,
    support: tgt.support,
    swingS: tgt.swingS,
    root,
    joints,
    ankle,
    sole,
    pawDir,
    curlDeg: (curl * 180) / Math.PI,
    hockDeg,
    bendDeg,
    clamped,
    reach,
    maxReach,
  };
}

/** n 番目の姿勢（n は周期をまたいで増えてよい）。liftScale=0 で遊脚も同じ x のまま接地（休止の立ち姿） */
export function poseAt(n, opts = {}) {
  const t = n / FRAMES;
  const liftScale = opts.liftScale ?? 1;
  const legs = {};
  for (const name of LEG_NAMES) legs[name] = legPose(name, t, liftScale);
  const chest = chestOffset(t);
  const hip = hipOffset(t);
  const head = headOffset(t);
  const tailTip = tailDisplacement(t, 1);
  const tailBase = tailDisplacement(t, 0);
  return {
    n,
    t,
    liftScale,
    chest,
    hip,
    head: { ...head, neck: [NECK[0] + chest.x, NECK[1] + chest.y], neckHeadSide: [NECK[0] + head.dx, NECK[1] + head.dy] },
    tail: { base: [TAIL_BASE[0] + TAIL_OFFSET[0] + tailBase[0], TAIL_BASE[1] + TAIL_OFFSET[1] + tailBase[1]], tipDisplacement: tailTip },
    legs,
    supportCount: LEG_NAMES.filter((k) => legs[k].support).length,
  };
}

/** 休止（idle）。t0 の胴・頭・尾・足の x のまま、浮いた脚だけ接地させた4脚立ち */
export const idlePose = () => poseAt(0, { liftScale: 0 });

/** 通し番号 n の瞬間の足裏の世界 x（体は左へ STRIDE_PX/周期 動く） */
export const footWorldX = (pose, name, n) => pose.legs[name].sole[0] - (STRIDE_PX * n) / FRAMES;

/** 支持ごとの足裏の世界 x のばらつき（最大-最小）。1本の脚の n 0..cycles*FRAMES-1 を支持の連なりごとに見る */
export function stanceDrift(name, cycles = 3) {
  const groups = new Map();
  for (let n = 0; n < FRAMES * cycles; n++) {
    const p = poseAt(n);
    if (!p.legs[name].support) continue;
    const key = Math.floor(n / FRAMES - LEGS[name].phase + 1e-9);
    const x = footWorldX(p, name, n);
    const g = groups.get(key) ?? { min: x, max: x };
    g.min = Math.min(g.min, x);
    g.max = Math.max(g.max, x);
    groups.set(key, g);
  }
  return Math.max(...[...groups.values()].map((g) => g.max - g.min));
}

/** 数値がすべて有限か（NaN/Infinity が1つでも出たら false） */
export function allFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
}

const r4 = (v) => Math.round(v * 10000) / 10000;
const rp = (p) => p.map(r4);

/** pose-checks.json の1コマぶん（絵に依存しない項目） */
export function poseCheck(n, opts = {}) {
  const p = poseAt(n, opts);
  const legs = {};
  for (const name of LEG_NAMES) {
    const l = p.legs[name];
    legs[name] = {
      support: l.support,
      rel: r4(l.rel),
      sole: rp(l.sole),
      ankle: rp(l.ankle),
      soleHorizontal: Math.abs(l.pawDir[0]) < 1e-12,
      curlDeg: r4(l.curlDeg),
      root: rp(l.root),
      joints: l.joints.map(rp),
      bendDeg: r4(l.bendDeg),
      hockDeg: l.hockDeg === null ? null : r4(l.hockDeg),
      reach: r4(l.reach),
      maxReach: r4(l.maxReach),
      clamped: l.clamped,
      worldFootX: r4(footWorldX(p, name, n)),
    };
  }
  return {
    frame: n,
    t: r4(p.t),
    supportCount: p.supportCount,
    supportLegs: LEG_NAMES.filter((k) => p.legs[k].support),
    chest: { x: r4(p.chest.x), y: r4(p.chest.y) },
    hip: { x: r4(p.hip.x), y: r4(p.hip.y) },
    head: { dx: r4(p.head.dx), dy: r4(p.head.dy), rotRad: r4(p.head.rot), neckOnChest: rp(p.head.neck), neckOnHead: rp(p.head.neckHeadSide) },
    tail: { base: rp(p.tail.base), tipDisplacement: rp(p.tail.tipDisplacement) },
    legs,
    overextended: LEG_NAMES.filter((k) => p.legs[k].clamped),
  };
}

// ---------- 脚の皮膚（連続変形） ----------

/**
 * 脚の元の絵（rect 内の座標）の関節。元の絵は S字で、骨の向きは目標と違う。
 * zones は関節の前後で骨の重みを smoothstep で混ぜる半幅（元 px）。k は骨の周りの幅の倍率（元→論理px）。
 */
export const LEG_KINDS = {
  fore: { rect: PART_RECTS.foreleg, src: [[128, 30], [150, 155], [88, 275], [82, 337]], zones: [38, 16], k: 0.06 },
  hind: { rect: PART_RECTS.hindleg, src: [[130, 35], [160, 145], [115, 245], [75, 285], [70, 342]], zones: [34, 22, 14], k: 0.06 },
};

/**
 * 皮膚のメッシュ（nx × ny の格子）と、頂点ごとの骨の重み・骨ローカル座標を作る。静止の絵に対して1回だけ。
 * 足裏の骨（最後の骨）は元の向きを鉛直として扱う（足裏を水平に保つため）。
 */
export function buildSkin(kind, nx = 12, ny = 32, k = LEG_KINDS[kind].k) {
  const K = LEG_KINDS[kind];
  const S = K.src;
  const nb = S.length - 1;
  const [, , rw, rh] = K.rect;
  const bones = [];
  for (let i = 0; i < nb; i++) {
    let ex;
    let ey;
    let L;
    if (i === nb - 1) {
      ex = 0;
      ey = 1;
      L = S[nb][1] - S[nb - 1][1];
    } else {
      const dx = S[i + 1][0] - S[i][0];
      const dy = S[i + 1][1] - S[i][1];
      L = Math.hypot(dx, dy);
      ex = dx / L;
      ey = dy / L;
    }
    bones.push({ ox: S[i][0], oy: S[i][1], ex, ey, L });
  }
  const planes = [];
  for (let j = 1; j < nb; j++) {
    const bx = bones[j - 1].ex + bones[j].ex;
    const by = bones[j - 1].ey + bones[j].ey;
    const bl = Math.hypot(bx, by);
    planes.push({ ox: S[j][0], oy: S[j][1], bx: bx / bl, by: by / bl, w: K.zones[j - 1] });
  }
  const count = (nx + 1) * (ny + 1);
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const weight = new Float64Array(count * nb);
  const aLoc = new Float64Array(count * nb);
  const bLoc = new Float64Array(count * nb);
  for (let gy = 0; gy <= ny; gy++) {
    for (let gx = 0; gx <= nx; gx++) {
      const v = gy * (nx + 1) + gx;
      const px = (gx / nx) * rw;
      const py = (gy / ny) * rh;
      sx[v] = px;
      sy[v] = py;
      // h[j] = 骨 j-1 から骨 j へ移る度合い（j=1..nb-1）。w_i = (h_1..h_i の積) * (1 - h_{i+1})
      const h = [1];
      for (let j = 0; j < planes.length; j++) {
        const pl = planes[j];
        h.push(smoothstep(-pl.w, pl.w, (px - pl.ox) * pl.bx + (py - pl.oy) * pl.by));
      }
      h.push(0);
      let prod = 1;
      for (let i = 0; i < nb; i++) {
        prod *= h[i];
        weight[v * nb + i] = prod * (1 - h[i + 1]);
        const b = bones[i];
        aLoc[v * nb + i] = (px - b.ox) * b.ex + (py - b.oy) * b.ey;
        bLoc[v * nb + i] = (px - b.ox) * -b.ey + (py - b.oy) * b.ex;
      }
    }
  }
  return { kind, nx, ny, nb, k, bones, sx, sy, weight, aLoc, bLoc, count };
}

/** 脚の姿勢の関節列から、骨ごとの目標の枠（始点・向き・骨に沿った倍率）を作る。足裏の骨は鉛直（遊脚だけ toe curl） */
export function targetFrames(skin, leg) {
  const J = leg.joints;
  const frames = [];
  for (let i = 0; i < skin.nb; i++) {
    let ex;
    let ey;
    let len;
    if (i === skin.nb - 1) {
      ex = leg.pawDir[0];
      ey = leg.pawDir[1];
      len = ANKLE_H;
    } else {
      const dx = J[i + 1][0] - J[i][0];
      const dy = J[i + 1][1] - J[i][1];
      len = Math.hypot(dx, dy);
      ex = dx / len;
      ey = dy / len;
    }
    frames.push({ tx: J[i][0], ty: J[i][1], ex, ey, along: len / skin.bones[i].L });
  }
  return frames;
}

/** 皮膚の全頂点の目標位置（論理px）。dst に [x0,y0,x1,y1,...] で書く */
export function skinPositions(skin, frames, dst) {
  const { nb, k, count, weight, aLoc, bLoc } = skin;
  for (let v = 0; v < count; v++) {
    let x = 0;
    let y = 0;
    for (let i = 0; i < nb; i++) {
      const w = weight[v * nb + i];
      if (w === 0) continue;
      const f = frames[i];
      const a = aLoc[v * nb + i] * f.along;
      const b = bLoc[v * nb + i] * k;
      x += w * (f.tx + f.ex * a - f.ey * b);
      y += w * (f.ty + f.ey * a + f.ex * b);
    }
    dst[v * 2] = x;
    dst[v * 2 + 1] = y;
  }
  return dst;
}
