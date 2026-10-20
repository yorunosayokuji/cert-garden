import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { GardenSnapshot } from '../../../src/mobile.ts';
import { EDITABLE_ROOM, type RoomId } from '../state/room';
import { defOf, footprintRect, moveBy, moveTo, onlyOwned, ownedSet, placeItem, placementProblem, sameLayout, storeAway, type Layout } from '../state/furniture';
import { EDIT_PANEL_H, EditPanel, FurnitureLayer, zOfGround } from './RoomEditor';
import { characterName } from '../state/characters';
import type { Roster } from '../state/roster';
import { RoomCreature, useCrowd } from './RoomCrowd';
import { charMotion } from './motionCatalog';
import { fruitEta } from '../state/format';
import { useAppActive, useNow } from './hooks';
import { GARDEN_PLACEMENTS, ROOMS } from './motionAssets';
import type { LabTab } from './MotionLab.tsx';
import { C, MAX_W, T } from './theme';

interface Props {
  snapshot: GardenSnapshot;
  room: RoomId;
  roster: Roster;
  reduceMotion: boolean;
  /** 保存済みの家具配置と、保存（成功した時だけ true） */
  layout: Layout;
  onSaveLayout: (layout: Layout) => Promise<boolean>;
  onRoom: (id: RoomId) => void;
  /** 動きの見くらべ（学習状態には触れない独立画面）を開く */
  onOpenLab: (tab: LabTab) => void;
  /** iOS候補2用。'overlay' は実・ポイントを部屋の上に浮かせ、見出しを省く。既定(standard)は本体と同じ */
  chrome?: 'standard' | 'overlay';
  /** iOS候補用。部屋の飾りの一言を出さず、操作に必要な説明だけにする（本体は既定の false のまま） */
  plainNote?: boolean;
}

/** 候補の比較側で残す、操作に必要な説明だけ（雰囲気の一言は出さない） */
export const PLAIN_NOTE: Record<string, string> = {
  home: '家具は「模様替え」で動かせます。',
  first: '家具は絵に含まれていて、動かせません。',
};

export function formatDate(d: string): string {
  const [, m, day] = d.split('-');
  return `${Number(m)}月${Number(day)}日`;
}

