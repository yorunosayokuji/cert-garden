import { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { useAppActive } from '../ui/hooks';
import { useReduceMotion } from '../ui/motion';
import { Body, Button, Card } from '../ui/common';
import { C, T } from '../ui/theme';
import type { SkeletonKind } from './compare.ts';
import { NATIVE_DRIVER } from './Press';

const BONE = '#e3d8bf';

/** 骨組みの1ブロック。形は本物の部品と同じ寸法で、読み込めた時に同じ場所へ置き換わる */
function Bone({ w = '100%', h = 16, r = 8, style }: { w?: DimensionValue; h?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: w, height: h, borderRadius: r, backgroundColor: BONE }, style]} />;
}

/**
 * 全体で1つの明滅(opacity)。動きを減らす時とアプリが前面にない間は止める（静止した骨組みのまま）。
 * 位置や大きさは動かさないので、layout は保たれる。
 */
function Shimmer({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const active = useAppActive();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduce || !active) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.55, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE_DRIVER }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, active, v]);
  return (
    <Animated.View style={[{ flex: 1, opacity: v }, style]}>{children}</Animated.View>
  );
}

/** 読み込み中を支援技術へ伝える（中身の骨組みは読み上げない） */
function Busy({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      accessibilityLiveRegion="polite"
      importantForAccessibility="yes"
      aria-busy
    >
      <View style={styles.root} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Shimmer>{children}</Shimmer>
      </View>
    </View>
  );
}

const row = { flexDirection: 'row' as const, alignItems: 'center' as const };

function BoxCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** 箱庭: 見出し行(実・ポイント) → 正方形の部屋(3体の位置) → 一言 → 操作 → 部屋の選択 */
export function HomeSkeleton() {
  return (
    <Busy label="箱庭を読み込み中">
      <View style={[row, { justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8 }]}>
        <Bone w={132} h={22} />
        <View style={[row, { gap: 8 }]}>
          <Bone w={84} h={26} r={13} />
          <Bone w={92} h={26} r={13} />
        </View>
      </View>
      <View style={{ width: '100%', aspectRatio: 1, maxHeight: '58%', backgroundColor: '#ece3cd' }}>
        {[0.28, 0.5, 0.72].map((x) => (
          <View key={x} style={{ position: 'absolute', left: `${x * 100 - 7}%`, top: `${58 + (x === 0.5 ? 6 : 0)}%`, width: '14%', aspectRatio: 1, borderRadius: 999, backgroundColor: BONE }} />
        ))}
      </View>
      <View style={{ alignItems: 'center', paddingVertical: 8 }}>
        <Bone w="62%" h={14} />
      </View>
      <View style={[row, { justifyContent: 'center', gap: 8 }]}>
        <Bone w={92} h={40} r={18} />
        <Bone w={112} h={40} r={18} />
      </View>
      <View style={[row, { gap: 8, paddingHorizontal: 16, paddingVertical: 8 }]}>
        <Bone w={96} h={48} r={20} />
        <Bone w={96} h={48} r={20} />
        <Bone w={96} h={48} r={20} />
      </View>
    </Busy>
  );
}

/** 学ぶ: 見出し → 選択中の資格カード → 入力方式 → テーマ行(ボタン付き) → ミッション */
export function LearnSkeleton() {
  return (
    <Busy label="学ぶを読み込み中">
      <View style={styles.pad}>
        <Bone w={72} h={26} />
        <BoxCard>
          <Bone w="58%" h={20} />
          <Bone w="82%" h={14} />
          <View style={[row, { gap: 8 }]}>
            <Bone w={120} h={48} r={16} />
            <Bone w={120} h={48} r={16} />
          </View>
        </BoxCard>
        <View style={[row, { gap: 8 }]}>
          <Bone w="48%" h={48} r={16} />
          <Bone w="48%" h={48} r={16} />
        </View>
        {[0, 1, 2].map((i) => (
          <BoxCard key={i} style={row}>
            <View style={{ flex: 1, gap: 8 }}>
              <Bone w="64%" h={18} />
              <Bone w="40%" h={13} />
            </View>
            <Bone w={88} h={48} r={16} />
          </BoxCard>
        ))}
        <BoxCard>
          <Bone w="46%" h={18} />
          <Bone w="90%" h={14} />
        </BoxCard>
      </View>
    </Busy>
  );
}

/** 手帳: 見出し → 説明 → 記録カード(名前・日付・メモ・2ボタン) → 追加ボタン → せってい */
export function NotebookSkeleton() {
  return (
    <Busy label="手帳を読み込み中">
      <View style={styles.pad}>
        <Bone w={64} h={26} />
        <Bone w="92%" h={14} />
        {[0, 1].map((i) => (
          <BoxCard key={i}>
            <Bone w="52%" h={20} />
            <Bone w="30%" h={13} />
            <Bone w="86%" h={14} />
            <View style={[row, { gap: 8 }]}>
              <Bone w="48%" h={48} r={16} />
              <Bone w="48%" h={48} r={16} />
            </View>
          </BoxCard>
        ))}
        <Bone h={48} r={16} />
        <BoxCard style={row}>
          <Bone w="40%" h={20} />
          <View style={{ flex: 1 }} />
          <Bone w={52} h={30} r={15} />
        </BoxCard>
      </View>
    </Busy>
  );
}

