import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { FURNITURE, TREE_STAGE_INDEX, defOf, drawOrder, drawRect, growthDef, type Layout, type TreeStageName } from '../state/furniture';
import { FURNITURE_IMAGES, TREE_STAGE_IMAGES } from './furnitureAssets';
import { C, T } from './theme';

/** 家具の描画。見える幅と足元(anchor)で配置し、床のラグは最背面、ほかは足元Yで手前奥を付ける。zIndex はキャラと同じ式 */
export const zOfGround = (y: number) => 10 + Math.round(y * 1000);

export function FurnitureLayer({ layout, S, selected, treeStage }: { layout: Layout; S: number; selected?: string | null; treeStage?: TreeStageName }) {
  return (
    <>
      {drawOrder(layout).map((p) => {
        const base = defOf(p.id);
        if (!base) return null;
        // 知恵の木は、世話の段階に合う成長画（画像が無ければ元の木のまま。成長済みに見せない）
        const grown = p.id === 'knowledge-tree' && treeStage ? TREE_STAGE_IMAGES[TREE_STAGE_INDEX[treeStage]] : undefined;
        const def = grown ? growthDef(base) : base;
        const source = grown ?? FURNITURE_IMAGES[p.id];
        const r = drawRect(def, S, [p.x, p.y]);
        const on = selected === p.id;
        return (
          <View
            key={p.id}
            pointerEvents="none"
            accessible
            accessibilityRole="image"
            accessibilityLabel={`${def.name}${on ? '（選択中）' : ''}`}
            style={{ position: 'absolute', left: r.left, top: r.top, width: r.size, height: r.size, zIndex: def.layer === 'floor' ? 0 : zOfGround(p.y) }}
          >
            <Image source={source} resizeMode="stretch" style={{ width: r.size, height: r.size }} />
            {on ? <View style={[styles.mark, { left: def.anchor[0] * (r.size / 512) - 7, top: def.anchor[1] * (r.size / 512) - 7 }]} /> : null}
          </View>
        );
      })}
    </>
  );
}

interface PanelProps {
  draft: Layout;
  owned: Set<string>;
  selected: string | null;
  canUndo: boolean;
  dirty: boolean;
  busy: boolean;
  message: string | null;
  onSelect: (id: string) => void;
  onPlace: (id: string) => void;
  onMove: (dx: number, dy: number) => void;
  onStore: () => void;
  onUndo: () => void;
  onSave: () => void;
  onCancel: () => void;
}

const STEP = 0.02;
const Pad = ({ label, name, onPress, disabled }: { label: string; name: string; onPress: () => void; disabled?: boolean }) => (
  <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ disabled: !!disabled }} style={[styles.pad, disabled && styles.padOff]}>
    <Text style={styles.padText}>{label}</Text>
  </Pressable>
);

/** 模様替えの操作。選択後の移動ボタン・しまう・取り消し・保存・やめる。ドラッグには依存しない（部屋のタップでも動かせる） */
export function EditPanel({ draft, owned, selected, canUndo, dirty, busy, message, onSelect, onPlace, onMove, onStore, onUndo, onSave, onCancel }: PanelProps) {
  const placedIds = new Set(draft.placed.map((p) => p.id));
  const stored = FURNITURE.filter((f) => owned.has(f.id) && !placedIds.has(f.id));
  const sel = selected ? defOf(selected) : undefined;
  return (
    <View style={styles.panel} accessibilityLabel="模様替えの操作">
      <Text style={styles.msg} accessibilityLiveRegion="polite">{message ?? (sel ? `「${sel.name}」を選んでいます。ボタンか部屋のタップで動かせます。` : '動かしたい家具を選んでください。')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="radiogroup">
        {draft.placed.map((p) => {
          const d = defOf(p.id)!;
          const on = selected === p.id;
          return (
            <Pressable key={p.id} onPress={() => onSelect(p.id)} role="radio" aria-checked={on} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${d.name}${on ? '、選択中' : ''}`} style={[styles.chip, on && styles.chipOn]}>
              <Text style={styles.chipText}>{d.name}</Text>
            </Pressable>
          );
        })}
        {stored.map((d) => (
          <Pressable key={d.id} onPress={() => onPlace(d.id)} disabled={busy} accessibilityRole="button" accessibilityLabel={`しまってある${d.name}を置く`} style={[styles.chip, styles.chipStored]}>
            <Text style={styles.chipText}>＋{d.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.row}>
        <Pad label="◀" name="左へ動かす" onPress={() => onMove(-STEP, 0)} disabled={!sel} />
        <Pad label="▲" name="奥へ動かす" onPress={() => onMove(0, -STEP)} disabled={!sel} />
        <Pad label="▼" name="手前へ動かす" onPress={() => onMove(0, STEP)} disabled={!sel} />
        <Pad label="▶" name="右へ動かす" onPress={() => onMove(STEP, 0)} disabled={!sel} />
        <Pressable onPress={onStore} disabled={!sel} accessibilityRole="button" accessibilityLabel="しまう（持ち物には残ります）" accessibilityState={{ disabled: !sel }} style={[styles.act, !sel && styles.padOff]}>
          <Text style={styles.actText}>しまう</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable onPress={onUndo} disabled={!canUndo} accessibilityRole="button" accessibilityLabel="ひとつ前に取り消す" accessibilityState={{ disabled: !canUndo }} style={[styles.act, !canUndo && styles.padOff]}>
          <Text style={styles.actText}>取り消し</Text>
        </Pressable>
        <Pressable onPress={onCancel} disabled={busy} accessibilityRole="button" accessibilityLabel="やめる（元の配置に戻ります）" style={styles.act}>
          <Text style={styles.actText}>やめる</Text>
        </Pressable>
        <Pressable onPress={onSave} disabled={busy} accessibilityRole="button" accessibilityLabel={dirty ? '保存して閉じる' : '閉じる'} style={[styles.act, styles.actPrimary]}>
          <Text style={[styles.actText, { color: C.accentText }]}>{dirty ? '保存して閉じる' : '閉じる'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export const EDIT_PANEL_H = 188;

const styles = StyleSheet.create({
  mark: { position: 'absolute', width: 14, height: 14, borderRadius: 7, backgroundColor: C.accent, borderWidth: 2, borderColor: '#fff' },
  panel: { height: EDIT_PANEL_H, paddingHorizontal: 12, gap: 6, justifyContent: 'center' },
  msg: { ...T.body, fontSize: 13, lineHeight: 18, color: C.sub, textAlign: 'center' },
  chips: { gap: 6, alignItems: 'center' },
  chip: { minHeight: 40, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  chipOn: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  chipStored: { borderStyle: 'dashed' },
  chipText: { ...T.button, fontSize: 13, lineHeight: 18, color: C.ink },
  row: { flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center' },
  pad: { width: 48, height: 44, borderRadius: 14, borderWidth: 2, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  padOff: { opacity: 0.4 },
  padText: { ...T.button, fontSize: 18, color: C.ink },
  act: { minHeight: 44, paddingHorizontal: 14, borderRadius: 14, borderWidth: 2, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  actPrimary: { backgroundColor: C.accent, borderColor: C.accentDark },
  actText: { ...T.button, fontSize: 14, lineHeight: 20, color: C.ink },
});
