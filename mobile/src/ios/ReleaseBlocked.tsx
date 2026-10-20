// 署名版で画面の案が未選択（または選択が壊れている）時の画面。旧画面へは戻らない。
// EAS の事前検査が先に止めるので、通常はここへ来ない（来たら設定の誤り）。
import { StyleSheet, Text, View } from 'react-native';
import { C, T } from '../ui/theme';

export default function ReleaseBlocked({ reason }: { reason: 'noSelection' | 'badSelection' }) {
  return (
    <View style={styles.page} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Text style={styles.title}>起動できません</Text>
      <Text style={styles.body}>{reason === 'noSelection' ? '画面のデザインがまだ選ばれていません。' : '画面のデザインの選択が正しくありません。'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { ...T.head, fontSize: 20, lineHeight: 28, color: C.ink },
  body: { ...T.body, fontSize: 17, lineHeight: 24, color: C.sub, textAlign: 'center' },
});
