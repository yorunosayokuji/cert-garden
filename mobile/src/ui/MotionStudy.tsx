import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Image, Pressable, StyleSheet, Text, View, type ImageSourcePropType } from 'react-native';
import { Button, Card } from './common';
import { GAIT_DESIGN, LEGS, LEG_COLORS, LEG_NAMES, supportSegments, swingSegments } from './gaitDesign.ts';
import { useAppActive } from './hooks';
import { LabSprite } from './LabSprite';
import { advance, extentAt, initialClock, restartClock, seekClock, setSpeed, togglePlay, type Clock, type Speed } from './motionLab.ts';
import { ROOMS, type MotionAtlas } from './motionAssets';
import {
  STUDY_INITIAL, STUDY_MOTIONS, STUDY_ORDER, fitScale, fitScaleCentered, roomScale, stepStudy, studyPoseAt, studyTotal, type DrawSheet, type StudyMotion, type StudySheet,
} from './motionStudy.ts';
import {
  STUDY_ATLAS, STUDY_IMAGES, WALK_V4_ATLAS, WALK_V4_IDLE_ATLAS, WALK_V4_IDLE_IMAGE, WALK_V4_IMAGE, WALK_V4_SETTLE_ATLAS, WALK_V4_SETTLE_IMAGE, WALK_V4_START_ATLAS, WALK_V4_START_IMAGE,
} from './motionStudyAssets';
import { useReduceMotion } from './motion';
import { C, T } from './theme';

/** 全身連動を組んだ歩行(walkV4)とその休止(walkV4Idle)は motion-v4 のシート、それ以外は従来の連番。旧 rig はこの画面の既定では使わない */
function sheetSource(sheet: DrawSheet): { atlas: MotionAtlas; image: ImageSourcePropType } {
  if (sheet === 'walkV4') return { atlas: WALK_V4_ATLAS, image: WALK_V4_IMAGE };
  if (sheet === 'walkV4Idle') return { atlas: WALK_V4_IDLE_ATLAS, image: WALK_V4_IDLE_IMAGE };
  if (sheet === 'walkV4Settle') return { atlas: WALK_V4_SETTLE_ATLAS, image: WALK_V4_SETTLE_IMAGE };
  if (sheet === 'walkV4Start') return { atlas: WALK_V4_START_ATLAS, image: WALK_V4_START_IMAGE };
  const s = sheet as StudySheet;
  return { atlas: STUDY_ATLAS[s], image: STUDY_IMAGES[s] };
}

const GAP = 8;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 共通時計。再生中だけ rAF を回し、停止・アプリが前面でない（ページ外/バックグラウンド）・画面を閉じる（unmount）で必ず止める。
 * 速度は進め方の倍率だけで、elapsed は変えない。
 */
