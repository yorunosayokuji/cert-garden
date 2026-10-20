// native の候補 picker。Web の PICKER.md と同じ意味（番号で切り替え・再生）を、読み上げできる選択コントロールにしたもの。
// 製品の下タブとは見た目も場所も分け（暗い比較用の帯）、製品のラベルには混ぜない。
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { VARIANTS } from './compare.ts';

interface Props {
  variant: number;
  onSet: (variant: number) => void;
  onReplay: () => void;
}

export function VariantPicker({ variant, onSet, onReplay }: Props) {
  return (
    <View style={styles.pill} accessibilityRole="tablist" accessibilityLabel="比較する候補">
      {VARIANTS.map((v) => {
        const on = v.id === variant;
        return (
          <Pressable
            key={v.id}
            onPress={() => onSet(v.id)}
            role="tab"
            aria-selected={on}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`候補${v.id} ${v.name}${on ? '、選択中' : ''}`}
            style={[styles.item, on && styles.itemOn]}
          >
            <Text style={[styles.itemText, on && { color: '#fff' }]}>{v.id}</Text>
          </Pressable>
        );
      })}
      <View style={styles.divider} />
      <Pressable onPress={onReplay} accessibilityRole="button" accessibilityLabel="読み込み表示をもう一度再生" style={styles.item}>
        <Text style={styles.itemText}>↻</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 2, padding: 4, borderRadius: 999, backgroundColor: 'rgba(10,10,10,0.82)' },
  item: { minWidth: 44, minHeight: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  itemOn: { backgroundColor: 'rgba(255,255,255,0.14)' },
  itemText: { fontSize: 16, color: 'rgba(255,255,255,0.6)' },
  divider: { width: 1, height: 20, marginHorizontal: 4, backgroundColor: 'rgba(255,255,255,0.12)' },
});
