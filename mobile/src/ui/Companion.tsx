import { useState } from 'react';
import { Image, StyleSheet, View, useWindowDimensions } from 'react-native';
import { DESK_IMAGE, STUDY_LAYOUT } from './assets';
import { useAppActive } from './hooks';
import { CharacterSprite } from './CharacterSprite';
import type { Reaction } from './MotionSprite';
import { characterName, type CharacterId } from '../state/characters';

export type { Reaction };

interface Props {
  id: CharacterId;
  reduceMotion: boolean;
  reaction: Reaction | null;
}

/**
 * 選択肢のすぐ上の棚/机の帯。高さは70–95pxで、選択肢本文には重ねない(pointerEvents none)。
 * 短い端末では帯を低くし、拡大率は高さに合わせて全コマ共通のまま縮める。
 */
export function StudyCompanion({ id, reduceMotion, reaction }: Props) {
  const { width, height } = useWindowDimensions();
  // 親の内容領域(スクロールバーを除く実幅)を測って合わせる。測定前だけ窓幅で仮置き
  const [measured, setMeasured] = useState<number | null>(null);
  const w = Math.floor(measured ?? Math.min(width, 480) - 24);
  const bandH = height < 700 ? 72 : 92;
  const deskH = w / STUDY_LAYOUT.aspectRatio;
  const active = useAppActive();
  void reaction; // 新キャラには正解・励ましの専用動作素材がない。他キャラの絵で代用せず、待機のままにする
  return (
    <View
      style={styles.slot}
      onLayout={(e) => {
        const lw = Math.floor(e.nativeEvent.layout.width);
        setMeasured((prev) => (prev === lw ? prev : lw));
      }}
    >
    <View style={[styles.band, { width: w, height: bandH }]} pointerEvents="none">
      {/* 机の絵は下端そろえで見せる（上部は切る） */}
      <Image source={DESK_IMAGE} resizeMode="stretch" style={{ position: 'absolute', width: w, height: deskH, left: 0, top: bandH - deskH }} />
      <CharacterSprite
        id={id}
        width={w * 0.26}
        maxHeight={bandH - 10}
        ground={{ x: w * STUDY_LAYOUT.ground[0], y: bandH - 8 }}
        run={active && !reduceMotion}
        label={`${characterName(id)}が机で付き合ってくれています`}
      />
    </View>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { alignSelf: 'stretch' },
  band: { overflow: 'hidden', alignSelf: 'center', borderRadius: 18, backgroundColor: '#f3e6cf' },
});