/** 箱庭: 風景だけ。学習・復習・時間のカードは「学ぶ」に置く。おへやでは家具の模様替えができる */
export function Home({ snapshot, room, roster, reduceMotion, layout, onSaveLayout, onRoom, onOpenLab, chrome = 'standard', plainNote = false }: Props) {
  const overlay = chrome === 'overlay';
  const { width } = useWindowDimensions();
  const active = useAppActive();
  const nowTick = useNow(30_000);
  // 実際に使える領域を測り、背景全体(1:1)が見切れないよう短い端末では縮める
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Layout>(layout);
  const [history, setHistory] = useState<Layout[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 見出し行と説明文の実際の高さ（折り返しても部屋の全景が収まるように計算へ入れる）
  const [topH, setTopH] = useState(TOP_H);
  const [noteH, setNoteH] = useState(NOTE_H);
  const owned = ownedSet(snapshot.ownedFurniture);
  const saved = onlyOwned(layout, owned);
  const availW = Math.floor(Math.min(box?.w ?? width, MAX_W));
  const below = editing ? EDIT_PANEL_H : ENTRY_H + CHIPS_H;
  const S = Math.max(160, Math.floor(box ? Math.min(availW, box.h - (overlay ? 0 : Math.max(TOP_H, topH)) - Math.max(NOTE_H, noteH) - below) : availW));
  const current = ROOMS.find((r) => r.id === room) ?? ROOMS[0]!;
  const editable = room === EDITABLE_ROOM;
  const shown = editing ? draft : saved;

  // 同室の3体: 待機→歩く→止まる→待機。家具の足元(膨らませた範囲)と他の個体を避け、編集中・非表示・動きを減らす時は止める。
  // 家具を動かせない風景の部屋では、焼き込まれた家具を避けられないので歩かせず待機のまま
  const crowdChars = roster.room.map((id) => charMotion(id)!).filter(Boolean);
  const obstacles = useMemo(
    () => shown.placed.flatMap((p) => {
      const d = defOf(p.id);
      if (!d || d.layer === 'floor') return [];
      const [l, t, r, b] = footprintRect(d, p.x, p.y);
      return [{ l, t, r, b }];
    }),
    [shown],
  );
  const { states: crowd, status: motionStatus, retry: retryMotion } = useCrowd(
    crowdChars,
    crowdChars.map((_, i) => ({ x: GARDEN_PLACEMENTS[i]!.ground[0], y: GARDEN_PLACEMENTS[i]!.ground[1] })),
    { obstacles, canWalk: editable && !editing && active && !reduceMotion, run: active && !reduceMotion && !editing },
  );

  const startEdit = () => {
    if (!editable) onRoom(EDITABLE_ROOM);
    setDraft(saved);
    setHistory([]);
    setSelected(null);
    setMsg(null);
    setEditing(true);
  };
  const exit = () => {
    setEditing(false);
    setSelected(null);
    setMsg(null);
    setHistory([]);
  };
  const apply = (next: Layout | null, problem?: string | null) => {
    if (!next) {
      setMsg(problem ?? 'そこには置けません。');
      return;
    }
    setHistory((h) => [...h, draft]);
    setDraft(next);
    setMsg(null);
  };
  const tryMove = (dx: number, dy: number) => {
    const p = draft.placed.find((q) => q.id === selected);
    if (!p) return;
    apply(moveBy(draft, p.id, dx, dy), placementProblem(draft, p.id, p.x + dx, p.y + dy));
  };
  const tapRoom = (x: number, y: number) => {
    if (!selected) return setMsg('動かしたい家具を先に選んでください。');
    apply(moveTo(draft, selected, x / S, y / S), placementProblem(draft, selected, x / S, y / S));
  };
  const place = (id: string) => {
    const next = placeItem(draft, id);
    if (!next) return setMsg('置ける場所がありません。');
    setHistory((h) => [...h, draft]);
    setDraft(next);
    setSelected(id);
    setMsg(null);
  };
  const save = async () => {
    if (saving) return;
    if (sameLayout(draft, saved)) return exit();
    setSaving(true);
    const ok = await onSaveLayout(draft);
    setSaving(false);
    if (ok) exit();
    else setMsg('保存できませんでした。もう一度ためせます。');
  };
  return (
    <View
      style={styles.root}
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        setBox((prev) => (prev && prev.w === Math.floor(w) && prev.h === Math.floor(h) ? prev : { w: Math.floor(w), h: Math.floor(h) }));
      }}
    >
      <View
        style={[styles.top, { width: availW }, overlay && styles.topOverlay]}
        pointerEvents={overlay ? 'box-none' : 'auto'}
        onLayout={(e) => setTopH(Math.ceil(e.nativeEvent.layout.height))}
      >
        {overlay ? <View accessibilityRole="header" accessibilityLabel="わたしの箱庭" /> : <Text accessibilityRole="header" style={styles.title}>わたしの箱庭</Text>}
        <View style={styles.stats}>
          <Text
            style={[styles.stat, overlay && styles.statOverlay]}
            accessibilityLabel={`知恵の実 ${snapshot.fruits}個、最大${snapshot.maxFruits}個${snapshot.nextFruitAt ? `。次の1個まで${fruitEta(snapshot.nextFruitAt, nowTick)}` : ''}`}
          >
            実 {snapshot.fruits}/{snapshot.maxFruits}{snapshot.nextFruitAt ? `　${fruitEta(snapshot.nextFruitAt, nowTick)}` : ''}
          </Text>
          <Text style={[styles.stat, overlay && styles.statOverlay]} accessibilityLabel={`ポイント ${snapshot.points}`}>ポイント {snapshot.points}</Text>
        </View>
      </View>
      <View style={{ width: S, height: S, alignSelf: 'center' }}>
        <Image source={current.image} style={{ width: S, height: S }} resizeMode="contain" accessibilityLabel={`${current.label}の背景。3匹の相棒がいます`} />
        {editable ? <FurnitureLayer layout={shown} S={S} selected={editing ? selected : null} treeStage={snapshot.tree.stage} /> : null}
        {crowdChars.map((c, i) => (
          <RoomCreature key={`${c.id}-${i}`} char={c} state={crowd[i] ?? { phase: 'idle', dir: 'left', clip: 'idle', frame: 0, x: GARDEN_PLACEMENTS[i]!.ground[0], y: GARDEN_PLACEMENTS[i]!.ground[1] }} S={S} z={zOfGround(crowd[i]?.y ?? GARDEN_PLACEMENTS[i]!.ground[1])} />
        ))}
        {editing ? (
          <Pressable
            onPress={(e) => tapRoom(e.nativeEvent.locationX, e.nativeEvent.locationY)}
            accessibilityRole="button"
            accessibilityLabel="部屋をタップして、選んだ家具をそこへ動かす"
            style={[StyleSheet.absoluteFill, { zIndex: 100000 }]}
          />
        ) : null}
      </View>
      {(() => {
        const noteText = editing ? '模様替え中：動物は止まっています。' : plainNote ? (PLAIN_NOTE[room] ?? '') : current.note;
        // 候補2は暗い面に置くので、説明は明るい面の上の濃い文字にする（部屋は拡大・切り取りしない）
        const onDark = overlay && noteText !== '';
        return (
          <Text
            style={[styles.note, { width: onDark ? S - 24 : S }, onDark && styles.noteOnDark]}
            onLayout={(e) => setNoteH(Math.ceil(e.nativeEvent.layout.height) + 4)}
            accessibilityLiveRegion="polite"
          >
            {noteText}
          </Text>
        );
      })()}
      {motionStatus === 'error' ? (
        <Pressable onPress={retryMotion} accessibilityRole="button" accessibilityLabel="動きの絵を読み込めませんでした。もう一度ためす" style={styles.entry}>
          <Text style={styles.entryText}>動きの絵を読み込めませんでした。もう一度ためす</Text>
        </Pressable>
      ) : null}
      {editing ? (
        <EditPanel
          draft={draft}
          owned={owned}
          selected={selected}
          canUndo={history.length > 0}
          dirty={!sameLayout(draft, saved)}
          busy={saving}
          message={msg}
          onSelect={(id) => { setSelected(id); setMsg(null); }}
          onPlace={place}
          onMove={tryMove}
          onStore={() => { if (selected) { setHistory((h) => [...h, draft]); setDraft(storeAway(draft, selected)); setSelected(null); setMsg(null); } }}
          onUndo={() => { const prev = history[history.length - 1]; if (prev) { setDraft(prev); setHistory((h) => h.slice(0, -1)); setSelected((s) => (s && prev.placed.some((p) => p.id === s) ? s : null)); setMsg(null); } }}
          onSave={() => void save()}
          onCancel={exit}
        />
      ) : null}
      {!editing ? <View style={[styles.entries, { width: availW }]}>
        <Pressable onPress={startEdit} accessibilityRole="button" accessibilityLabel="模様替えをする" style={styles.entry}>
          <Text style={styles.entryText}>模様替え</Text>
        </Pressable>
        <Pressable onPress={() => onOpenLab('v3')} accessibilityRole="button" accessibilityLabel="新しい動きを見る（26匹の待機と左右へのすすみ方）" style={styles.entry}>
          <Text style={styles.entryText}>新しい動き</Text>
        </Pressable>
      </View> : null}
      {!editing ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, maxWidth: availW }} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
        {ROOMS.map((r) => {
          const on = r.id === room;
          return (
            <Pressable
              key={r.id}
              onPress={() => onRoom(r.id)}
              role="radio"
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              aria-checked={on}
              accessibilityLabel={`${r.label}${on ? '、表示中' : ''}`}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && { color: C.accentDark }]}>{r.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView> : null}
    </View>
  );
}

