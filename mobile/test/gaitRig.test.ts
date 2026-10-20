import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GAIT_DESIGN, LEGS, type Leg } from '../src/ui/gaitDesign.ts';
import {
  BONES, RIG_ATLAS, RIG_BODY, RIG_FRAMES, RIG_JOINTS, RIG_LIFT_PX, RIG_PARTS, RIG_STRIDE_PX, drawList, footWorldX, isFore, legRel, restRigPose, rigPoseAt, segItem,
  type LegPose, type RigPose,
} from '../src/ui/gaitRig.ts';

const json = JSON.parse(readFileSync(new URL('../../design-assets/motion-v3/rig-parts.json', import.meta.url), 'utf8'));
const poses = (n: number): RigPose[] => Array.from({ length: n }, (_, i) => rigPoseAt(i));
const cross = (a: [number, number], b: [number, number]) => a[0] * b[1] - a[1] * b[0];
const vec = (a: { x: number; y: number }, b: { x: number; y: number }): [number, number] => [b.x - a.x, b.y - a.y];

test('定数は rig-parts.json と一致（パーツ矩形・関節の根元・接地線・足中心）', () => {
  assert.equal(RIG_ATLAS.width, json.width);
  assert.equal(RIG_ATLAS.height, json.height);
  assert.deepEqual([...RIG_PARTS.body.rect], json.body.rect);
  assert.equal(RIG_BODY.logicalWidth, json.body.logicalWidth);
  assert.deepEqual([...RIG_BODY.origin], json.bodyOrigin);
  for (const k of ['foreUpper', 'foreLower', 'forePaw', 'hindUpper', 'hindShin', 'hindHock', 'hindPaw'] as const) {
    const p = RIG_PARTS[k] as Record<string, unknown>;
    const j = json.parts[k];
    assert.deepEqual([...(p.rect as number[])], j.rect, k);
    for (const f of ['start', 'end', 'sole'] as const) if (f in j) assert.deepEqual([...(p[f] as number[])], j[f], `${k}.${f}`);
    if ('logicalWidth' in j) assert.equal(p.logicalWidth, j.logicalWidth, k);
  }
  for (const leg of LEGS) {
    assert.deepEqual([...RIG_JOINTS[leg].root], json.joints[leg].root, leg);
    assert.equal(RIG_JOINTS[leg].groundY, json.joints[leg].groundY, leg);
    assert.equal(RIG_JOINTS[leg].footCenterX, json.joints[leg].footCenterX, leg);
  }
});

test('30姿勢で周期が閉じる。常に2〜3脚が支持し、接地は LH→LF→RH→RF の順', () => {
  assert.equal(RIG_FRAMES, 30);
  assert.deepEqual(rigPoseAt(30), rigPoseAt(0));
  assert.deepEqual(rigPoseAt(-1), rigPoseAt(29));
  poses(RIG_FRAMES).forEach((p, i) => {
    const n = LEGS.filter((l) => p.legs[l].support).length;
    assert.ok(n >= 2 && n <= 3, `姿勢${i} 支持${n}脚`);
  });
  // 各脚の接地（支持の頭）の姿勢番号が 7.5姿勢ずつずれ、順番どおり
  const td = (leg: Leg) => poses(RIG_FRAMES * 2).findIndex((p, i) => i >= 1 && p.legs[leg].support && !rigPoseAt(i - 1).legs[leg].support);
  const order = [...LEGS].sort((a, b) => ((td(a) - td('LH') + 30) % 30) - ((td(b) - td('LH') + 30) % 30));
  assert.deepEqual(order, ['LH', 'LF', 'RH', 'RF']);
});

const SUPPORT_SPAN = RIG_STRIDE_PX * (GAIT_DESIGN.supportPct / 100);

