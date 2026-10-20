import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { StageResult } from '../state/controller';
import { characterName, type CharacterId } from '../state/characters';
import { Body, Button, Card, H } from './common';
import { CharacterSprite } from './CharacterSprite';
import { useAppActive } from './hooks';
import { formatDate } from './Home';
import { C, MAX_W, T } from './theme';

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}秒`;
  return `${Math.floor(sec / 60)}分${sec % 60 ? `${sec % 60}秒` : ''}`;
}

/**
 * 結果画面。選んでいる学習の相棒が、待機の姿で一緒に終えたことを伝える。
 * 「喜ぶ」連番はまだ個体ごとには作っていないので、他の個体の絵や変形で喜びを作らず、待機のまま文だけで伝える。
 */
export function Complete({ result, onHome, companion, reduceMotion, plain = false }: { result: StageResult; onHome: () => void; companion: CharacterId; reduceMotion: boolean; /** iOS候補用: 飾りの見出し・一言を出さない */ plain?: boolean }) {
  const { width } = useWindowDimensions();
  const active = useAppActive();
  const W = Math.min(width, MAX_W);
  const box = W * 0.4;
  const name = characterName(companion);
  if (plain) {
    // iOS候補用: 結果 → 正解数 → 学習時間・ポイント・次の復習の行 → 基礎範囲の短い注意。飾りの文は置かない
    const rows: { label: string; value: string }[] = [
      { label: '学習時間', value: formatDuration(result.activeSeconds) },
      { label: 'ポイント', value: result.duplicate ? '受け取りずみ' : result.kind === 'review' ? '増えません' : `+${result.pointsAwarded}` },
      { label: '合計', value: `${result.totalPoints}` },
      ...(result.nextReviewDate ? [{ label: '次の復習', value: `${formatDate(result.nextReviewDate)}ごろ` }] : []),
    ];
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14, width: W, alignSelf: 'center' }}>
        <Text accessibilityRole="header" style={styles.title}>結果</Text>
        <View style={{ height: box * 0.95, width: W - 32 }}>
          <CharacterSprite id={companion} width={box * 0.8} maxHeight={box * 0.9} ground={{ x: (W - 32) / 2, y: box * 0.9 }} run={active && !reduceMotion} label={`${name}の待機の姿`} />
        </View>
        <Card>
          <Text style={styles.score} accessibilityLabel={`${result.total}問中${result.correct}問正解`}>{result.correct}<Text style={styles.scoreOf}> / {result.total}問 正解</Text></Text>
          {rows.map((r) => (
            <View key={r.label} style={styles.resultRow}>
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Text style={styles.rowValue} accessibilityLabel={`${r.label} ${r.value}`}>{r.value}</Text>
            </View>
          ))}
        </Card>
        <Body sub>基礎テーマ1つの記録です。試験範囲すべての完了や合格を示すものではありません。</Body>
        <Button label="箱庭にもどる" onPress={onHome} />
      </ScrollView>
    );
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14, width: W, alignSelf: 'center' }}>
      <Text accessibilityRole="header" style={styles.title}>{plain ? '結果' : '今日の一歩、できたね'}</Text>
      <View style={{ height: box * 0.95, width: W - 32 }}>
        <CharacterSprite id={companion} width={box * 0.8} maxHeight={box * 0.9} ground={{ x: (W - 32) / 2, y: box * 0.9 }} run={active && !reduceMotion} label={`${name}が、いっしょに終えました`} />
      </View>
      {plain ? null : <Text style={styles.together}>{name}といっしょに終えました。</Text>}
      <Card>
        <H>今回の結果</H>
        <Body>{result.total}問中 {result.correct}問 正解</Body>
        <Body>学習時間 {formatDuration(result.activeSeconds)}</Body>
        <Body>
          ごほうび（仮）: {result.duplicate ? '受け取りずみ' : `+${result.pointsAwarded}ポイント`}　合計 {result.totalPoints}ポイント
        </Body>
        {result.kind === 'review' ? <Body sub>おさらいではポイントは増えません。</Body> : null}
        {result.nextReviewDate ? <Body>次のおさらい: {formatDate(result.nextReviewDate)} ごろ（無料のおさらい）</Body> : null}
      </Card>
      <Body sub>用意した基礎テーマが一つ終わった記録です。その資格の試験範囲をすべて終えたことや、合格できることを示すものではありません。</Body>
      <Button label="箱庭にもどる" onPress={onHome} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  title: { ...T.head, fontSize: 24, lineHeight: 32, color: C.ink },
  score: { ...T.head, fontSize: 34, lineHeight: 42, color: C.ink },
  scoreOf: { ...T.head, fontSize: 17, lineHeight: 24, color: C.sub },
  // 文字が大きくなったら値が下の行へ回る（ラベルと値を1文字ずつ折り返さない）
  resultRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', columnGap: 12, minHeight: 32, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 6 },
  rowLabel: { ...T.body, fontSize: 17, lineHeight: 24, color: C.sub },
  rowValue: { ...T.head, fontSize: 19, lineHeight: 26, color: C.ink },
  together: { ...T.head, fontSize: 17, lineHeight: 24, color: C.sub, textAlign: 'center' },
});
