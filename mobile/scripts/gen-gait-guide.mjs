// 歩行の骨格ガイド（public/motion-study/gait-guide.svg）の生成。親が `node scripts/gen-gait-guide.mjs` で実行する。
// 同梱のSVGは同じ式を手計算した値。このスクリプトは足先位置を2関節IKで計算して書き直す（構成は同じ）。
// 設計図であり、最終キャラの絵・解剖図・生体測定ではない。外部依存なし。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/motion-study/gait-guide.svg', import.meta.url));

// 横向き左。座標はセル(384x256)内。近い側(LH/LF)を基準に、遠い側は (+7,-5) ずらす
const GROUND = 212;
const SHOULDER = [126, 114];
const HIP = [258, 114];
const FAR = [7, -5];
const STRIDE = 60; // 1周期の歩幅（20論理px × 3）
const SUPPORT = 0.65;
const SWEEP = STRIDE * SUPPORT; // 支持中に足が体に対して後方へ動く量
const LIFT = 26;
const N = 8;
const FRONT = { a: 40, paw: [0, 24], pawSwing: [8, 22.6], bend: +1 }; // 肘は後ろ(+x)へ。paw は 手根→足 のベクトルで carpus = foot - paw（運び中は足が手根の後ろへ垂れる）
const HIND = { a: 44, hock: [6, -29.4], hockSwing: [12, -27.5], bend: -1 }; // 膝は前(-x)へ
const COLORS = { LH: '#F29A2E', LF: '#E8604C', RH: '#7A4FC4', RF: '#3B7DD8' };
const TOUCHDOWN = { LH: 0, LF: 2, RH: 4, RF: 6 }; // 8分割での接地姿勢（0,25,50,75%）

/** k番目(周期 k/8)の足先の、関節x基準のオフセットと高さ。支持は一定速度で後方、運びは弧 */
function footAt(k) {
  const c = k / N;
  if (c < SUPPORT) return { dx: -SWEEP / 2 + (SWEEP * c) / SUPPORT, lift: 0, swing: false };
  const u = (c - SUPPORT) / (1 - SUPPORT);
  return { dx: (SWEEP / 2) * Math.cos(Math.PI * u), lift: LIFT * Math.sin(Math.PI * u), swing: true };
}

/** 等しい2骨(長さa)で root→target を結ぶ中間関節。bend=+1 は +x 側、-1 は -x 側へ折れる */
function twoBone(root, target, a, bend) {
  const vx = target[0] - root[0];
  const vy = target[1] - root[1];
  const d = Math.hypot(vx, vy);
  const h = Math.sqrt(Math.max(0, a * a - (d / 2) ** 2));
  const ux = vx / d;
  const uy = vy / d;
  const nx = bend > 0 ? uy : -uy;
  const ny = bend > 0 ? -ux : ux;
  return [(root[0] + target[0]) / 2 + h * nx, (root[1] + target[1]) / 2 + h * ny];
}

const r1 = (v) => Math.round(v * 10) / 10;
const pt = (p) => `${r1(p[0])},${r1(p[1])}`;

function leg(front, k) {
  const root = front ? SHOULDER : HIP;
  const f = footAt(k);
  const foot = [root[0] + f.dx, GROUND - f.lift];
  const cfg = front ? FRONT : HIND;
  const off = front ? (f.swing ? cfg.pawSwing : cfg.paw) : f.swing ? cfg.hockSwing : cfg.hock;
  // 前脚: 手根 = 足 - paw（pawは手根→足のベクトル）。後脚: 飛節 = 足 + hock
  const mid2 = front ? [foot[0] - off[0], foot[1] - off[1]] : [foot[0] + off[0], foot[1] + off[1]];
  const mid1 = twoBone(root, mid2, cfg.a, cfg.bend);
  const style = 'fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"';
  return (
    `<g id="${front ? 'ff' : 'hh'}${k}" ${style}><polyline points="${pt(root)} ${pt(mid1)} ${pt(mid2)} ${pt(foot)}"/>` +
    `<circle cx="${r1(mid1[0])}" cy="${r1(mid1[1])}" r="4" fill="#fff" stroke-width="2.5"/>` +
    `<circle cx="${r1(mid2[0])}" cy="${r1(mid2[1])}" r="4" fill="#fff" stroke-width="2.5"/>` +
    `<ellipse cx="${r1(foot[0] - 3)}" cy="${r1(foot[1] - 2)}" rx="8" ry="4" fill="currentColor" stroke="none"/></g>`
  );
}

const defsLegs = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => '    ' + leg(true, k)).join('\n') + '\n' + [0, 1, 2, 3, 4, 5, 6, 7].map((k) => '    ' + leg(false, k)).join('\n');

const cellBg = `<g id="cellBg">
      <rect x="1" y="1" width="382" height="254" fill="#FFFDF8" stroke="#D9CBBE" stroke-width="2"/>
      <line x1="20" y1="${GROUND}" x2="364" y2="${GROUND}" stroke="#8B6F5A" stroke-width="2"/>
      <line x1="27" y1="${GROUND + FAR[1]}" x2="371" y2="${GROUND + FAR[1]}" stroke="#B9A99A" stroke-width="1" stroke-dasharray="4 3"/>
      <line x1="${SHOULDER[0]}" y1="118" x2="${SHOULDER[0]}" y2="${GROUND}" stroke="#B9A99A" stroke-width="1" stroke-dasharray="3 4"/>
      <line x1="${HIP[0]}" y1="118" x2="${HIP[0]}" y2="${GROUND}" stroke="#B9A99A" stroke-width="1" stroke-dasharray="3 4"/>
      <text x="14" y="246" font-size="10" fill="#8B6F5A">← 進行方向（左向き）　設計図です。解剖図・測定結果ではありません</text>
    </g>`;