function useStudyClock(total: number, autoplay: boolean): [Clock, Dispatch<SetStateAction<Clock>>] {
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

const sec = (ms: number) => (ms / 1000).toFixed(2);
const sec1 = (ms: number) => (ms / 1000).toFixed(1);

/** 足運びの位相（4脚の支持と運び）。関節の歩行はこの接地順に従う */
function GaitChart({ cw }: { cw: number }) {
  const labelW = 64;
  const trackW = Math.max(120, cw - labelW - 8);
  const ticks = [0, 25, 50, 75, 100];
  return (
    <View style={{ gap: 6 }}>
      {LEGS.map((leg) => {
        const sup = supportSegments(leg);
        const swing = swingSegments(leg);
        const td = GAIT_DESIGN.touchdownPct[leg];
        return (
          <View
            key={leg}
            style={styles.gaitRow}
            accessible
            accessibilityLabel={`${LEG_NAMES[leg]}（${leg}）。接地は周期の${td}%。支持${GAIT_DESIGN.supportPct}%、運び${GAIT_DESIGN.swingPct}%`}
          >
            <View style={[styles.gaitLabel, { width: labelW }]}>
              <View style={[styles.swatch, { backgroundColor: LEG_COLORS[leg] }]} />
              <Text style={styles.gaitLabelText}>{leg}</Text>
            </View>
            <View style={[styles.gaitTrack, { width: trackW }]}>
              {swing.map(([a, b], i) => (
                <View key={`w${i}`} style={[styles.gaitSwing, { left: (a / 100) * trackW, width: ((b - a) / 100) * trackW }]} />
              ))}
              {sup.map(([a, b], i) => (
                <View key={`s${i}`} style={[styles.gaitSupport, { left: (a / 100) * trackW, width: ((b - a) / 100) * trackW, backgroundColor: LEG_COLORS[leg] }]} />
              ))}
              <View style={[styles.gaitTd, { left: (td / 100) * trackW - 1 }]} />
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: labelW }} />
        <View style={{ width: trackW, height: 18 }}>
          {ticks.map((p) => (
            <Text key={p} style={[styles.tick, { left: (p / 100) * trackW - 14 }]}>{p}%</Text>
          ))}
        </View>
      </View>
    </View>
  );
}

/** 足運びの詳細。開いたときだけ出す */
function GaitDetail({ cw }: { cw: number }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Button label={open ? '足運びをとじる' : '足運びを見る'} kind="secondary" onPress={() => setOpen((v) => !v)} />
      {open ? (
        <View style={{ gap: 10 }}>
          <GaitChart cw={cw} />
          <Text style={styles.sub}>
            色の帯＝支持（{GAIT_DESIGN.supportPct}%）、うすい帯＝運び（{GAIT_DESIGN.swingPct}%）、縦線＝接地。接地は LH → LF → RH → RF の順。
          </Text>
          <Text style={styles.sub}>設計の参考であり、新しい画像から測った値ではありません。</Text>
        </View>
      ) : null}
    </View>
  );
}

function StudyBody({ cw, reduce }: { cw: number; reduce: boolean }) {
  const [motion, setMotion] = useState<StudyMotion>(STUDY_INITIAL);
  const def = STUDY_MOTIONS[motion];
  const total = studyTotal(motion);
  const [clock, setClock] = useStudyClock(total, !reduce);
  const pose = studyPoseAt(motion, clock.elapsed);
  const room = ROOMS[0]!;
  const { atlas, image } = sheetSource(pose.sheet);

  // 部屋: 各シートの referenceWidth を部屋幅の23%に合わせる（シート内は全コマ共通・コマごとの拡縮なし）
  const S = Math.floor(Math.min(cw, 420));

  // 拡大: 選んだシートの全コマが枠に収まる共通倍率。全身連動の歩行は足元を中央に置いて左右反転しても尾が出ない倍率（休止の1コマも同じ寸法・anchor）
  const big = sheetSource(def.sheet).atlas;
  const sBig = def.sheet === 'walkV4' ? fitScaleCentered(big, cw - 24, 260) : fitScale(big, cw - 24, 260);
  const STAGE_H = Math.ceil(extentAt(big, sBig).h) + 24;
  const groundY = STAGE_H - 12;

  const toggle = () => setClock((c) => togglePlay(c, total));
  const restart = () => setClock((c) => restartClock(c, !reduce));
  const step = (dir: 1 | -1) => setClock((c) => seekClock(c, stepStudy(motion, c.elapsed, dir), total));
  const speed = (s: Speed) => setClock((c) => setSpeed(c, s));

  const walking = motion === 'walk';
  const frameText = walking
    ? pose.moving
      ? `コマ ${pose.frame + 1} / ${def.frameCount}`
      : 'ひと休み'
    : `コマ ${pose.frame + 1} / ${def.frameCount}　実枚数 ${def.frameCount}枚`;
  const timeText = def.loop
    ? `経過 ${sec(clock.elapsed)} 秒（1周期 ${sec(def.durationMs)} 秒）`
    : `経過 ${sec(clock.elapsed)} / ${sec(total)} 秒`;

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.row} accessibilityRole="radiogroup">
        {STUDY_ORDER.map((m) => (
          <Chip
            key={m}
            label={STUDY_MOTIONS[m].label}
            on={m === motion}
            onPress={() => {
              if (m === motion) return;
              setMotion(m);
              setClock((c) => restartClock(c, !reduce));
            }}
          />
        ))}
      </View>
      <Text style={styles.sub}>
        {walking
          ? `全身連動の歩き ${def.frameCount}姿勢 / ${sec1(def.durationMs)}秒`
          : `${def.label} ${def.frameCount}枚 / ${sec1(def.durationMs)}秒`}
      </Text>

      <View style={{ width: S, height: S, alignSelf: 'center' }}>
        <Image source={room.image} style={{ width: S, height: S }} resizeMode="contain" accessibilityLabel={`${room.label}の背景`} />
        <LabSprite
          image={image}
          atlas={atlas}
          frame={pose.frame}
          scale={roomScale(S, atlas.referenceWidth)}
          ground={{ x: pose.x * S, y: pose.y * S }}
          flip={pose.facing === 'right'}
          label={`あんず色の子（${def.label}）`}
        />
      </View>
      {walking ? <Text style={[styles.sub, { textAlign: 'center' }]}>{pose.moving ? '歩いています' : 'ひと休み'}</Text> : null}

      <View style={{ gap: GAP }}>
        <View style={styles.row}>
          <Button label={clock.playing ? '停止' : '再生'} onPress={toggle} />
          <Button label="最初から" kind="secondary" onPress={restart} />
          <Button label="1コマ前" kind="secondary" onPress={() => step(-1)} />
          <Button label="1コマ次" kind="secondary" onPress={() => step(1)} />
        </View>
        <View style={[styles.row, { alignItems: 'center' }]} accessibilityRole="radiogroup">
          <Text style={styles.sub}>速さ</Text>
          <Chip label="通常" on={clock.speed === 1} onPress={() => speed(1)} />
          <Chip label="0.25倍" on={clock.speed === 0.25} onPress={() => speed(0.25)} />
        </View>
        <Text style={styles.info} accessibilityLiveRegion="none">
          {frameText}　{timeText}
        </Text>
        {clock.speed === 0.25 ? <Text style={styles.sub}>0.25倍は検証用の表示速度です。動きの時間は変えていません。</Text> : null}
      </View>

      <Text accessibilityRole="header" style={styles.paneTitle}>拡大表示</Text>
      <View style={[styles.stage, { width: cw, height: STAGE_H }]}>
        <View pointerEvents="none" style={[styles.groundLine, { top: groundY }]} />
        <LabSprite
          image={image}
          atlas={atlas}
          frame={pose.frame}
          scale={sBig}
          ground={{ x: cw / 2, y: groundY }}
          flip={pose.facing === 'right'}
          label={`拡大したあんず色の子（${def.label}）`}
        />
      </View>

      {walking ? <GaitDetail cw={cw} /> : null}
    </View>
  );
}