test('支持中の足は体に対して一定速度で右へ STRIDE*支持率 動き、世界座標では動かない（連続する接地区間で1px未満）。足底は接地線', () => {
  const n = RIG_FRAMES * 3;
  for (const leg of LEGS) {
    const J = RIG_JOINTS[leg];
    let run: { n: number; x: number; raw: number }[] = [];
    const flush = () => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const xs = run.map((r) => r.x);
      assert.ok(Math.max(...xs) - Math.min(...xs) < 1, `${leg} 接地中に滑る ${Math.max(...xs) - Math.min(...xs)}`);
      // 丸める前は一定速度（1姿勢あたり 20/30 px）
      for (let i = 1; i < run.length; i++) assert.ok(Math.abs(run[i]!.raw - run[i - 1]!.raw - RIG_STRIDE_PX / RIG_FRAMES) < 1e-9, `${leg} 速度`);
      run = [];
    };
    for (let i = 0; i < n; i++) {
      const lp = rigPoseAt(i).legs[leg];
      if (lp.support) {
        assert.equal(lp.foot.y, Math.round(J.groundY), `${leg} 足底が接地線から離れた`);
        run.push({ n: i, x: footWorldX(lp, i), raw: lp.footRaw.x });
      } else flush();
    }
    flush();
    // 支持区間の長さ = STRIDE * .65（接地時から支持終わりまで。stride16なら10.4px）
    const ps = poses(RIG_FRAMES).map((p) => p.legs[leg]);
    const sup = ps.filter((l) => l.support).map((l) => l.footRaw.x);
    const w = Math.max(...sup) - Math.min(...sup);
    assert.ok(w <= SUPPORT_SPAN + 1e-9 && w > SUPPORT_SPAN - (2 * RIG_STRIDE_PX) / RIG_FRAMES, `${leg} 支持幅 ${w}`);
  }
});

test('遊脚は足先を持ち上げて前（左）へ返し、次の接地位置へ着く', () => {
  for (const leg of LEGS) {
    const J = RIG_JOINTS[leg];
    const ps = poses(RIG_FRAMES).map((p) => p.legs[leg]);
    const sw = ps.filter((l) => !l.support);
    assert.ok(sw.length >= 10 && sw.length <= 11, `${leg} 遊脚の姿勢数 ${sw.length}`);
    const lift = Math.max(...sw.map((l) => Math.round(J.groundY) - l.foot.y));
    assert.ok(lift >= RIG_LIFT_PX - 1 && lift <= RIG_LIFT_PX, `${leg} 持ち上げ ${lift}`);
    // 遊脚は周期境界をまたぐことがある（LF等）ので、姿勢番号順ではなく接地からの位相（legRel）順に並べて確かめる
    const xs = ps
      .map((l, i) => ({ l, rel: legRel(leg, i / RIG_FRAMES) }))
      .filter((r) => !r.l.support)
      .sort((a, b) => a.rel - b.rel)
      .map((r) => r.l.footRaw.x);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! < xs[i - 1]!, `${leg} 遊脚は前へ`);
  }
});

test('IK: 有限・骨長どおり・過伸展なし。前肘は後ろ、後膝は前、飛節は後ろ（膝と飛節が逆向きに曲がる）', () => {
  const all = [...poses(RIG_FRAMES), restRigPose()];
  for (const p of all) {
    for (const leg of LEGS) {
      const lp: LegPose = p.legs[leg];
      assert.equal(lp.clamped, false, `${leg} 届かない/伸びきり`);
      for (const j of lp.joints) assert.ok(Number.isFinite(j.x) && Number.isFinite(j.y), `${leg} NaN`);
      const len = (i: number) => Math.hypot(lp.joints[i + 1]!.x - lp.joints[i]!.x, lp.joints[i + 1]!.y - lp.joints[i]!.y);
      if (isFore(leg)) {
        assert.ok(Math.abs(len(0) - BONES.fore[0]) < 1e-6 && Math.abs(len(1) - BONES.fore[1]) < 1e-6, `${leg} 骨長`);
        const [s, e, a] = lp.joints as [LegPose['foot'], LegPose['foot'], LegPose['foot']];
        assert.ok(cross(vec(s, e), vec(e, a)) > 0, `${leg} 肘が後ろへ折れていない`);
      } else {
        assert.ok(Math.abs(len(0) - BONES.hind[0]) < 1e-6 && Math.abs(len(1) - BONES.hind[1]) < 1e-6 && Math.abs(len(2) - BONES.hind[2]) < 1e-6, `${leg} 骨長`);
        const [h, k, c, a] = lp.joints as [LegPose['foot'], LegPose['foot'], LegPose['foot'], LegPose['foot']];
        assert.ok(cross(vec(h, k), vec(k, c)) < 0, `${leg} 膝が前へ折れていない`);
        assert.ok(cross(vec(k, c), vec(c, a)) > 0, `${leg} 飛節が後ろへ折れていない`);
        assert.ok(k.x < h.x && c.x > a.x, `${leg} 膝は前・飛節は足首より後ろ`);
      }
    }
  }
});

