// 比較用の操作帯。製品の画面ではなく、候補を見比べるための外側の道具（暗い帯）。製品のラベルには混ぜない。
// Web: 候補の切り替えは PICKER.md 準拠の picker(RNの木の外)。native: 同じ意味の選択コントロール。
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { VARIANTS, type SkeletonKind } from './compare.ts';
import { COMPARE_DELAY_MS, type CompareSettings } from './namespace.ts';
import { VariantPicker } from './Picker';

interface Props {
  cfg: CompareSettings;
  onVariant: (v: number) => void;
  onSkeleton: (on: boolean) => void;
  onDelay: (ms: number) => void;
  onReplay: () => void;
  onFail: () => void;
  /** 読み込み表示中（再生・失敗は二重に走らせない） */
  busy: boolean;
  /** 全画面の学習フロー表示中は、起動の再生・失敗を無効にする */
  flowOpen: boolean;
  insetTop: number;
  /** 読み込み表示の固定（比較用）。null = 固定なし */
  pin: SkeletonKind | null;
  onPin: (k: SkeletonKind | null) => void;
}

const PIN_OPTIONS: { id: string; text: string }[] = [
  { id: 'none', text: 'なし' },
  { id: 'home', text: '箱庭' },
  { id: 'learn', text: '学ぶ' },
  { id: 'notebook', text: '手帳' },
  { id: 'shop', text: 'お店' },
  { id: 'question', text: '問題' },
  { id: 'result', text: '結果' },
];

/** 選択肢が多い時は折り返し、ラベルは先頭の行に置く（320〜430幅でも切れない。タッチ目標は縮めない） */
function Toggle({ label, value, options, onChange, wide }: { label: string; value: string; options: { id: string; text: string }[]; onChange: (id: string) => void; wide?: boolean }) {
  return (
    <View style={[styles.toggle, wide && styles.toggleWide]} role="radiogroup" accessibilityRole="radiogroup" accessibilityLabel={label} aria-label={label}>
      <Text style={[styles.toggleLabel, wide && styles.toggleLabelWide]}>{label}</Text>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            role="radio"
            aria-checked={on}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${label} ${o.text}${on ? '、選択中' : ''}`}
            style={[styles.opt, on && styles.optOn]}
          >
            <Text style={[styles.optText, on && { color: '#fff' }]}>{o.text}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function CompareChrome({ cfg, onVariant, onSkeleton, onDelay, onReplay, onFail, busy, flowOpen, insetTop, pin, onPin }: Props) {
  const v = VARIANTS[cfg.variant - 1]!;
  const web = Platform.OS === 'web';
  // 比較の操作が長いので畳める（畳んでも固定・設定はそのまま）。既定は開く
  const [open, setOpen] = useState(true);
  return (
    <View style={[styles.chrome, { paddingTop: web ? 68 : insetTop + 6 }]}>
      {/* Web の picker は document.body に固定されるので、ここは場所だけ空ける */}
      <VariantPicker variant={cfg.variant} onSet={onVariant} onReplay={onReplay} />
      <Text style={styles.name} accessibilityLiveRegion="polite">
        候補{v.id}　{v.name}　— {v.axis}
      </Text>
      <Pressable
        onPress={() => setOpen(!open)}
        role="button"
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? '比較の操作を畳む' : '比較の操作を開く'}
        style={styles.fold}
      >
        <Text style={styles.btnText}>{open ? '比較の操作を畳む ▲' : '比較の操作を開く ▼'}</Text>
      </Pressable>
      {open ? <View style={styles.row}>
        <Toggle label="スケルトン" value={cfg.skeleton ? 'on' : 'off'} options={[{ id: 'on', text: 'あり' }, { id: 'off', text: 'なし' }]} onChange={(id) => onSkeleton(id === 'on')} />
        <Toggle label="待ち" value={cfg.delayMs === 0 ? '0' : 'd'} options={[{ id: 'd', text: `${COMPARE_DELAY_MS / 1000}秒` }, { id: '0', text: 'なし' }]} onChange={(id) => onDelay(id === '0' ? 0 : COMPARE_DELAY_MS)} />
        <Toggle wide label="読込を固定" value={pin ?? 'none'} options={PIN_OPTIONS} onChange={(id) => onPin(id === 'none' ? null : (id as SkeletonKind))} />
        <Pressable
          onPress={onFail}
          disabled={busy || flowOpen || pin !== null}
          accessibilityRole="button"
          accessibilityLabel="読込失敗を試す"
          accessibilityState={{ disabled: busy || flowOpen || pin !== null }}
          style={[styles.btn, (busy || flowOpen || pin !== null) && { opacity: 0.4 }]}
        >
          <Text style={styles.btnText}>失敗を試す</Text>
        </Pressable>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chrome: { backgroundColor: '#1c1c1e', paddingBottom: 8, paddingHorizontal: 8, gap: 6, alignItems: 'stretch' },
  name: { color: 'rgba(255,255,255,0.78)', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  toggle: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 2, maxWidth: '100%', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 22, paddingLeft: 10, paddingRight: 3, paddingVertical: 3 },
  toggleWide: { width: '100%', justifyContent: 'center' },
  toggleLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginRight: 4 },
  toggleLabelWide: { width: '100%', textAlign: 'center', marginRight: 0, paddingBottom: 2 },
  fold: { alignSelf: 'center', minHeight: 44, paddingHorizontal: 14, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  opt: { minHeight: Platform.OS === 'web' ? 36 : 44, minWidth: 44, borderRadius: 999, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  optOn: { backgroundColor: 'rgba(255,255,255,0.18)' },
  optText: { color: 'rgba(255,255,255,0.62)', fontSize: 13 },
  btn: { minHeight: 42, borderRadius: 999, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  btnText: { color: 'rgba(255,255,255,0.85)', fontSize: 13 },
});