/** 独立画面（MotionLab の「新しい動き」から開く）。学習状態・報酬・保存データには触れない */
export function MotionStudy() {
  const reduce = useReduceMotion();
  const [inner, setInner] = useState(0);
  return (
    <View style={{ gap: 12 }}>
      {reduce ? <Text style={styles.sub}>「動きを減らす」中なので自動では動きません。再生か1コマ送りで見られます。</Text> : null}
      <Card style={{ padding: 8 }}>
        {/* Card内側(border・padding除く)の実測幅。窓幅やスクロールバーに依存しない */}
        <View style={{ alignSelf: 'stretch' }} onLayout={(e) => setInner(Math.floor(e.nativeEvent.layout.width))}>
          {inner > 0 ? <StudyBody key={reduce ? 'reduce' : 'normal'} cw={inner} reduce={reduce} /> : null}
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  sub: { ...T.body, fontSize: 13, lineHeight: 19, color: C.sub },
  info: { ...T.head, fontSize: 14, lineHeight: 21, color: C.ink },
  chip: { minHeight: 48, minWidth: 48, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  chipOn: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  chipText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.ink },
  paneTitle: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink, textAlign: 'center', marginBottom: 4 },
  stage: { backgroundColor: C.leaf, borderRadius: 14, borderWidth: 1.5, borderColor: C.line, overflow: 'hidden' },
  groundLine: { position: 'absolute', left: 8, right: 8, height: 1, backgroundColor: C.line },
  gaitRow: { flexDirection: 'row', alignItems: 'center' },
  gaitLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gaitLabelText: { ...T.head, fontSize: 14, lineHeight: 20, color: C.ink },
  swatch: { width: 14, height: 14, borderRadius: 3, borderWidth: 1, borderColor: C.line },
  gaitTrack: { height: 24, borderRadius: 6, backgroundColor: C.disabled, overflow: 'hidden' },
  gaitSwing: { position: 'absolute', top: 0, height: 24, backgroundColor: C.card, opacity: 0.6 },
  gaitSupport: { position: 'absolute', top: 4, height: 16, borderRadius: 4 },
  gaitTd: { position: 'absolute', top: 0, width: 2, height: 24, backgroundColor: C.ink },
  tick: { ...T.body, position: 'absolute', top: 0, width: 28, textAlign: 'center', fontSize: 11, lineHeight: 16, color: C.sub },
});
