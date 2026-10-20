import { useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TREE_STAGE_INDEX } from '../state/furniture';
import { TREE_STAGE_IMAGES } from './furnitureAssets';
import { QUALIFICATIONS, type AnswerMode, type GardenSnapshot, type Hold } from '../../../src/mobile.ts';
import { themeTitle, themesOf, versionOfTheme } from '../state/learningPack';
import type { QualSummary } from '../state/diagnosticController';
import { Body, Button, Card, H } from './common';
import { formatDate } from './Home';
import { C, T } from './theme';

const pad = { padding: 14, gap: 12 } as const;

export const qualName = (id: string) => {
  const q = QUALIFICATIONS.find((x) => x.id === id);
  return q ? `${q.name}${q.grade ? ` ${q.grade}` : ''}` : id;
};

const MASTERY_LABEL = {
  recalled_later: '日をおいて思い出せました',
  same_day_only: '同じ日の確認まで（日をおいた思い出しはまだ）',
  seen: 'ふれたところ',
} as const;

interface Props {
  snapshot: GardenSnapshot;
  resumable: { kind: 'learn' | 'review'; qualificationId: string; themeId: string } | null;
  busy: boolean;
  /** 最後に選んだ資格（保存済み）。読み込み前は null */
  qual: string | null;
  onQual: (qualificationId: string) => void;
  onStart: (qualificationId: string, themeId: string, answerMode: AnswerMode) => void;
  onResume: () => void;
  onReview: (qualificationId: string, answerMode: AnswerMode) => void;
  diag: (qualificationId: string) => QualSummary;
  onDiag: (qualificationId: string) => void;
  onDiagDismiss: (qualificationId: string) => void;
  /** 自分の学習で保留した問題（この端末だけ）と解除 */
  holds: Hold[];
  onRelease: (questionId: string) => void;
  /** 今日のミッションの実を受け取る */
  onClaim: (kind: 'learn' | 'review') => void;
  /** 浮いたタブ・ホームバーに隠れないよう、内容の末尾に足す余白（iOS候補用。既定0） */
  bottomInset?: number;
}

// 箱庭の知恵の木の成長画（たね／芽／若木／実の木）と同じ段階の言葉。水やりをする動物の絵は未制作
export const TREE_TEXT = {
  seed: 'いまは、たねの木です。',
  sprout: 'いまは、芽の木です。',
  leaf: 'いまは、若木です。',
  fruit: 'いまは、実のなる木です。',
} as const;

/**
 * 学ぶ: 選んだ資格とそのテーマを先に見せ、「資格を変える」で10資格を開く。
 * 用意しているのは各資格の「基礎コース」。注意は短く出し、詳しい制限は「教材について」で読める（隠さない）。
 */
