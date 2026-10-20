// 全身連動の歩き30姿勢（scripts/fullWalkCore.mjs の純粋計算）の試験。絵の自然さの判断の代わりにはならない
// （足が世界座標で止まる・体と脚の根元が連動する・頭と尾が固定でない・周期が閉じる・皮膚の重みが急に切り替わらない、を数値で確かめるだけ）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as coreModule from '../scripts/fullWalkCore.mjs';

// 型は JS から推論されるため、試験では any として扱う
const c = coreModule as any;
const names: string[] = c.LEG_NAMES;

const flat = (v: unknown, out: number[] = []): number[] => {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => flat(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (k === 'n' || k === 't' ? null : flat(x, out)));
  return out;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test('足: 支持中の足裏は世界座標で止まり、水平に地面へ接する。支持は常に2〜3脚で、遊脚は持ち上がって後ろから前へ戻る', () => {
  for (const name of names) assert.ok(c.stanceDrift(name, 4) < 1e-9, `${name} の支持中の世界xが動いている`);
  const lifted: Record<string, number> = { LF: 0, RF: 0, LH: 0, RH: 0 };
  for (let n = 0; n < c.FRAMES * 2; n++) {
    const p = c.poseAt(n);
    assert.ok(p.supportCount >= 2 && p.supportCount <= 3, `frame ${n} 支持 ${p.supportCount}脚`);
    for (const name of names) {
      const l = p.legs[name];
      const ground: number = c.LEGS[name].ground;
      if (l.support) {
        assert.ok(near(l.sole[1], ground), `${name}@${n} 支持の足裏が地面にない: ${l.sole[1]}`);
        assert.ok(Math.abs(l.pawDir[0]) < 1e-12 && near(l.curlDeg, 0), `${name}@${n} 支持の足裏が水平でない`);
      } else {
        assert.ok(l.sole[1] <= ground + 1e-9, `${name}@${n} 遊脚が地面にめり込む`);
        if (ground - l.sole[1] > 1) lifted[name] = (lifted[name] ?? 0) + 1;
        assert.ok(Math.abs(l.curlDeg) <= c.TOE_CURL_DEG + 1e-9);
      }
    }
  }
  for (const name of names) assert.ok(lifted[name]! > 0, `${name} の遊脚が持ち上がらない`);
  // 遊脚は体に対して前（左）へ戻る: 遊脚の最初と最後で足裏の x は小さくなる
  for (const name of names) {
    const L = c.LEGS[name];
    const swingXs: number[] = [];
    for (let k = 0; k <= 20; k++) {
      const t = L.phase + c.SUPPORT + ((1 - c.SUPPORT) * k) / 20;
      swingXs.push(c.footTarget(name, t).x);
    }
    for (let i = 1; i < swingXs.length; i++) assert.ok(swingXs[i]! <= swingXs[i - 1]! + 1e-9, `${name} 遊脚が前へ単調に戻らない`);
  }
});

test('連動: 前脚の根元は胸、後脚の根元は腰の動きに追従し、胴は胸と腰で位相が違う（全体の上下移動だけではない）。背の高い所ほど遅れが足される', () => {
  for (let n = 0; n < c.FRAMES; n++) {
    const t = n / c.FRAMES;
    const chest = c.chestOffset(t);
    const hip = c.hipOffset(t);
    const p = c.poseAt(n);
    // 胴の変位場（花びらの遅れが入らない最下端）が脚の根元の変位と同じ
    const dChest = c.bodyDisplacement(t, c.CHEST_X0, 54);
    const dHip = c.bodyDisplacement(t, c.HIP_X0, 54);
    assert.ok(near(dChest[0], chest.x) && near(dChest[1], chest.y), `胸 @${n}`);
    assert.ok(near(dHip[0], hip.x) && near(dHip[1], hip.y), `腰 @${n}`);
    for (const name of ['LF', 'RF']) {
      assert.ok(near(p.legs[name].root[0], c.LEGS[name].root[0] + chest.x) && near(p.legs[name].root[1], c.LEGS[name].root[1] + chest.y), `${name} 根元 @${n}`);
    }
    for (const name of ['LH', 'RH']) {
      assert.ok(near(p.legs[name].root[0], c.LEGS[name].root[0] + hip.x) && near(p.legs[name].root[1], c.LEGS[name].root[1] + hip.y), `${name} 根元 @${n}`);
    }
    // RH(x=58)は腰(x=61)の少し手前なので、体の変位場とのずれは胸と腰の差の1割以内
    const dRh = c.bodyDisplacement(t, 58, 54);
    assert.ok(Math.hypot(dRh[0] - hip.x, dRh[1] - hip.y) <= 0.1 * Math.hypot(chest.x - hip.x, chest.y - hip.y) + 1e-9);
  }
  let maxPhaseGap = 0;
  let maxPetal = 0;
  for (let k = 0; k < 120; k++) {
    const t = k / 120;
    const a = c.bodyDisplacement(t, c.CHEST_X0, 53);
    const b = c.bodyDisplacement(t, c.HIP_X0, 53);
    maxPhaseGap = Math.max(maxPhaseGap, Math.abs(a[1] - b[1]));
    const top = c.bodyDisplacement(t, 45, 19);
    const mid = c.bodyDisplacement(t, 45, 54);
    maxPetal = Math.max(maxPetal, Math.abs(top[1] - mid[1]));
  }
  assert.ok(maxPhaseGap > 0.5, `胸と腰の上下の位相差が小さすぎる: ${maxPhaseGap}`);
  assert.ok(maxPetal > 0.15, `背の花びらの遅れが入っていない: ${maxPetal}`);
});

test('頭と尾: 胴に完全固定ではなく、頭は胸より小さく動き、尾は先端ほど遅れて別に動く（固い1枚で一斉に動かない）', () => {
  let headRange = [Infinity, -Infinity];
  let chestRange = [Infinity, -Infinity];
  let rotMax = 0;
  let headVsChest = 0;
  let tipMinusBaseX = [Infinity, -Infinity];
  let tipMinusBaseY = [Infinity, -Infinity];
  for (let k = 0; k < 120; k++) {
    const t = k / 120;
    const h = c.headOffset(t);
    const ch = c.chestOffset(t);
    headRange = [Math.min(headRange[0]!, h.dy), Math.max(headRange[1]!, h.dy)];
    chestRange = [Math.min(chestRange[0]!, ch.y), Math.max(chestRange[1]!, ch.y)];
    rotMax = Math.max(rotMax, Math.abs(h.rot));
    headVsChest = Math.max(headVsChest, Math.abs(h.dy - ch.y));
    const tip = c.tailDisplacement(t, 1);
    const base = c.tailDisplacement(t, 0);
    tipMinusBaseX = [Math.min(tipMinusBaseX[0]!, tip[0] - base[0]), Math.max(tipMinusBaseX[1]!, tip[0] - base[0])];
    tipMinusBaseY = [Math.min(tipMinusBaseY[0]!, tip[1] - base[1]), Math.max(tipMinusBaseY[1]!, tip[1] - base[1])];
    // 根元は腰の動きそのまま（遅れ 0）
    assert.ok(near(base[0], c.hipOffset(t).x) && near(base[1], c.hipOffset(t).y));
  }
  const hr = headRange[1]! - headRange[0]!;
  const cr = chestRange[1]! - chestRange[0]!;
  assert.ok(hr > 0.3 && hr < cr, `頭の上下は胸より小さいが動く: 頭 ${hr} 胸 ${cr}`);
  assert.ok(rotMax > 0.005 && rotMax < 0.05, `首の回転が範囲外: ${rotMax}`);
  assert.ok(headVsChest > 0.1, '頭が胸と同じに動いている（固定）');
  assert.ok(tipMinusBaseX[1]! - tipMinusBaseX[0]! > 0.5 && tipMinusBaseY[1]! - tipMinusBaseY[0]! > 0.3, '尾の先端が根元と同じに動いている（固い1枚）');
  // 先端ほど大きく動く: 1周期で見た根元との差の最大は u=0.5 より u=1 のほうが大きく、u=0（根元）は差が 0
  const maxGap = (u: number) => {
    let m = 0;
    for (let k = 0; k < 240; k++) {
      const a = c.tailDisplacement(k / 240, u);
      const b = c.tailDisplacement(k / 240, 0);
      m = Math.max(m, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    return m;
  };
  assert.equal(maxGap(0), 0);
  assert.ok(maxGap(0.5) > 0.1 && maxGap(1) > maxGap(0.5), `先端ほど動く: u=.5 ${maxGap(0.5)} / u=1 ${maxGap(1)}`);
  // 首の接続点は胸に付いて動くので、頭の側との食い違いは1px未満（首が外れない）
  for (let n = 0; n < c.FRAMES; n++) {
    const h = c.poseAt(n).head;
    assert.ok(Math.hypot(h.neck[0] - h.neckHeadSide[0], h.neck[1] - h.neckHeadSide[1]) < 1, `首の食い違い @${n}`);
  }
});

test('周期: 30姿勢は閉じて（姿勢30=姿勢0）、隣り合う姿勢の間で足裏・体が跳ばない。骨は届く限り設計の長さで、肘は後ろ・膝は前へ折れる', () => {
  const a = flat(c.poseAt(0));
  const b = flat(c.poseAt(c.FRAMES));
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert.ok(near(v, b[i]!, 1e-9), `loop #${i}`));
  for (let n = 0; n < c.FRAMES; n++) {
    const p = c.poseAt(n);
    const q = c.poseAt(n + 1);
    for (const name of names) {
      assert.ok(Math.hypot(p.legs[name].sole[0] - q.legs[name].sole[0], p.legs[name].sole[1] - q.legs[name].sole[1]) < 2, `${name} 足裏が跳ぶ @${n}`);
      assert.ok(Math.hypot(p.legs[name].root[0] - q.legs[name].root[0], p.legs[name].root[1] - q.legs[name].root[1]) < 1, `${name} 根元が跳ぶ @${n}`);
    }
    assert.ok(Math.hypot(p.head.dx - q.head.dx, p.head.dy - q.head.dy) < 1);
  }
  for (let n = 0; n < c.FRAMES; n++) {
    const p = c.poseAt(n);
    assert.ok(c.allFinite(p), `frame ${n} に NaN`);
    for (const name of names) {
      const l = p.legs[name];
      const J: number[][] = l.joints;
      const len = (i: number) => Math.hypot(J[i + 1]![0]! - J[i]![0]!, J[i + 1]![1]! - J[i]![1]!);
      if (!l.clamped) {
        // 骨が届くなら、IK が決める2本は設計の長さ（前=7.4/8.4、後=7/7）
        const [l1, l2] = l.kind === 'fore' ? c.BONES.fore : c.BONES.hind;
        assert.ok(near(len(0), l1, 1e-6), `${name}@${n} 第1骨 ${len(0)}`);
        if (l.kind === 'hind') assert.ok(near(len(1), l2, 1e-6), `${name}@${n} 第2骨 ${len(1)}`);
        if (l.kind === 'fore') assert.ok(near(len(1), l2, 1e-6), `${name}@${n} 第2骨 ${len(1)}`);
      } else {
        // 届かない場合は隠さず、reach と maxReach の差として残る
        assert.ok(l.reach > l.maxReach - 1e-9 || l.reach < 1, `${name}@${n} clamped の根拠が残っていない`);
      }
      // 折れる向き: 前脚の肘は肩→足首の線より後ろ（右）、後脚の膝は股→飛節の線より前（左）
      const root = J[0]!;
      const far = J[2]!;
      const mid = J[1]!;
      const chordX = root[0]! + ((far[0]! - root[0]!) * (mid[1]! - root[1]!)) / (far[1]! - root[1]!);
      if (l.kind === 'fore') assert.ok(mid[0]! > chordX - 1e-9, `${name}@${n} 肘が前へ折れている`);
      else assert.ok(mid[0]! < chordX + 1e-9, `${name}@${n} 膝が後ろへ折れている`);
    }
  }
});

test('皮膚: 骨の重みは各頂点で合計1・0〜1で、隣の頂点へ急に切り替わらない。支持中は足裏の端が地面の近くへ来て、足先は脚の絵の一部として動く', () => {
  for (const kind of ['fore', 'hind']) {
    const skin = c.buildSkin(kind);
    const nb: number = skin.nb;
    for (let v = 0; v < skin.count; v++) {
      let sum = 0;
      for (let i = 0; i < nb; i++) {
        const w = skin.weight[v * nb + i];
        assert.ok(w >= -1e-12 && w <= 1 + 1e-12);
        sum += w;
      }
      assert.ok(near(sum, 1, 1e-9), `${kind} v${v} 重み合計 ${sum}`);
    }
    // 隣り合う頂点の重みの差（急な切替=棒の貼り合わせ、を検出）。また上端は第1骨だけ、下端は足裏の骨だけ
    const stride = skin.nx + 1;
    let maxJump = 0;
    let blended = 0;
    for (let gy = 0; gy <= skin.ny; gy++) {
      for (let gx = 0; gx <= skin.nx; gx++) {
        const v = gy * stride + gx;
        let mixed = 0;
        for (let i = 0; i < nb; i++) if (skin.weight[v * nb + i] > 0.05 && skin.weight[v * nb + i] < 0.95) mixed++;
        if (mixed > 0) blended++;
        for (const u of [gx < skin.nx ? v + 1 : -1, gy < skin.ny ? v + stride : -1]) {
          if (u < 0) continue;
          for (let i = 0; i < nb; i++) maxJump = Math.max(maxJump, Math.abs(skin.weight[v * nb + i] - skin.weight[u * nb + i]));
        }
      }
    }
    assert.ok(maxJump < 0.8, `${kind} 骨の重みが急に切り替わる: ${maxJump}`);
    assert.ok(blended > skin.nx * (nb - 1), `${kind} 関節付近の混ぜが少なすぎる: ${blended}`);
    assert.ok(near(skin.weight[0 * nb + 0], 1, 1e-9), `${kind} 上端（左上の頂点）は第1骨だけ`);
    // 足裏の真下の頂点（足裏の元座標から横 40px 以内の最下段）は足裏の骨だけ
    const soleSrc: number[] = c.LEG_KINDS[kind].src[nb]!;
    const pawCols: number[] = [];
    for (let gx = 0; gx <= skin.nx; gx++) if (Math.abs(skin.sx[skin.ny * stride + gx] - soleSrc[0]!) < 40) pawCols.push(gx);
    assert.ok(pawCols.length >= 2, `${kind} 足裏の下の頂点が足りない`);
    for (const gx of pawCols) assert.ok(near(skin.weight[(skin.ny * stride + gx) * nb + (nb - 1)], 1, 1e-9), `${kind} 足裏の下は足裏の骨だけ gx=${gx}`);
    // 支持中: 足裏の真下の最下段（元の絵の下端は足裏の点より少し下）が接地線の近く。遊脚は接地線より上
    const buf = new Float64Array(skin.count * 2);
    for (let n = 0; n < c.FRAMES; n++) {
      for (const name of names) {
        const l = c.poseAt(n).legs[name];
        if (l.kind !== kind) continue;
        c.skinPositions(skin, c.targetFrames(skin, l), buf);
        let maxY = -Infinity;
        for (const gx of pawCols) maxY = Math.max(maxY, buf[(skin.ny * stride + gx) * 2 + 1]!);
        assert.ok(Number.isFinite(maxY));
        if (l.support) assert.ok(Math.abs(maxY - c.LEGS[name].ground) < 0.5, `${name}@${n} 足裏の下端 ${maxY} / 地面 ${c.LEGS[name].ground}`);
        else assert.ok(maxY <= c.LEGS[name].ground + 0.5);
      }
    }
  }
});

test('移行(settle/start): 胴・頭・尾と全足の x は t0 のまま、浮いた左前足だけが少しずつ下がる/上がる。端は idle と歩行の0番に一致し、瞬間移動しない', () => {
  const N: number = c.TRANSITION_FRAMES;
  assert.equal(N, 6);
  const t0 = c.poseAt(0);
  const idle = c.idlePose();
  const settle = Array.from({ length: N }, (_, i) => c.poseAt(0, { liftScale: 1 - (i + 1) / N }));
  const start = Array.from({ length: N }, (_, i) => c.poseAt(0, { liftScale: (i + 1) / N }));
  assert.deepEqual(flat(settle[N - 1]!.legs), flat(idle.legs), 'settle の最後は idle');
  assert.deepEqual(flat(start[N - 1]!.legs), flat(t0.legs), 'start の最後は歩行の0番');
  const gaps = (list: any[]) => list.map((p) => c.LEGS.LF.ground - p.legs.LF.sole[1]);
  const g0 = c.LEGS.LF.ground - t0.legs.LF.sole[1];
  const gs = gaps(settle);
  assert.ok(g0 > 0.5, 't0 で左前足は浮いている');
  for (let i = 0; i < N; i++) assert.ok(gs[i]! < (i === 0 ? g0 : gs[i - 1]!) - 1e-9 || gs[i]! < 1e-9, `settle#${i} が下がらない`);
  assert.ok(near(gs[N - 1]!, 0, 1e-9));
  const gt = gaps(start);
  for (let i = 1; i < N; i++) assert.ok(gt[i]! > gt[i - 1]! - 1e-9, `start#${i} が上がらない`);
  assert.ok(near(gt[N - 1]!, g0, 1e-9));
  for (const p of [...settle, ...start]) {
    assert.deepEqual(flat([p.chest, p.hip, p.head, p.tail]), flat([t0.chest, t0.hip, t0.head, t0.tail]));
    for (const name of names) {
      assert.ok(near(p.legs[name].ankle[0], t0.legs[name].ankle[0]), `${name} の足の x が動いた`);
      if (name !== 'LF') assert.deepEqual(p.legs[name].sole, t0.legs[name].sole);
    }
    assert.ok(c.allFinite(p));
  }
});

test('休止(idle):t0 の胴・頭・尾・足の x のまま、浮いた足だけが同じ x で接地する4脚立ち', () => {
  const t0 = c.poseAt(0);
  const idle = c.idlePose();
  assert.deepEqual(flat([idle.chest, idle.hip, idle.head, idle.tail]), flat([t0.chest, t0.hip, t0.head, t0.tail]));
  let lifted = 0;
  for (const name of names) {
    // 足首の x が同じ（遊脚の toe curl で足裏の点が .2px ずれるぶんは idle では無い）
    assert.ok(near(idle.legs[name].ankle[0], t0.legs[name].ankle[0]), `${name} の x が変わっている`);
    assert.ok(near(idle.legs[name].sole[1], c.LEGS[name].ground), `${name} が接地していない`);
    if (!t0.legs[name].support) lifted++;
  }
  assert.equal(lifted, 1, 't0 で浮いているのは1本だけ（左前足）');
  assert.equal(t0.legs.LF.support, false);
});