// 上部コンパクト行・一言・場所選択の高さ（短い端末で背景を縮める計算に使う）
const TOP_H = 44;
const NOTE_H = 28;
const CHIPS_H = 56;
const ENTRY_H = 44;

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 0 },
  // 固定の高さにせず、狭い幅では見出しと実・ポイントが次の行へ回る（折れて重ならない）
  top: { minHeight: TOP_H, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 2, paddingHorizontal: 16, paddingVertical: 4 },
  title: { ...T.head, fontSize: 18, lineHeight: 26, color: C.ink },
  // 候補2: 部屋の上へ浮かせる（高さを取らず、読みやすいよう不透明寄りの面）
  topOverlay: { position: 'absolute', top: 8, left: 0, zIndex: 200000, minHeight: 0, justifyContent: 'flex-end' },
  noteOnDark: { color: C.ink, backgroundColor: C.card, borderRadius: 12, paddingHorizontal: 12, overflow: 'hidden', marginTop: 4, fontSize: 15, lineHeight: 22 },
  statOverlay: { backgroundColor: 'rgba(255,250,240,0.92)' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { ...T.head, fontSize: 13, lineHeight: 19, color: C.ink, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 3 },
  // 説明文は自然な高さ（2行になっても次のボタンと重ならない）。上下に余白を持つ
  note: { ...T.body, minHeight: NOTE_H, fontSize: 13, lineHeight: 19, color: C.sub, textAlign: 'center', paddingVertical: 4, marginBottom: 4 },
  entries: { height: ENTRY_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 },
  entry: { minHeight: 40, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  entryText: { ...T.button, fontSize: 13, lineHeight: 19, color: C.ink },
  chips: { height: CHIPS_H, alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  chip: { minHeight: 48, minWidth: 48, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  chipOn: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  chipText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.ink },
});
