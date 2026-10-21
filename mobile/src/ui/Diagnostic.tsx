import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { DiagResult, DiagView, QuestionRef, ReportReason } from '../../../src/mobile.ts';
import type { CharacterId } from '../state/characters';
import { Body, Button, Card, H } from './common';
import { StudyCompanion } from './Companion';
import { ReportPanel, SourcesPanel } from './Study';
import { C, MAX_W, T } from './theme';

interface Props {
  /** 「問題が気になる」のローカル記録/保留（この端末だけ）。成功したら true */
  onReport: (ref: QuestionRef, reason: ReportReason | null, memo: string, hold: boolean) => Promise<boolean>;
  isHeld: (questionId: string) => boolean;
  companion: CharacterId;
  reduceMotion: boolean;
  qualName: string;
  view: DiagView;
  latest?: DiagResult;
  busy: boolean;
  /** 学習を始められるか（実があり、途中の学習が無い） */
  canStartTheme: boolean;
  onStart: () => void;
  onSelect: (optionId: string) => void;
  onConfirm: () => void;
  onDontKnow: () => void;
  onNext: () => void;
  onClose: () => void;
  onAbandon: () => void;
  onStartTheme: (themeId: string) => void;
}

/**
 * 資格ごとの初回チェック（最大6問）。無料・実もポイントも使わず、学習テーマの完了にも数えない。
 * 結果は「今回のチェックでの正誤」と始める目安のテーマだけ。資格全体のレベルや合格の見込みは出さない。
 */
