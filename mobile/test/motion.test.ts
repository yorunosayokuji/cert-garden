import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MemoryKv } from '../src/state/kv.ts';
import { DEFAULT_ROOM, RoomStore, ROOM_KEY } from '../src/state/room.ts';
import {
  BLINK_MS, HOLD_MS, MOVE_MS, SLEEP_HOLD_MS, SequencePlayer, clipFrames, commonScale, makeRng, planCycle, reactionKindOf, reactionSteps, type Step,
} from '../src/ui/motionSeq.ts';

const manifest = JSON.parse(readFileSync(new URL('../../design-assets/motion-v2/manifest.json', import.meta.url), 'utf8'));
const IDS = ['cream', 'lavender', 'apricot'] as const;

test('連番: 全周期でコマは0–11、動作は120–180ms(まばたき80–120ms)、静止3–6秒、眠りの保持4–7秒', () => {
  for (const id of IDS) {
    const r = makeRng(7);
    for (let n = 0; n < 24; n++) {
      const steps = planCycle(id, n, r);
      steps.forEach((s) => assert.ok(Number.isInteger(s.frame) && s.frame >= 0 && s.frame <= 11));
      const last = steps[steps.length - 1]!;
      assert.equal(last.frame, 0, '周期の最後は休み姿勢');
      assert.ok(last.ms >= HOLD_MS[0] && last.ms <= HOLD_MS[1]);
      const holds = steps.slice(0, -1).filter((s) => s.ms > MOVE_MS[1]);
      holds.forEach((s) => assert.ok(s.ms >= SLEEP_HOLD_MS[0] && s.ms <= SLEEP_HOLD_MS[1]));
      steps.slice(0, -1).filter((s) => s.ms <= MOVE_MS[1]).forEach((s) => assert.ok(s.ms >= BLINK_MS[0]));
    }
  }
});

test('連番: 指定の並び（紫の耳0,1,2,1,3 / 杏のび4,5,6,5,7 / 眠りは隣接姿勢を通る）', () => {
  assert.deepEqual(clipFrames('lavender', 'flutter').slice(0, 4), [1, 2, 1, 3]);
  assert.deepEqual(clipFrames('apricot', 'stretch').slice(0, 5), [4, 5, 6, 5, 7]);
  assert.deepEqual(clipFrames('cream', 'sleepBack'), [4, 5, 6, 7, 6, 5, 4, 0]);
  assert.deepEqual(clipFrames('cream', 'sleepYawn').slice(-5), [8, 9, 10, 11, 0]);
  assert.deepEqual(clipFrames('lavender', 'sleepBack'), [8, 9, 10, 9, 8, 11, 0]);
  assert.deepEqual(clipFrames('apricot', 'sleepBack'), [8, 9, 10, 11, 10, 9, 8, 0]);
  // どの動作も休み姿勢(0)から出て0へ戻る
  for (const id of IDS) for (const c of ['sleepBack', 'blink', 'wave', 'flutter', 'stretch', 'sleepYawn'] as const) {
    const f = clipFrames(id, c);
    if (f.length) assert.equal(f[f.length - 1], 0, `${id}/${c}`);
  }
});

test('拡大率: 全コマ共通で 表示最大幅/referenceWidth。コマごとに正規化しない', () => {
  for (const id of IDS) {
    const a = manifest.atlases[id];
    assert.equal(a.frames.length, 12);
    const s = commonScale(a, 100);
    assert.equal(s, 100 / a.referenceWidth);
    const widths = a.frames.map((f: { rect: number[] }) => f.rect[2]! * s);
    assert.ok(Math.max(...widths) <= 100 + 1e-9);
    assert.ok(new Set(widths.map((w: number) => Math.round(w))).size > 1, 'コマ幅は不均一のまま');
    // 高さ制限をかけても拡大率は1つ
    const tall = Math.max(...a.frames.map((f: { rect: number[] }) => f.rect[3]!));
    assert.equal(commonScale(a, 100, 20), 20 / tall);
    // 足元は rect の下端、横は中央（切り抜きの anchor）
    a.frames.forEach((f: { rect: number[]; anchor: number[] }) => assert.ok(f.anchor[1] === f.rect[3] && Math.abs(f.anchor[0]! - f.rect[2]! / 2) < 1));
  }
});

function harness() {
  const frames: number[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const schedule = (fn: () => void, ms: number) => { timers.set(++id, { fn, ms }); return id; };
  const cancel = (h: unknown) => { timers.delete(h as number); };
  const fire = () => { const [k, t] = [...timers.entries()][0]!; timers.delete(k); t.fn(); };
  return { frames, timers, schedule, cancel, fire };
}

test('再生器: stop()でタイマーが残らずコマも出ない（非表示・reduceMotion切替で即停止）', () => {
  const h = harness();
  const p = new SequencePlayer('lavender', 1, makeRng(3), (f) => h.frames.push(f), h.schedule, h.cancel);
  p.start();
  for (let i = 0; i < 6; i++) h.fire();
  assert.equal(h.timers.size, 1);
  p.stop();
  assert.equal(h.timers.size, 0);
  const n = h.frames.length;
  p.inject([{ frame: 5, ms: 100 }]);
  assert.equal(h.frames.length, n);
  assert.equal(h.timers.size, 0);
});

test('再生器: 反応は一度だけ再生して通常の周期へ戻る。3体の開始位相はずれる', () => {
  const h = harness();
  const p = new SequencePlayer('apricot', 2, makeRng(5), (f) => h.frames.push(f), h.schedule, h.cancel);
  p.start();
  const react: Step[] = reactionSteps('apricot', 'welcome', makeRng(1));
  p.inject(react);
  assert.equal(h.frames[h.frames.length - 1], react[0]!.frame);
  for (let i = 1; i < react.length; i++) h.fire();
  assert.equal(h.frames[h.frames.length - 1], react[react.length - 1]!.frame);
  assert.equal(h.timers.size, 1);
  const delays = [0, 1, 2].map((k) => { const hh = harness(); new SequencePlayer('cream', k, makeRng(9), () => undefined, hh.schedule, hh.cancel).start(); return [...hh.timers.values()][0]!.ms; });
  assert.equal(new Set(delays).size, 3);
});

test('反応: 正答確定=歓迎、誤答/不明=落ち着き、選択だけ(idle)では反応しない', () => {
  assert.equal(reactionKindOf('cheer'), 'welcome');
  assert.equal(reactionKindOf('celebrate'), 'welcome');
  assert.equal(reactionKindOf('encourage'), 'calm');
  assert.equal(reactionKindOf('idle'), null);
  for (const id of IDS) for (const k of ['welcome', 'calm'] as const) {
    const s = reactionSteps(id, k, makeRng(2));
    assert.ok(s.length >= 3 && s.every((x) => x.frame >= 0 && x.frame <= 11));
  }
});

test('背景の選択: 保存でき、壊れた値や未保存は初期の部屋(採用C)に戻る', async () => {
  const kv = new MemoryKv();
  const store = new RoomStore(kv);
  assert.equal(await store.load(), DEFAULT_ROOM);
  await store.save('night');
  assert.equal(await new RoomStore(kv).load(), 'night');
  await kv.setItem(ROOM_KEY, '{"room":"zzz"}');
  assert.equal(await store.load(), DEFAULT_ROOM);
  await kv.setItem(ROOM_KEY, 'not json');
  assert.equal(await store.load(), DEFAULT_ROOM);
});
