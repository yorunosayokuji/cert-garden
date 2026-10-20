import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card } from './common';
import { useAppActive } from './hooks';
import { LabSprite } from './LabSprite';
import {
  MOTION_LABELS, MOTION_ORDER, WALK, advance, buildTrack, compareBounds, fitFrame0Height, frameAt, inPlaceFrame, initialClock, nextBoundary,
  prevBoundary, restartClock, scaleFromFrame0, seekClock, setSpeed, stageHeightFor, togglePlay, walkAt, walkStepTime, type Clock, type LabMotion, type Speed,
} from './motionLab.ts';
import { GARDEN_PLACEMENTS, ROOMS } from './motionAssets';
import { LAB_ATLAS, LAB_IMAGES } from './motionLabAssets';
import { MotionSprite } from './MotionSprite';
import { MotionStudy } from './MotionStudy.tsx';
import { useReduceMotion } from './motion';
import { C, T } from './theme';

/** v3 = 新しく描いた動き（MotionStudy）。compare/walk は従来の比較・歩行見本 */
export type LabTab = 'compare' | 'walk' | 'v3';

const PAD = 12;
const GAP = 8;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 共通時計。再生中だけ rAF を回し、停止・アプリが前面でない・画面を閉じる（unmount）で必ず止める。
 * 速度は進め方の倍率だけで、elapsed は変えない。
 */
function useLabClock(total: number, autoplay: boolean): [Clock, Dispatch<SetStateAction<Clock>>] {
  const active = useAppActive();
  const [clock, setClock] = useState<Clock>(() => initialClock(autoplay));
  const playing = clock.playing;
  useEffect(() => {
    if (!playing || !active) return;
    let raf = 0;
    let last = nowMs();
    const loop = () => {
      const n = nowMs();
      const dt = n - last;
      last = n;
      setClock((c) => advance(c, dt, total));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, active, total]);
  return [clock, setClock];
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      aria-checked={on}
      accessibilityLabel={`${label}${on ? '、選択中' : ''}`}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipText, on && { color: C.accentDark }]}>{label}</Text>
    </Pressable>
  );
}