/** お店: 見出し → 枠の選択 → 相棒の3列グリッド → 家具の行 */
export function ShopSkeleton() {
  return (
    <Busy label="お店を読み込み中">
      <View style={styles.pad}>
        <Bone w={64} h={26} />
        <Bone w="92%" h={14} />
        <BoxCard>
          <Bone w="36%" h={20} />
          <View style={[row, { gap: 8 }]}>
            {[0, 1, 2].map((i) => (
              <Bone key={i} w="31%" h={56} r={18} />
            ))}
          </View>
        </BoxCard>
        <BoxCard>
          <Bone w="44%" h={20} />
          <View style={[row, { gap: 8, flexWrap: 'wrap' }]}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <View key={i} style={{ width: '31%', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <Bone w="80%" h={70} r={14} />
                <Bone w="70%" h={14} />
                <Bone h={44} r={18} />
              </View>
            ))}
          </View>
        </BoxCard>
        {[0, 1].map((i) => (
          <View key={i} style={[row, { gap: 8 }]}>
            <Bone w={56} h={56} r={12} />
            <View style={{ flex: 1, gap: 6 }}>
              <Bone w="50%" h={16} />
              <Bone w="34%" h={13} />
            </View>
            <Bone w={96} h={48} r={16} />
          </View>
        ))}
      </View>
    </Busy>
  );
}

/** 設問: 閉じる＋進捗 → 問題文カード → 相棒の机の帯 → 選択肢4つ → 決定ボタン */
export function QuestionSkeleton() {
  return (
    <Busy label="問題を読み込み中">
      <View style={[styles.pad, { flex: 1 }]}>
        <View style={[row, { gap: 12 }]}>
          <Bone w={48} h={48} r={16} />
          <Bone w="auto" h={12} r={6} style={{ flex: 1 }} />
        </View>
        <BoxCard>
          <Bone w="94%" h={18} />
          <Bone w="88%" h={18} />
          <Bone w="52%" h={18} />
        </BoxCard>
        <Bone h={84} r={14} />
        {[0, 1, 2, 3].map((i) => (
          <Bone key={i} h={56} r={16} />
        ))}
        <View style={{ flex: 1 }} />
        <Bone h={48} r={16} />
      </View>
    </Busy>
  );
}

/** 結果: 見出し → 相棒 → 結果カード(4行) → もどるボタン */
export function ResultSkeleton() {
  return (
    <Busy label="結果を読み込み中">
      <View style={styles.pad}>
        <Bone w="70%" h={30} />
        <Bone h={128} r={14} />
        <Bone w="54%" h={20} style={{ alignSelf: 'center' }} />
        <BoxCard>
          <Bone w="40%" h={20} />
          <Bone w="56%" h={16} />
          <Bone w="48%" h={16} />
          <Bone w="82%" h={16} />
        </BoxCard>
        <Bone h={48} r={16} />
      </View>
    </Busy>
  );
}

const SKELETONS: Record<SkeletonKind, () => ReactNode> = {
  home: () => <HomeSkeleton />,
  learn: () => <LearnSkeleton />,
  notebook: () => <NotebookSkeleton />,
  shop: () => <ShopSkeleton />,
  question: () => <QuestionSkeleton />,
  result: () => <ResultSkeleton />,
};

const NAMES: Record<SkeletonKind, string> = { home: '箱庭', learn: '学ぶ', notebook: '手帳', shop: 'お店', question: '問題', result: '結果' };

/** スケルトンなし: 同じ準備完了を待つ通常のローダー。画面の形は出さず、中央に小さく待機を示す */
export function PlainLoader({ kind }: { kind: SkeletonKind }) {
  const reduce = useReduceMotion();
  return (
    <View
      style={[styles.root, { alignItems: 'center', justifyContent: 'center', gap: 12 }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${NAMES[kind]}を読み込み中`}
      accessibilityState={{ busy: true }}
      accessibilityLiveRegion="polite"
      aria-busy
    >
      {reduce ? null : <ActivityIndicator color={C.accentDark} />}
      <Text style={styles.plain}>読み込み中…</Text>
    </View>
  );
}

/** 読み込み表示。skeleton=false は通常ローダー（同じ準備完了で入れ替わる）。読み込み中は操作を受けない */
export function LoadView({ kind, skeleton }: { kind: SkeletonKind; skeleton: boolean }) {
  return <View style={styles.root}>{skeleton ? SKELETONS[kind]() : <PlainLoader kind={kind} />}</View>;
}

/** 読込失敗。永久にシマーせず、再試行できる。保存データは書き換えていないことを伝える */
export function LoadFailure({ message, onRetry, busy }: { message: string; onRetry: () => void; busy?: boolean }) {
  return (
    <View style={[styles.root, { justifyContent: 'center', padding: 24 }]} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Card>
        <Text style={styles.failTitle}>ひらけませんでした</Text>
        <Body>{message}</Body>
        <Body sub>保存データは書きかえていません。</Body>
        <Button label="もう一度ひらく" onPress={onRetry} disabled={busy} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { padding: 14, gap: 12 },
  card: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1.5, borderColor: C.line, padding: 16, gap: 8 },
  plain: { ...T.head, fontSize: 15, lineHeight: 22, color: C.sub },
  failTitle: { ...T.head, fontSize: 20, lineHeight: 28, color: C.ink },
});
