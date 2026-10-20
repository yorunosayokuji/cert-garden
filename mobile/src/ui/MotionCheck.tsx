import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CHARACTERS } from '../state/characters';
import { clipLabel, clipOf, spriteRect } from '../state/roomMotion';
import { Body, Button, Card, H } from './common';
import { useAppActive } from './hooks';
import { charMotion, imageOf } from './motionCatalog';
import { useReduceMotion } from './motion';
import { C, MAX_W, T } from './theme';
import { useClipsReady } from './useClips';

const CLIP_ORDER = ['idle', 'walk_left', 'walk_right', 'start_left', 'stop_left', 'start_right', 'stop_right'];

/**
 * 新しい動きの確認。26体の待機／左右へのすすみ方を、再生・停止・コマ送り・大きさ切替で見られる。
 * 持っている動き出し／とまるだけを出す（無い方向は反転や逆再生で作らない）。確認用で、採用や品質の判定ではない。
 * 再生は Home と同じく、画面が前面でない・「動きを減らす」の間は止める。画像がそろうまで時計を進めない。
 */
export function MotionCheck({ initialId, onBack }: { initialId: string; onBack: () => void }) {
  const { width } = useWindowDimensions();
  const W = Math.min(width, MAX_W);
  const active = useAppActive();
  const reduce = useReduceMotion();
  const [id, setId] = useState(charMotion(initialId) ? initialId : 'anzu');
  const [clipName, setClipName] = useState('idle');
  const [wantPlay, setWantPlay] = useState(true);
  const [frame, setFrame] = useState(0);
  const [big, setBig] = useState(false);
  const c = charMotion(id)!;
  const names = useMemo(() => CLIP_ORDER.filter((n) => c.clips[n]), [c]);
  const name = c.clips[clipName] ? clipName : 'idle';
  const clip = clipOf(c, name);
  const frameIdx = Math.min(frame, clip.frames.length - 1);

  // 選んだ個体の「いまのクリップ」と待機がそろうまで時計を進めない。次に使いそうなクリップは待たずに用意する
  const { status, retry } = useClipsReady([c], () => (name === 'idle' ? ['idle'] : ['idle', name]), () => names);
  const ready = status === 'ready';
  const playing = wantPlay && ready && active && !reduce;
  // 準備前は「この個体の前に表示できたコマ」を保つ。個体が替わった直後は別の個体の絵を出さず、案内の枠にする
  const lastShown = useRef<{ id: string; file: string } | null>(null);
  const currentFile = clip.frames[frameIdx]!.file;
  if (ready) lastShown.current = { id, file: currentFile };
  const showFile = ready ? currentFile : lastShown.current?.id === id ? lastShown.current.file : null;

  useEffect(() => {
    setFrame(0);
  }, [id, name]);

  useEffect(() => {
    if (!playing) return;
    let idx = frame;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      t = setTimeout(() => {
        idx = (idx + 1) % clip.frames.length;
        setFrame(idx);
        tick();
      }, clip.frames[idx % clip.frames.length]!.ms);
    };
    tick();
    return () => clearTimeout(t);
  }, [playing, c, name]); // eslint-disable-line react-hooks/exhaustive-deps

  const stage = Math.min(W - 32, 420);
  // 部屋での大きさ（見える幅 = 部屋幅 × roomWidth）と、大きく見る表示（見える幅を枠の約7割に）
  const roomPx = big ? (stage * 0.7) / c.roomWidth : stage;
  const rect = spriteRect(c, clip, roomPx, { x: stage / 2, y: stage * 0.85 });
  const step = (d: number) => {
    setWantPlay(false);
    setFrame((f) => (Math.min(f, clip.frames.length - 1) + d + clip.frames.length) % clip.frames.length);
  };
  const chip = (label: string, on: boolean, onPress: () => void, a11y: string) => (
    <Pressable key={a11y} onPress={onPress} role="radio" aria-checked={on} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${a11y}${on ? '、選択中' : ''}`} style={[styles.chip, on && styles.chipOn]}>
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
  const stopReason = !active ? '（画面が前面でないため停止中）' : reduce ? '（「動きを減らす」のため停止中）' : '';
  return (
    <View style={[styles.root, { width: W }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="箱庭にもどる" style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </Pressable>
        <Text style={styles.title}>新しい動き</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Body sub>26匹の待機と、左右へすすむ動きを確かめる画面です。確認用で、見た目の採用を決めるものではありません。</Body>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="radiogroup">
          {CHARACTERS.map((ch) => chip(ch.name, ch.id === id, () => { setId(ch.id); setClipName('idle'); setWantPlay(true); }, ch.name))}
        </ScrollView>
        <View style={styles.rowWrap} accessibilityRole="radiogroup">
          {names.map((n) => chip(clipLabel(n), n === name, () => { setClipName(n); setWantPlay(true); }, clipLabel(n)))}
        </View>
        <View style={[styles.stage, { width: stage, height: stage }]}>
          <View pointerEvents="none" style={[styles.floor, { top: stage * 0.85 - 2 }]} />
          {showFile ? (
            <View pointerEvents="none" accessible accessibilityRole="image" accessibilityLabel={`${c.name}の${clipLabel(name)}`} style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.side, height: rect.side }}>
              <Image source={imageOf(showFile)} resizeMode="stretch" style={{ width: rect.side, height: rect.side }} />
            </View>
          ) : (
            <View style={styles.wait} accessibilityLiveRegion="polite">
              <Text style={styles.waitText}>{status === 'error' ? `${c.name}の絵を読み込めませんでした。` : `${c.name}の絵を読み込み中です…`}</Text>
              {status === 'error' ? <Button label="もう一度ためす" kind="secondary" onPress={retry} /> : null}
            </View>
          )}
        </View>
        {status === 'error' && showFile ? <Button label="動きの絵を読み込めませんでした。もう一度ためす" kind="secondary" onPress={retry} /> : null}
        {/* 再生中は読み上げを更新せず、停止中のコマ変更（コマ送り）だけ知らせる */}
        <Text style={styles.readout} accessibilityLiveRegion={playing ? 'none' : 'polite'} aria-live={playing ? 'off' : 'polite'}>
          {c.name}　{clipLabel(name)}　{frameIdx + 1}/{clip.frames.length}{playing ? '' : `（停止中）${stopReason}`}
        </Text>
        <View style={styles.rowWrap}>
          <Button label={wantPlay ? '停止' : '再生'} onPress={() => setWantPlay(!wantPlay)} />
          <Button label="◀ 前のコマ" kind="secondary" onPress={() => step(-1)} />
          <Button label="次のコマ ▶" kind="secondary" onPress={() => step(1)} />
        </View>
        <View style={styles.rowWrap} accessibilityRole="radiogroup">
          {chip('部屋の大きさ', !big, () => setBig(false), '部屋での大きさで見る')}
          {chip('大きく見る', big, () => setBig(true), '大きく見る')}
        </View>
        <Card>
          <H>見かたの注意</H>
          <Body sub>左向きと右向きは別々に描いた絵です。反転や逆再生はしていません。「うごきだし」「とまる」は、描いてある向きだけ出ます。</Body>
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'center', backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, backgroundColor: C.leaf },
  back: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  backText: { ...T.head, fontSize: 24, color: C.ink },
  title: { ...T.head, fontSize: 18, lineHeight: 26, color: C.ink },
  content: { padding: 14, gap: 12, alignItems: 'stretch' },
  row: { gap: 6, alignItems: 'center' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { minHeight: 44, paddingHorizontal: 12, borderRadius: 16, borderWidth: 2, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  chipOn: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  chipText: { ...T.button, fontSize: 14, lineHeight: 20, color: C.ink },
  stage: { alignSelf: 'center', backgroundColor: '#fbf5e4', borderWidth: 1.5, borderColor: C.line, borderRadius: 16, overflow: 'hidden' },
  floor: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: C.line },
  wait: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  waitText: { ...T.head, fontSize: 15, lineHeight: 22, color: C.sub, textAlign: 'center' },
  readout: { ...T.head, fontSize: 14, lineHeight: 20, color: C.ink, textAlign: 'center' },
});