const body = `<g id="body">
      <ellipse cx="192" cy="104" rx="92" ry="34" fill="#F3D9C4" fill-opacity="0.45" stroke="#C9A98F" stroke-width="2"/>
      <ellipse cx="84" cy="94" rx="40" ry="30" fill="#F3D9C4" fill-opacity="0.55" stroke="#C9A98F" stroke-width="2"/>
      <ellipse cx="68" cy="68" rx="9" ry="12" fill="#F3D9C4" fill-opacity="0.55" stroke="#C9A98F" stroke-width="2"/>
      <circle cx="68" cy="92" r="3" fill="#8B6F5A"/>
      <path d="M282,96 C310,78 322,60 316,44" fill="none" stroke="#C9A98F" stroke-width="5" stroke-linecap="round"/>
      <circle cx="${SHOULDER[0] + FAR[0]}" cy="${SHOULDER[1] + FAR[1]}" r="5" fill="#fff" stroke="#8B6F5A" stroke-width="2"/>
      <circle cx="${HIP[0] + FAR[0]}" cy="${HIP[1] + FAR[1]}" r="5" fill="#fff" stroke="#8B6F5A" stroke-width="2"/>
      <circle cx="${SHOULDER[0]}" cy="${SHOULDER[1]}" r="5" fill="#8B6F5A"/>
      <circle cx="${HIP[0]}" cy="${HIP[1]}" r="5" fill="#8B6F5A"/>
    </g>`;
const legend = `<g id="legend" font-size="12" fill="#3A2E26">
      ${['LH', 'LF', 'RH', 'RF'].map((l, i) => `<rect x="${196 + 44 * i}" y="12" width="10" height="10" fill="${COLORS[l]}"/><text x="${210 + 44 * i}" y="22">${l}</text>`).join('\n      ')}
      <text x="196" y="38" font-size="10" fill="#8B6F5A">近い側=LH・LF　遠い側=RH・RF</text>
    </g>`;

// 姿勢 p での各脚の k（接地姿勢から数えた位置）
const kOf = (leg, p) => (((p - TOUCHDOWN[leg]) % N) + N) % N;
const cells = [];
for (let p = 0; p < N; p++) {
  const ox = (p % 4) * 384;
  const oy = Math.floor(p / 4) * 256;
  const swingLeg = ['LH', 'LF', 'RH', 'RF'].find((l) => footAt(kOf(l, p)).swing);
  const td = ['LH', 'LF', 'RH', 'RF'].find((l) => kOf(l, p) === 0);
  const no = String(p + 1).padStart(2, '0');
  cells.push(`  <!-- ${no} -->
  <g transform="translate(${ox},${oy})">
    <use xlink:href="#cellBg"/>
    <use xlink:href="#hh${kOf('RH', p)}" transform="translate(${FAR[0]},${FAR[1]})" color="${COLORS.RH}"/>
    <use xlink:href="#ff${kOf('RF', p)}" transform="translate(${FAR[0]},${FAR[1]})" color="${COLORS.RF}"/>
    <use xlink:href="#body"/>
    <use xlink:href="#hh${kOf('LH', p)}" color="${COLORS.LH}"/>
    <use xlink:href="#ff${kOf('LF', p)}" color="${COLORS.LF}"/>
    <use xlink:href="#legend"/>
    <text x="14" y="34" font-size="28" font-weight="700" fill="#3A2E26">${no}</text>
    <text x="14" y="54" font-size="12" fill="#3A2E26">周期${(p * 12.5).toString().replace(/\.0$/, '')}%　運び: ${swingLeg}</text>${td ? `\n    <text x="14" y="70" font-size="12" fill="#3A2E26">接地: ${td}</text>` : ''}
  </g>`);
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 歩行の骨格ガイド（画像生成への設計資料）。最終キャラの絵でも、解剖図・生体測定の結果でもない。
     scripts/gen-gait-guide.mjs が生成（2関節IK）。向き: 左向き。近い側=LH/LF=暖色、遠い側=RH/RF=寒色。
     接地位相 LH 0% / LF 25% / RH 50% / RF 75%、支持65%・運び35%。 -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1536" height="512" viewBox="0 0 1536 512" font-family="'Noto Sans JP','Meiryo',sans-serif">
  <title>歩行の骨格ガイド 8主要姿勢（設計図）</title>
  <desc>横向き左の単純な四足骨格。LH/LF=近い側(橙/珊瑚)、RH/RF=遠い側(紫/青)。接地 LH0% LF25% RH50% RF75%、支持65%・運び35%。設計図であり、解剖図や測定結果ではありません。</desc>
  <defs>
${defsLegs}
    ${cellBg}
    ${body}
    ${legend}
  </defs>

${cells.join('\n')}
</svg>
`;

writeFileSync(OUT, svg);
console.log(`wrote ${OUT}`);