/** タップ・ドラッグで時刻を指定する（操作中は止まる） */
function ScrubBar({ elapsed, total, onScrub, onStep }: { elapsed: number; total: number; onScrub: (t: number) => void; onStep: (dir: 1 | -1) => void }) {
  const [w, setW] = useState(0);
  const at = (x: number) => total * Math.min(Math.max(x / Math.max(w, 1), 0), 1);
  const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
  return (
    <View
      accessibilityRole="adjustable"
      accessibilityLabel="再生位置"
      accessibilityValue={{ min: 0, max: Math.round(total), now: Math.round(elapsed), text: `${(elapsed / 1000).toFixed(1)}秒` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onStep(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => onScrub(at(e.nativeEvent.locationX))}
      onResponderMove={(e) => onScrub(at(e.nativeEvent.locationX))}
      style={styles.scrub}
    >
      <View pointerEvents="none" style={styles.scrubTrack}>
        <View style={[styles.scrubFill, { width: `${pct}%` }]} />
      </View>
      <View pointerEvents="none" style={[styles.scrubKnob, { left: `${pct}%` }]} />
    </View>
  );
}

interface ControlsProps {
  clock: Clock;
  onToggle: () => void;
  onRestart: () => void;
  onSpeed: (s: Speed) => void;
  onStep: (dir: 1 | -1) => void;
}
function Controls({ clock, onToggle, onRestart, onSpeed, onStep }: ControlsProps) {
  return (
    <View style={{ gap: GAP }}>
      <View style={styles.row}>
        <Button label={clock.playing ? '停止' : '再生'} onPress={onToggle} />
        <Button label="はじめから" kind="secondary" onPress={onRestart} />
        <Button label="◀ コマ戻し" kind="secondary" onPress={() => onStep(-1)} />
        <Button label="コマ送り ▶" kind="secondary" onPress={() => onStep(1)} />
      </View>
      <View style={[styles.row, { alignItems: 'center' }]} accessibilityRole="radiogroup">
        <Text style={styles.sub}>速さ</Text>
        <Chip label="1倍" on={clock.speed === 1} onPress={() => onSpeed(1)} />
        <Chip label="0.25倍" on={clock.speed === 0.25} onPress={() => onSpeed(0.25)} />
      </View>
    </View>
  );
}

function Compare({ reduce, cw }: { reduce: boolean; cw: number }) {
  const [motion, setMotion] = useState<LabMotion>('blink');
  const tracks = useMemo(() => ({ old: buildTrack(motion, 'old'), nw: buildTrack(motion, 'new') }), [motion]);
  const bounds = useMemo(() => compareBounds(tracks.old, tracks.nw), [tracks]);
  const total = tracks.old.total;
  const [clock, setClock] = useLabClock(total, !reduce);

  const paneW = Math.floor((cw - GAP) / 2);
  // 共通基準は0番(立ち姿)の全身高さ。旧12・新30とも0番が同じ高さ・同じ足元になり、atlas内は全コマ同倍率。
  // 全コマの最大幅が枠に収まる高さを選び、stage高さは全コマの最大高さ＋上下12pxから決める（コマごとに変えない）
  const pair = [LAB_ATLAS.old, LAB_ATLAS.new];
  const h0 = Math.floor(fitFrame0Height(pair, paneW - 8));
  const STAGE_H = stageHeightFor(pair, h0, 12);
  const groundY = STAGE_H - 12;
  const scaleOld = scaleFromFrame0(LAB_ATLAS.old, h0);
  const scaleNew = scaleFromFrame0(LAB_ATLAS.new, h0);
  const fOld = frameAt(tracks.old, clock.elapsed);
  const fNew = frameAt(tracks.nw, clock.elapsed);
  const panes = [
    { key: 'old', title: '12コマ版', frame: fOld, image: LAB_IMAGES.old, atlas: LAB_ATLAS.old, scale: scaleOld },
    { key: 'new', title: '30コマ版', frame: fNew, image: LAB_IMAGES.new, atlas: LAB_ATLAS.new, scale: scaleNew },
  ] as const;

  const step = (dir: 1 | -1) =>
    setClock((c) => seekClock(c, dir === 1 ? nextBoundary(bounds, c.elapsed) : prevBoundary(bounds, c.elapsed), total));

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.row} accessibilityRole="radiogroup">
        {MOTION_ORDER.map((m) => (
          <Chip
            key={m}
            label={MOTION_LABELS[m]}
            on={m === motion}
            onPress={() => {
              if (m === motion) return;
              setMotion(m);
              setClock((c) => restartClock(c, !reduce));
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: GAP }}>
        {panes.map((p) => (
          <View key={p.key} style={{ width: paneW }}>
            <Text accessibilityRole="header" style={styles.paneTitle}>{p.title}</Text>
            <View style={[styles.stage, { width: paneW, height: STAGE_H }]}>
              <View pointerEvents="none" style={[styles.groundLine, { top: groundY }]} />
              <LabSprite image={p.image} atlas={p.atlas} frame={p.frame} scale={p.scale} ground={{ x: paneW / 2, y: groundY }} label={`${p.title}のあんず色の子`} />
            </View>
            <Text style={styles.frameNo}>コマ {p.frame}</Text>
          </View>
        ))}
      </View>
      <ScrubBar
        elapsed={clock.elapsed}
        total={total}
        onScrub={(t) => setClock((c) => seekClock(c, t, total))}
        onStep={step}
      />
      <Text style={styles.sub} accessibilityLiveRegion="none">
        {(clock.elapsed / 1000).toFixed(2)} / {(total / 1000).toFixed(2)} 秒
      </Text>
      <Controls
        clock={clock}
        onToggle={() => setClock((c) => togglePlay(c, total))}
        onRestart={() => setClock((c) => restartClock(c, !reduce))}
        onSpeed={(s) => setClock((c) => setSpeed(c, s))}
        onStep={step}
      />
      <Text style={styles.sub}>動く時間は同じ。姿勢のつながりを見くらべてね。</Text>
    </View>
  );
}

function Walk({ reduce, cw }: { reduce: boolean; cw: number }) {
  const [clock, setClock] = useLabClock(Infinity, !reduce);
  const room = ROOMS[0]!;
  const S = Math.floor(Math.min(cw, 420));
  const st = walkAt(clock.elapsed);
  const inPlace = inPlaceFrame(clock.elapsed);
  // 部屋: 旧あんずの可視幅=部屋の23%を基準倍率にし、歩行の0番が旧0番と同じ高さになる倍率を使う（立ち止まりは旧0番の立ち姿）
  const sOld = (WALK.bodyRatio * S) / LAB_ATLAS.old.referenceWidth;
  const sWalk = scaleFromFrame0(LAB_ATLAS.walk, LAB_ATLAS.old.frames[0]!.rect[3]! * sOld);
  // その場: 全コマの最大幅が枠に収まる倍率。stage高さは全コマの最大高さ＋上下12px
  const ipH0 = Math.floor(fitFrame0Height([LAB_ATLAS.walk], Math.min(170, cw - 24)));
  const sIn = scaleFromFrame0(LAB_ATLAS.walk, ipH0);
  const IP_H = stageHeightFor([LAB_ATLAS.walk], ipH0, 12);
  const step = (dir: 1 | -1) => setClock((c) => seekClock(c, walkStepTime(c.elapsed, dir), Infinity));
  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={styles.paneTitle}>部屋を歩く</Text>
      <View style={{ width: S, height: S, alignSelf: 'center' }}>
        <Image source={room.image} style={{ width: S, height: S }} resizeMode="contain" accessibilityLabel={`${room.label}の背景`} />
        {GARDEN_PLACEMENTS.filter((p) => p.id !== 'apricot').map((p) => (
          <MotionSprite
            key={p.id}
            id={p.id}
            frame={0}
            targetWidth={p.widthRatio * S}
            ground={{ x: p.ground[0] * S, y: p.ground[1] * S }}
          />
        ))}
        {st.moving ? (
          <LabSprite
            image={LAB_IMAGES.walk}
            atlas={LAB_ATLAS.walk}
            frame={st.frame}
            scale={sWalk}
            ground={{ x: st.x * S, y: st.y * S }}
            flip={st.facing === 'right'}
            label="歩くあんず色の子"
          />
        ) : (
          <LabSprite
            image={LAB_IMAGES.old}
            atlas={LAB_ATLAS.old}
            frame={0}
            scale={sOld}
            ground={{ x: st.x * S, y: st.y * S }}
            flip={st.facing === 'right'}
            label="立ち止まるあんず色の子"
          />
        )}
      </View>
      <Text style={[styles.sub, { textAlign: 'center' }]}>{st.moving ? '歩いています' : 'とまってひと休み'}</Text>
      <Controls
        clock={clock}
        onToggle={() => setClock((c) => togglePlay(c, Infinity))}
        onRestart={() => setClock((c) => restartClock(c, !reduce))}
        onSpeed={(s) => setClock((c) => setSpeed(c, s))}
        onStep={step}
      />
      <Text accessibilityRole="header" style={styles.paneTitle}>その場で歩く</Text>
      <View style={[styles.stage, { width: cw, height: IP_H }]}>
        <View pointerEvents="none" style={[styles.groundLine, { top: IP_H - 12 }]} />
        <LabSprite image={LAB_IMAGES.walk} atlas={LAB_ATLAS.walk} frame={inPlace} scale={sIn} ground={{ x: cw / 2, y: IP_H - 12 }} label="その場で歩くあんず色の子" />
      </View>
      <Text style={[styles.sub, { textAlign: 'center' }]}>コマ {inPlace + 1} / 12</Text>
    </View>
  );
}

interface Props {
  initialTab: LabTab;
  onBack: () => void;
}

/** 独立画面。学習状態・報酬・保存データには触れない */
export function MotionLab({ initialTab, onBack }: Props) {
  const reduce = useReduceMotion();
  const [tab, setTab] = useState<LabTab>(initialTab);
  const [inner, setInner] = useState(0);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: PAD, gap: 12 }}>
      <View style={styles.head}>
        <Button label="← もどる" kind="secondary" onPress={onBack} hint="箱庭へ戻ります" />
        <Text accessibilityRole="header" style={styles.title}>{tab === 'v3' ? '新しい動き' : '動きを見くらべる'}</Text>
      </View>
      <View style={styles.row} accessibilityRole="radiogroup">
        <Chip label="新しい動き" on={tab === 'v3'} onPress={() => setTab('v3')} />
        <Chip label="くらべる" on={tab === 'compare'} onPress={() => setTab('compare')} />
        <Chip label="歩く" on={tab === 'walk'} onPress={() => setTab('walk')} />
      </View>
      {tab === 'v3' ? (
        <MotionStudy key="v3" />
      ) : (
        <>
          {reduce ? <Text style={styles.sub}>「動きを減らす」中なので自動では動きません。再生かコマ送りで見られます。</Text> : null}
          <Card style={{ padding: 8 }}>
            {/* Card内側(border・padding除く)の実測幅。窓幅やスクロールバーに依存しない */}
            <View style={{ alignSelf: 'stretch' }} onLayout={(e) => setInner(Math.floor(e.nativeEvent.layout.width))}>
              {inner > 0 ? tab === 'compare' ? <Compare key="compare" reduce={reduce} cw={inner} /> : <Walk key="walk" reduce={reduce} cw={inner} /> : null}
            </View>
          </Card>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { ...T.head, fontSize: 18, lineHeight: 26, color: C.ink, flexShrink: 1 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  sub: { ...T.body, fontSize: 13, lineHeight: 19, color: C.sub },
  chip: { minHeight: 48, minWidth: 48, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  chipOn: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  chipText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.ink },
  paneTitle: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center', marginBottom: 4 },
  stage: { backgroundColor: C.leaf, borderRadius: 14, borderWidth: 1.5, borderColor: C.line, overflow: 'hidden' },
  groundLine: { position: 'absolute', left: 8, right: 8, height: 1, backgroundColor: C.line },
  frameNo: { ...T.body, fontSize: 13, lineHeight: 19, color: C.sub, textAlign: 'center', marginTop: 4 },
  scrub: { height: 44, justifyContent: 'center' },
  scrubTrack: { height: 8, borderRadius: 4, backgroundColor: C.disabled, overflow: 'hidden' },
  scrubFill: { height: 8, backgroundColor: C.accent },
  scrubKnob: { position: 'absolute', width: 20, height: 20, marginLeft: -10, borderRadius: 10, backgroundColor: C.accentDark, top: 12 },
});