export function Diagnostic({ onReport, isHeld, companion, reduceMotion, qualName, view, latest, busy, canStartTheme, onStart, onSelect, onConfirm, onDontKnow, onNext, onClose, onAbandon, onStartTheme }: Props) {
  const { width } = useWindowDimensions();
  const W = Math.min(width, MAX_W);
  const [note, setNote] = useState(false);
  const q = view.kind === 'question' ? view : null;
  const result = view.kind === 'result' ? view.result : null;
  const fb = q?.feedback;
  return (
    <View style={[styles.root, { width: W }]}>
      <View style={styles.header}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="閉じる（途中までは保存されます）" style={styles.close}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.qual} numberOfLines={1}>{qualName}の初回チェック</Text>
        </View>
        {q ? <Text style={styles.count}>{q.index}/{q.total}</Text> : null}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
        {view.kind === 'none' || view.kind === 'stale' ? (
          <Card>
            {view.kind === 'stale' ? <Body>{view.reason}</Body> : null}
            <Text style={styles.introLead}>最大6問・無料・わからなくてもOK</Text>
            <Body sub>どこから学ぶとよいかの目安です。実もポイントも使いません。</Body>
            <Button label="チェックを始める" onPress={onStart} disabled={busy} />
            {latest ? <Body sub>前回の結果は残っています。</Body> : null}
            <Button label="あとで" kind="quiet" onPress={onClose} />
            <Pressable onPress={() => setNote(!note)} accessibilityRole="button" accessibilityState={{ expanded: note }} accessibilityLabel="くわしい注意" style={styles.noteLink}>
              <Text style={styles.noteLinkText}>{note ? '▼ くわしい注意（とじる）' : '▶ くわしい注意'}</Text>
            </Pressable>
            {note ? (
              <View style={{ gap: 4 }}>
                <Body sub>用意した基礎テーマから、合計で最大6問を出します。学習の完了には数えません。</Body>
                <Body sub>少ない問題数だけで、実力や合格の見込みは分かりません。資格全体のレベルを示すものでもありません。</Body>
              </View>
            ) : null}
          </Card>
        ) : null}

        {q ? (
          <>
            <Text style={styles.tag}>{q.themeTitle}</Text>
            <Text accessibilityRole="header" style={styles.prompt}>{q.prompt}</Text>
            {/* 選んだ相棒が机で付き合う（学習画面と同じ棚。選択肢には重ならない） */}
            <StudyCompanion id={companion} reduceMotion={reduceMotion} reaction={null} />
            <View style={{ gap: 10 }} accessibilityRole="radiogroup">
              {q.options.map((o) => {
                const chosen = q.selectedOptionId === o.id;
                const isAnswer = fb?.correctOptionId === o.id;
                const locked = !!fb;
                return (
                  <Pressable
                    key={o.id}
                    disabled={locked || busy}
                    onPress={() => onSelect(o.id)}
                    role="radio"
                    aria-checked={chosen}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: chosen, disabled: locked }}
                    accessibilityLabel={`${o.text}${chosen ? '、選択中' : ''}${isAnswer ? '、正しい答え' : ''}`}
                    style={[styles.opt, chosen && styles.optChosen, isAnswer && styles.optAnswer]}
                  >
                    <Text style={styles.mark}>{isAnswer ? '✓' : chosen ? '●' : '○'}</Text>
                    <Text style={styles.optText}>{o.text}</Text>
                  </Pressable>
                );
              })}
            </View>
            {fb ? (
              <View accessibilityLiveRegion="polite" style={[styles.fb, { backgroundColor: fb.correct ? C.okBg : C.gentleBg }]}>
                <Text style={styles.fbTitle}>{fb.correct ? '正解！' : fb.unknown ? 'いっしょに確認しよう' : 'ここを覚えておこう'}</Text>
                <Body>{fb.explanation}</Body>
                {fb.whyWrong ? <Body sub>{fb.whyWrong}</Body> : null}
                {fb.references ? <SourcesPanel key={`s-${q.questionRef.questionId}`} refs={fb.references} /> : null}
                <ReportPanel key={`r-${q.questionRef.questionId}`} held={isHeld(q.questionRef.questionId)} onRecord={(reason, memo, hold) => onReport(q.questionRef, reason, memo, hold)} />
              </View>
            ) : null}
            <View style={{ gap: 8 }}>
              {!fb ? (
                <>
                  <Button label="これで確定する" onPress={onConfirm} disabled={busy || q.selectedOptionId === null} hint={q.selectedOptionId === null ? '選択肢を選んでください' : undefined} />
                  <Button label="わからない" kind="secondary" onPress={onDontKnow} disabled={busy} />
                </>
              ) : (
                <Button label={q.index === q.total ? '結果を見る' : '次へ'} onPress={onNext} disabled={busy} />
              )}
              <Button label="このチェックをやめる" kind="quiet" onPress={onAbandon} disabled={busy} />
            </View>
          </>
        ) : null}

        {result ? (
          <>
            <H>今回のチェックの結果</H>
            <Body sub>今回出した {result.themes.reduce((n, t) => n + t.total, 0)}問での正誤です。出していないテーマや範囲は含みません。実力や合格の見込みを示すものではありません。</Body>
            {result.themes.map((t) => {
              const rec = t.themeId === result.recommendedThemeId;
              return (
                <Card key={t.themeId}>
                  <Text style={styles.themeTitle}>{t.title}</Text>
                  <Body>
                    今回は {t.total}問中 {t.correct}問 正解{t.unknown > 0 ? `（わからない ${t.unknown}問）` : ''}
                  </Body>
                  <Text style={[styles.badge, t.level === 'check' && styles.badgeCheck]}>{t.level === 'solid' ? '今回は正解が多めでした' : '要確認：ここから確かめるのがおすすめ'}</Text>
                  {rec ? <Body sub>始める目安のテーマです（今回出した範囲で正解の割合がいちばん低かったテーマ。同じ割合なら先のテーマ）。</Body> : null}
                  <Button
                    label={rec ? 'このテーマから学ぶ（おすすめ）' : 'このテーマを学ぶ'}
                    kind={rec ? 'primary' : 'secondary'}
                    onPress={() => onStartTheme(t.themeId)}
                    disabled={busy || !canStartTheme}
                    hint={canStartTheme ? undefined : '知恵の実がないか、途中の学習があります'}
                  />
                </Card>
              );
            })}
            {!canStartTheme ? <Body sub>知恵の実がないか、途中の学習があるため、いまは学習を始められません。無料のおさらいや、あとでの学習はできます。</Body> : null}
            <Button label="もう一度チェックする" kind="secondary" onPress={onStart} disabled={busy} />
            <Button label="とじる" kind="quiet" onPress={onClose} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: C.leaf, borderBottomWidth: 1.5, borderBottomColor: C.line },
  close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
  closeText: { ...T.button, fontSize: 24, lineHeight: 28, color: C.ink },
  qual: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink },
  count: { ...T.head, fontSize: 14, lineHeight: 20, color: C.sub },
  content: { padding: 16, gap: 12 },
  introLead: { ...T.head, fontSize: 19, lineHeight: 28, color: C.ink },
  noteLink: { minHeight: 44, justifyContent: 'center' },
  noteLinkText: { ...T.head, fontSize: 14, lineHeight: 20, color: C.sub },
  tag: { ...T.head, alignSelf: 'flex-start', fontSize: 13, lineHeight: 19, color: C.sub, backgroundColor: C.leaf, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 2 },
  prompt: { ...T.head, fontSize: 19, lineHeight: 29, color: C.ink },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, padding: 12, borderRadius: 16, borderWidth: 2, borderColor: C.line, backgroundColor: C.card },
  optChosen: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  optAnswer: { borderColor: C.accentDark, backgroundColor: C.okBg },
  mark: { ...T.button, width: 22, fontSize: 18, color: C.accentDark },
  optText: { ...T.body, flex: 1, fontSize: 16, lineHeight: 24, color: C.ink },
  fb: { borderRadius: 16, padding: 14, gap: 6 },
  fbTitle: { ...T.head, fontSize: 17, lineHeight: 24, color: C.ink },
  themeTitle: { ...T.head, fontSize: 17, lineHeight: 24, color: C.ink },
  badge: { ...T.head, alignSelf: 'flex-start', fontSize: 14, lineHeight: 20, color: C.accentDark, backgroundColor: C.okBg, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  badgeCheck: { color: C.ink, backgroundColor: C.hintBg },
});