test('手前と奥、前脚と後脚の足が接触しつつ前後にすれ違う（順が入れ替わる）。前と後ろを同じ関節構造で代用しない', () => {
  const gap = (a: Leg, b: Leg) => poses(RIG_FRAMES).map((p) => p.legs[a].foot.x - p.legs[b].foot.x);
  for (const [a, b] of [['LF', 'RF'], ['LH', 'RH']] as const) {
    const g = gap(a, b);
    assert.ok(g.some((v) => v < 0) && g.some((v) => v > 0), `${a}/${b} が入れ替わらない`);
    assert.ok(Math.min(...g.map(Math.abs)) <= 3, `${a}/${b} が接触しないほど離れる`);
  }
  assert.equal(rigPoseAt(0).legs.LF.joints.length, 3);
  assert.equal(rigPoseAt(0).legs.LH.joints.length, 4);
});

test('描画リスト: 奥の2脚→胴→手前の2脚。脚ごとに骨（下→上）の後に足先が最後。各骨は start→end が関節 from→to へ一致（一様拡縮＋回転）。足先は回転せず足裏が足位置', () => {
  const pose = rigPoseAt(11);
  const items = drawList(pose);
  assert.equal(items.length, 15);
  const bodyAt = items.findIndex((i) => i.part === 'body');
  assert.equal(bodyAt, 7);
  // 奥: RH(後ろ4枚: 飛節,脛,もも,足先) → RF(前3枚: 前腕,上腕,足先)、胴、手前: LH → LF。足先は各脚の最後
  assert.deepEqual(items.map((i) => i.part), [
    'hindHock', 'hindShin', 'hindUpper', 'hindPaw',
    'foreLower', 'foreUpper', 'forePaw',
    'body',
    'hindHock', 'hindShin', 'hindUpper', 'hindPaw',
    'foreLower', 'foreUpper', 'forePaw',
  ]);
  assert.deepEqual(items[3]!.pivot, [pose.legs.RH.foot.x, pose.legs.RH.foot.y]);
  assert.deepEqual(items[6]!.pivot, [pose.legs.RF.foot.x, pose.legs.RF.foot.y]);
  assert.deepEqual(items[11]!.pivot, [pose.legs.LH.foot.x, pose.legs.LH.foot.y]);
  assert.deepEqual(items[14]!.pivot, [pose.legs.LF.foot.x, pose.legs.LF.foot.y]);
  const farParts = items.slice(0, bodyAt).map((i) => i.part);
  assert.equal(farParts.filter((p) => p === 'forePaw').length, 1);
  assert.equal(farParts.filter((p) => p === 'hindPaw').length, 1);
  for (const leg of LEGS) {
    const lp = pose.legs[leg];
    for (const s of lp.segs) {
      const it = segItem(s);
      const p = RIG_PARTS[s.part as 'foreUpper'];
      const dx = p.end[0] - p.start[0];
      const dy = p.end[1] - p.start[1];
      const ex = it.pivot[0] + it.scale * (dx * Math.cos(it.rot) - dy * Math.sin(it.rot));
      const ey = it.pivot[1] + it.scale * (dx * Math.sin(it.rot) + dy * Math.cos(it.rot));
      assert.ok(Math.abs(ex - s.to.x) < 1e-9 && Math.abs(ey - s.to.y) < 1e-9, `${leg}:${s.part} 終点が関節に届かない`);
      assert.deepEqual(it.pivot, [s.from.x, s.from.y]);
      assert.ok(it.scale > 0 && Number.isFinite(it.rot));
    }
    const paw = items.find((i) => i.part === (isFore(leg) ? 'forePaw' : 'hindPaw') && i.pivot[0] === lp.foot.x && i.pivot[1] === lp.foot.y);
    assert.ok(paw, `${leg} 足先`);
    assert.equal(paw.rot, 0);
  }
  const body = items[bodyAt]!;
  assert.deepEqual(body.pivot, [...RIG_BODY.origin]);
  assert.ok(Math.abs(body.scale * RIG_PARTS.body.rect[2] - RIG_BODY.logicalWidth) < 1e-9);
});

test('休憩の立ち姿は歩行と同じパーツ構成で、4足が接地線の足中心に立つ', () => {
  const r = restRigPose();
  for (const leg of LEGS) {
    assert.equal(r.legs[leg].support, true);
    assert.equal(r.legs[leg].foot.x, RIG_JOINTS[leg].footCenterX);
    assert.equal(r.legs[leg].foot.y, Math.round(RIG_JOINTS[leg].groundY));
  }
  assert.deepEqual(drawList(r).map((i) => i.part), drawList(rigPoseAt(0)).map((i) => i.part));
});