export function LearnTab({ snapshot, resumable, busy, qual: savedQual, onQual, onStart, onResume, onReview, diag, onDiag, onDiagDismiss, holds, onRelease, onClaim, bottomInset = 0 }: Props) {
  const padStyle = bottomInset ? { ...pad, paddingBottom: pad.padding + bottomInset } : pad;
  const [mode, setMode] = useState<AnswerMode>('choice');
  const [changing, setChanging] = useState(false);
  const [about, setAbout] = useState(false);
  if (savedQual === null) {
    return (
      <ScrollView contentContainerStyle={padStyle}>
        <H>学ぶ</H>
        <Body sub>読み込み中です…</Body>
      </ScrollView>
    );
  }
  const qual = savedQual;
  const noFruit = snapshot.fruits < 1;
  const themes = themesOf(qual);
  const anyNumeric = themes.some((t) => t.numericCount > 0);
  const next = snapshot.nextReviews.filter((r) => r.qualificationId === qual).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const doneIn = (id: string) => themesOf(id).filter((t) => snapshot.completedThemes.includes(`${t.qualificationId}/${t.themeId}`)).length;
  const minutes = Math.floor((snapshot.studySeconds[qual] ?? 0) / 60);
  const ds = diag(qual);
  const rec = ds.latest?.themes.find((t) => t.themeId === ds.latest?.recommendedThemeId);
  return (
    <ScrollView contentContainerStyle={padStyle}>
      <H>学ぶ</H>
      {resumable ? (
        <Card>
          <Body sub>{qualName(resumable.qualificationId)}</Body>
          <H>途中の{resumable.kind === 'review' ? 'おさらい' : '学習'}があります</H>
          <Body sub>つづきから始めても、実は追加でつかいません。</Body>
          <Button label={resumable.kind === 'review' ? 'つづきからおさらい' : 'つづきから学ぶ'} onPress={onResume} disabled={busy} />
        </Card>
      ) : null}

      <Card>
        <H>今日のミッション</H>
        {([['learn', '新しい学習を1ステージ'], ['review', '無料のおさらいを1回']] as const).map(([k, label]) => {
          const m = snapshot.missions[k];
          return (
            <View key={k} style={styles.themeRow}>
              <View style={styles.grow}>
                <Text style={styles.cName}>{label}</Text>
                <Body sub>{m.claimed ? '実を受け取りました' : m.done ? (snapshot.fruits >= snapshot.maxFruits ? 'できました（実が満タンなので、あとで受け取れます）' : 'できました') : 'まだです'}</Body>
              </View>
              {m.done && !m.claimed ? <Button label="実を受け取る" onPress={() => onClaim(k)} disabled={busy || snapshot.fruits >= snapshot.maxFruits} hint={snapshot.fruits >= snapshot.maxFruits ? '実が満タンです' : undefined} /> : null}
            </View>
          );
        })}
        <Text style={styles.cName}>知恵の木</Text>
        <View style={styles.treeRow}>
          {/* 箱庭と同じ成長画（共通の寸法で一つの絵を拡縮して作ったものではない） */}
          <Image source={TREE_STAGE_IMAGES[TREE_STAGE_INDEX[snapshot.tree.stage]]} resizeMode="contain" style={{ width: 72, height: 72 }} accessibilityLabel={TREE_TEXT[snapshot.tree.stage]} />
          <View style={styles.grow}>
            <Body sub>
              {TREE_TEXT[snapshot.tree.stage]}　世話 {snapshot.tree.total}回　{snapshot.tree.caredToday ? '今日の世話はできました' : '今日の世話はまだです（学習かおさらいを終えると世話できます）'}
            </Body>
          </View>
        </View>
        <Body sub>休んだり間違えたりしても、木は枯れません。</Body>
      </Card>

      <Card>
        <View style={styles.qHead}>
          <View style={styles.grow}>
            <Text style={styles.qName}>{qualName(qual)}</Text>
            <Body sub>基礎コース　完了 {doneIn(qual)}/{themes.length}テーマ</Body>
          </View>
          <Button label={changing ? 'とじる' : '資格を変える'} kind="quiet" onPress={() => setChanging(!changing)} />
        </View>
        {changing ? (
          <View style={styles.chipRow} accessibilityRole="radiogroup">
            {QUALIFICATIONS.map((q) => {
              const on = q.id === qual;
              const n = themesOf(q.id).length;
              return (
                <Pressable
                  key={q.id}
                  onPress={() => { onQual(q.id); setChanging(false); }}
                  role="radio"
                  aria-checked={on}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${qualName(q.id)}、基礎テーマ${n}つ、完了${doneIn(q.id)}つ${on ? '、えらび中' : ''}`}
                  style={[styles.qChip, on ? styles.pickOn : styles.pickOff]}
                >
                  <Text style={[styles.pickText, on && { color: C.accentText }]}>{qualName(q.id)}</Text>
                  <Text style={[styles.qSub, on && { color: C.accentText }]}>{doneIn(q.id)}/{n}テーマ</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {anyNumeric ? (
          <View accessibilityRole="radiogroup" style={styles.modeRow}>
            {([['choice', '4択'], ['number', '数字を入力']] as const).map(([m, label]) => {
              const on = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setMode(m)}
                  role="radio"
                  aria-checked={on}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`答え方: ${label}${on ? '、えらび中' : ''}`}
                  style={[styles.modeChip, on ? styles.pickOn : styles.pickOff]}
                >
                  <Text style={[styles.pickText, on && { color: C.accentText }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {anyNumeric && mode === 'number' ? <Body sub>数値の問題は数字を入力して答えます。ほかの問題は4択のままです。いつでも4択に戻せます。</Body> : null}

        {themes.map((t) => {
          const key = `${t.qualificationId}/${t.themeId}`;
          const done = snapshot.completedThemes.includes(key);
          const level = snapshot.masteryLevels[key];
          const useNumber = mode === 'number' && t.numericCount > 0;
          // 保留で出せる問題が足りないテーマは、始める前に理由を見せる（解除は「教材について」）
          const heldHere = holds.filter((h) => h.qualificationId === t.qualificationId && h.themeId === t.themeId && h.contentVersion === versionOfTheme(t.qualificationId, t.themeId)).length;
          const heldBlock = t.kind === 'foundation' && t.questionCount - 2 - heldHere < 3;
          const blocked = busy || !!resumable || noFruit || heldBlock;
          return (
            <View key={key} style={styles.themeRow}>
              <View style={styles.grow}>
                <Text style={styles.cName}>{t.title}</Text>
                <Body sub>約{t.minutes}分・{t.questionCount}問{done ? '・完了ずみ' : ''}</Body>
                {level ? <Body sub>{MASTERY_LABEL[level]}</Body> : null}
                {mode === 'number' ? <Body sub>{useNumber ? `数字を入力する問題 ${t.numericCount}問` : 'このテーマは4択だけです'}</Body> : null}
                {ds.latest?.recommendedThemeId === t.themeId ? <Body sub>初回チェックの目安：ここから</Body> : null}
                {heldBlock ? <Body sub>保留中の問題が多く、いまは始められません。「教材について」から解除できます。</Body> : null}
              </View>
              <Button
                label={done ? 'もう一度' : '学ぶ'}
                onPress={() => onStart(t.qualificationId, t.themeId, useNumber ? 'number' : 'choice')}
                disabled={blocked}
                hint={resumable ? '途中の学習を先に続けてください' : noFruit ? '知恵の実がないため始められません' : heldBlock ? '保留中の問題が多いため始められません' : undefined}
              />
            </View>
          );
        })}
        {resumable ? <Body sub>途中の学習があるため、新しく始める前に上のボタンでつづけてください。</Body> : noFruit ? <Body sub>知恵の実がありません。下の無料のおさらいならできます。</Body> : <Body sub>はじめると知恵の実を1個つかいます。</Body>}
        <Body sub>試作の基礎コースです。試験範囲は順次追加中です。</Body>
        <Pressable onPress={() => setAbout(!about)} accessibilityRole="button" accessibilityState={{ expanded: about }} accessibilityLabel="教材について" style={styles.aboutLink}>
          <Text style={styles.aboutText}>{about ? '▼ 教材について（とじる）' : '▶ 教材について'}</Text>
        </Pressable>
        {about ? (
          <View style={styles.about} accessibilityLiveRegion="polite">
            <Body sub>・問題は、このアプリ用に独自に書いた基礎問題です（公式問題や書籍の転載ではありません）。</Body>
            <Body sub>・人の専門家による監修はありません。数値の問題は式の検算までで、言葉の問題は作者が確認した段階です（独立した全範囲の検証はしていません）。</Body>
            <Body sub>・各資格に用意したのは基礎の2テーマだけです。完了数は「用意したテーマ」の数で、試験範囲の網羅率でも合格の見込みでもありません。</Body>
            <Body sub>・出典に載せた出題範囲のページは、範囲の確認用です。問題の答えが正しい証拠ではありません。</Body>
            <Body sub>・同じ日のふりかえりは定着の判定ではありません。日をおいて思い出せたかを別に数えています。</Body>
            <Body sub>・知恵の実は最大10個で、1時間に1個、日付（日本時間）が変わると満タンに戻ります。この端末の時計で数える試作のルールで、数値は仮です。</Body>
            <Body sub>・ミッションの実は、学習かおさらいを終えた日に1個ずつ。満タンのときは受け取りを待てます。木は世話の回数で、たね・芽・若木・実の木と育ちます。水やりをする動物の絵はまだ作っていません。</Body>
            <Text style={styles.aboutHead}>保留した問題（{holds.length}件・この端末だけ）</Text>
            {holds.length === 0 ? <Body sub>保留した問題はありません。問題の答えの画面から「問題が気になる」で保留できます。</Body> : null}
            {holds.map((h) => {
              const v = versionOfTheme(h.qualificationId, h.themeId);
              const cur = v === undefined || h.contentVersion === v;
              return (
                <View key={h.questionId} style={styles.holdRow}>
                  <View style={styles.grow}>
                    <Text style={styles.cName}>{h.prompt}</Text>
                    <Body sub>{qualName(h.qualificationId)}／{themeTitle(h.qualificationId, h.themeId)}／教材版 {h.contentVersion}{cur ? '' : '（古い版：いまは効いていません）'}</Body>
                  </View>
                  <Button label="解除" kind="secondary" onPress={() => onRelease(h.questionId)} />
                </View>
              );
            })}
          </View>
        ) : null}
      </Card>

      {ds.active ? (
        <Card>
          <H>途中の初回チェックがあります</H>
          <Body sub>{qualName(qual)}の6問です。つづきから受けられます（無料）。</Body>
          <Button label="チェックをつづける" onPress={() => onDiag(qual)} disabled={busy} />
        </Card>
      ) : !ds.latest && !ds.dismissed ? (
        <Card>
          <H>はじめに、短いチェック（6問）</H>
          <Body sub>無料・実もポイントも使いません。わからなくても進めます。</Body>
          <Button label="チェックする" onPress={() => onDiag(qual)} disabled={busy} />
          <Button label="あとで（このまま学べます）" kind="quiet" onPress={() => onDiagDismiss(qual)} disabled={busy} />
        </Card>
      ) : (
        <Card>
          <H>初回チェック</H>
          {rec ? <Body sub>前回の目安: 「{rec.title}」から（今回の6問での結果です）</Body> : <Body sub>6問・無料。学習の完了には数えません。</Body>}
          <Button label={rec ? '結果を見る／もう一度' : 'チェックする'} kind="secondary" onPress={() => onDiag(qual)} disabled={busy} />
        </Card>
      )}

      <Card>
        <H>無料のおさらい</H>
        <Body sub>実はつかいません。間違えた・わからなかった問題の考え方を優先します。{next ? `次のおさらいは ${formatDate(next.dueDate)} ごろ。` : ''}</Body>
        <Button label="おさらいする" kind="secondary" onPress={() => onReview(qual, mode === 'number' && (themesOf(qual).find((t) => t.themeId === next?.themeId)?.numericCount ?? 0) > 0 ? 'number' : 'choice')} disabled={busy || !!resumable || !next} />
        {!next ? <Body sub>この資格でおさらいできるテーマがまだありません。学習を終えると使えます。</Body> : null}
      </Card>
      <Card>
        <H>これまでの積み重ね</H>
        <Body>{qualName(qual)}の学習時間 {minutes}分　／　ポイント {snapshot.points}</Body>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // 狭い幅では、資格名の列に十分な幅を残し、ボタンは下の行へ回る（固定の高さや切り落としは使わない）
  qHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 },
  treeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 },
  qName: { ...T.head, fontSize: 18, lineHeight: 26, color: C.ink },
  cName: { ...T.head, fontSize: 15, lineHeight: 21, color: C.ink },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  qChip: { minHeight: 56, minWidth: 96, flexGrow: 1, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  qSub: { ...T.head, fontSize: 12, lineHeight: 17, color: C.sub },
  pickOn: { backgroundColor: C.accent, borderColor: C.accentDark },
  pickOff: { backgroundColor: C.card, borderColor: C.line },
  pickText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.ink },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: { flex: 1, minHeight: 48, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  themeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, paddingVertical: 6 },
  aboutLink: { minHeight: 44, justifyContent: 'center' },
  aboutText: { ...T.head, fontSize: 14, lineHeight: 20, color: C.sub },
  about: { gap: 4, paddingVertical: 4 },
  aboutHead: { ...T.head, fontSize: 14, lineHeight: 20, color: C.ink, marginTop: 6 },
  holdRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, paddingVertical: 4 },
});
