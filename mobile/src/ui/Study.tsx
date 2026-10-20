import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { QUALIFICATIONS, REASON_LABEL, REPORT_REASONS, type ReferenceView, type ReportReason } from '../../../src/mobile.ts';
import type { Session } from '../state/controller';
import type { CharacterId } from '../state/characters';
import { Body, Button } from './common';
import { StudyCompanion, type Reaction } from './Companion';
import { AnimatedFill, Reveal } from './motion';
import { C, MAX_W, T } from './theme';

interface Props {
  session: Session;
  companion: CharacterId;
  reduceMotion: boolean;
  reaction: Reaction | null;
  busy: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onConfirm: () => void;
  /** 数字入力の答え合わせ。形式エラーなら理由の文（記録は進まない）、受け付けたら null */
  onSubmitNumber: (text: string) => Promise<string | null>;
  /** この問題が気になる記録（理由は任意）と保留。この端末だけに保存し、成功したら true */
  onReport: (reason: ReportReason | null, memo: string, hold: boolean) => Promise<boolean>;
  /** この問題はすでに自分の学習で保留中 */
  isHeld: boolean;
  onDontKnow: () => void;
  onHint: () => void;
  onNext: () => void;
}

/** 「問題が気になる」。理由と任意メモを、この端末だけに記録する。誰にも送らず、人が直すとも約束しない */
/**
 * 「解説の参考」。確定後のフィードバックにだけ出す折りたたみ。資料名・該当箇所・確認日・役割・確認の範囲を日本語で示す。
 * 出題範囲の確認元は正解の証拠ではない。リンクは押したときだけ https を開く（事前の取得・自動送信はしない）。
 */
export function SourcesPanel({ refs }: { refs: ReferenceView }) {
  const [open, setOpen] = useState(false);
  const openUrl = (url: string | null) => {
    if (url && url.startsWith('https://')) void Linking.openURL(url).catch(() => undefined);
  };
  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel="解説の参考" style={styles.reportLink}>
        <Text style={styles.reportLinkText}>{open ? '▼ 解説の参考（とじる）' : '▶ 解説の参考'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.reportBox}>
          {refs.sources.length === 0 ? <Body sub>この問題に結び付けた参考資料はありません。</Body> : null}
          {refs.sources.map((s, i) => (
            <View key={i} style={{ gap: 2 }}>
              <Text style={styles.reportTitle}>{s.title}</Text>
              <Body sub>{s.roleLabel}{s.section ? `　該当箇所: ${s.section}` : ''}　確認日 {s.checked}</Body>
              <Body sub>{s.scopeNote}</Body>
              {s.url ? (
                <Pressable onPress={() => openUrl(s.url)} accessibilityRole="link" accessibilityLabel={`${s.title}を開く（外部のページ）`} style={styles.reportLink}>
                  <Text style={styles.reportLinkText}>資料を開く（外部のページ）</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          {refs.note ? <Body sub>{refs.note}</Body> : null}
          <Body sub>{refs.checkNote}</Body>
          <Body sub>教材の版: {refs.contentVersion}　資料の年度や範囲と、この問題の答えの正しさは別のことです。</Body>
        </View>
      ) : null}
    </View>
  );
}

export function ReportPanel({ held, onRecord }: { held: boolean; onRecord: (reason: ReportReason | null, memo: string, hold: boolean) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [memo, setMemo] = useState('');
  const [hold, setHold] = useState(false);
  const [done, setDone] = useState<{ held: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  if (done) {
    return (
      <View accessibilityLiveRegion="polite" style={{ gap: 4 }}>
        <Body sub>記録しました（この端末だけ。誰にも送られません）。</Body>
        {done.held ? <Body sub>この問題は次のステージから出なくなります。いまのステージはこのまま続きます。解除は「学ぶ」の「教材について」からできます。</Body> : null}
      </View>
    );
  }
  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="この問題が気になる" style={styles.reportLink}>
        <Text style={styles.reportLinkText}>{held ? '保留中の問題です（詳しく記録する）' : '問題が気になる'}</Text>
      </Pressable>
    );
  }
  const canSave = !saving && (reason !== null || hold);
  return (
    <View style={styles.reportBox}>
      <Text style={styles.reportTitle}>この問題が気になる</Text>
      <Body sub>この端末にだけ記録します。誰にも送られません。人が確認・修正するわけではありません。</Body>
      <View style={styles.reasonRow} accessibilityRole="radiogroup">
        {REPORT_REASONS.map((r) => (
          <Pressable
            key={r}
            onPress={() => setReason(reason === r ? null : r)}
            role="radio"
            aria-checked={reason === r}
            accessibilityRole="radio"
            accessibilityState={{ checked: reason === r }}
            accessibilityLabel={REASON_LABEL[r]}
            style={[styles.reason, reason === r && styles.reasonOn]}
          >
            <Text style={styles.reasonText}>{REASON_LABEL[r]}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput value={memo} onChangeText={setMemo} placeholder="メモ（任意）" placeholderTextColor={C.sub} multiline maxLength={200} accessibilityLabel="メモ（任意）" style={styles.memo} />
      <Pressable onPress={() => setHold(!hold)} role="checkbox" aria-checked={hold} accessibilityRole="checkbox" accessibilityState={{ checked: hold }} accessibilityLabel="この問題を自分の学習で保留する" style={styles.holdRow}>
        <Text style={styles.reasonText}>{hold ? '☑' : '☐'} この問題を自分の学習で保留する（次のステージから出ません）</Text>
      </Pressable>
      <Button
        label="記録する"
        onPress={async () => {
          setSaving(true);
          const ok = await onRecord(reason, memo, hold);
          setSaving(false);
          if (ok) setDone({ held: hold });
        }}
        disabled={!canSave}
        hint={canSave ? undefined : '理由を選ぶか、保留にチェックを入れてください'}
      />
      <Button label="やめる" kind="quiet" onPress={() => setOpen(false)} disabled={saving} />
    </View>
  );
}

const FEEDBACK_TITLE = {
  correct: '正解！',
  hint_correct: 'ヒントを使って 正解！',
  wrong: 'ここを覚えておこう',
  unknown: 'いっしょに確認しよう',
} as const;

export function Study({ session, companion, reduceMotion, reaction, busy, onClose, onSelect, onConfirm, onSubmitNumber, onReport, isHeld, onDontKnow, onHint, onNext }: Props) {
  const { width } = useWindowDimensions();
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const qid = session.view.question?.id;
  useEffect(() => {
    setText('');
    setInputError(null);
  }, [qid]);
  const submitText = async () => {
    const err = await onSubmitNumber(text);
    setInputError(err);
  };
  const W = Math.min(width, MAX_W);
  const v = session.view;
  const q = v.question;
  const qual = QUALIFICATIONS.find((x) => x.id === session.qualificationId);
  const pct = v.progress.total > 0 ? Math.round((v.progress.index / v.progress.total) * 100) : 0;
  const inQuestion = (v.phase === 'core' || v.phase === 'recheck') && q;
  const feedback = v.qState === 'feedback' ? v.feedback : undefined;
  const numeric = q?.input;
  const correctText = feedback ? (feedback.input ? feedback.input.correctAnswer : q?.options.find((o) => o.id === feedback.correctOptionId)?.text) : undefined;
  const good = feedback?.outcome === 'correct' || feedback?.outcome === 'hint_correct';

  return (
    <View style={[styles.root, { width: W }]}>
      {/* 上部は葉の帯。閉じる・資格名・短い進捗 */}
      <View style={styles.header}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="閉じる（途中までを保存して戻ります）" style={styles.close}>
          <Text style={styles.closeText}>×</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.qual} numberOfLines={1}>{qual?.name ?? '学習'}{session.kind === 'review' ? '（おさらい）' : ''}</Text>
          <View
            style={styles.bar}
            accessibilityRole="progressbar"
            accessibilityLabel={`進み具合 ${v.progress.index}問目、全${v.progress.total}問`}
            accessibilityValue={{ min: 0, max: v.progress.total, now: v.progress.index }}
            aria-valuemin={0}
            aria-valuemax={v.progress.total}
            aria-valuenow={v.progress.index}
          >
            <AnimatedFill pct={pct} style={styles.barFill} />
          </View>
        </View>
        <Text style={styles.count}>{v.progress.index}/{v.progress.total}</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
        {v.phase === 'intro' ? (
          <Reveal key="intro" style={styles.panel}>
            <Text accessibilityRole="header" style={styles.panelTitle}>{session.title}</Text>
            <Text style={styles.prompt}>{session.intro}</Text>
          </Reveal>
        ) : null}
        {v.phase === 'explain' ? (
          <Reveal key="explain" style={styles.panel}>
            <Text accessibilityRole="header" style={styles.panelTitle}>まず、ポイント</Text>
            {session.explanation.map((p, i) => (
              <Text key={i} style={styles.prompt}>{p}</Text>
            ))}
          </Reveal>
        ) : null}
        {inQuestion ? (
          <Reveal key={`q-${v.phase}-${q.id}`} style={{ gap: 8 }}>
            {v.phase === 'recheck' ? (
              <Text style={styles.tag}>{v.recall === 'later' ? 'おさらい：日をおいて思い出す問題' : 'ふりかえり：同じ日の確認（定着の判定ではありません）'}</Text>
            ) : null}
            <Text style={styles.prompt} accessibilityRole="header">{q.prompt}</Text>
          </Reveal>
        ) : null}

        {/* 選択肢のすぐ上の棚。ここだけキャラが過ごす */}
        <StudyCompanion id={companion} reduceMotion={reduceMotion} reaction={reaction} />

        {inQuestion ? (
          <>
            <Reveal key={`o-${v.phase}-${q.id}`} style={{ gap: 10 }}>
              {numeric ? (
                <View style={{ gap: 6 }}>
                  <Text style={styles.tag}>数字だけを入力します{numeric.unit ? `（単位は「${numeric.unit}」）` : ''}</Text>
                  <TextInput
                    value={text}
                    onChangeText={(t) => { setText(t); setInputError(null); }}
                    editable={!feedback && !busy}
                    inputMode="decimal"
                    autoCorrect={false}
                    autoCapitalize="none"
                    placeholder="例: 8"
                    placeholderTextColor={C.sub}
                    onSubmitEditing={() => { if (!feedback && text.trim() !== '' && !busy) void submitText(); }}
                    accessibilityLabel={`こたえの数字${numeric.unit ? `、単位は${numeric.unit}` : ''}`}
                    style={[styles.numInput, inputError ? styles.numInputErr : null]}
                  />
                  {inputError ? <Text accessibilityLiveRegion="polite" style={styles.numErr}>{inputError}</Text> : null}
                  {feedback?.input?.entered ? <Text style={styles.tag}>あなたの答え: {feedback.input.entered}{numeric.unit}</Text> : null}
                </View>
              ) : null}
              <View style={{ gap: 10 }} accessibilityRole="radiogroup">
                {q.options.map((o) => {
                  const chosen = q.selectedOptionId === o.id;
                  const isAnswer = feedback?.correctOptionId === o.id;
                  const locked = !!feedback;
                  return (
                    <Pressable
                      key={o.id}
                      disabled={locked}
                      onPress={() => onSelect(o.id)}
                      role="radio"
                      accessibilityRole="radio"
                      accessibilityState={{ checked: chosen, disabled: locked }}
                      aria-checked={chosen}
                      aria-disabled={locked}
                      accessibilityLabel={`${o.text}${chosen ? '、選択中' : ''}${isAnswer ? '、正しい答え' : ''}`}
                      style={[styles.opt, chosen && styles.optChosen, isAnswer && styles.optAnswer]}
                    >
                      <Text style={styles.mark}>{isAnswer ? '✓' : chosen ? '●' : '○'}</Text>
                      <Text style={styles.optText}>{o.text}</Text>
                      {isAnswer ? <Text style={styles.optNote}>正しい答え</Text> : chosen && locked ? <Text style={styles.optNote}>あなたの答え</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            </Reveal>
            {session.hint && !feedback ? (
              <Reveal ms={150} dx={0} style={styles.hintBox}>
                <View accessibilityLiveRegion="polite" style={{ gap: 4 }}>
                  <Text style={styles.hintTitle}>ヒント</Text>
                  <Body>{session.hint}</Body>
                </View>
              </Reveal>
            ) : null}
            {feedback ? (
              <Reveal key={`f-${q.id}`} ms={150} dx={0} style={[styles.fb, { backgroundColor: good ? C.okBg : C.gentleBg }]}>
                <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
                  <Text style={styles.fbTitle}>{FEEDBACK_TITLE[feedback.outcome]}</Text>
                  {feedback.outcome === 'wrong' || feedback.outcome === 'unknown' ? <Body>こたえは「{correctText}」</Body> : null}
                  {feedback.whyWrong ? <Body>{feedback.whyWrong}</Body> : null}
                  <Body>{feedback.explanation}</Body>
                  {feedback.references ? <SourcesPanel key={`s-${q.id}`} refs={feedback.references} /> : null}
                  <ReportPanel key={q.id} held={isHeld} onRecord={onReport} />
                </View>
              </Reveal>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        {inQuestion && !feedback ? (
          <>
            <Button
              label="答え合わせ"
              onPress={numeric ? () => void submitText() : onConfirm}
              disabled={busy || (numeric ? text.trim() === '' : q.selectedOptionId === null)}
              hint={numeric ? (text.trim() === '' ? '先に数字を入力してください' : undefined) : q.selectedOptionId === null ? '先に選択肢を選んでください' : undefined}
            />
            <View style={styles.row}>
              <Button label={q.hintShown ? 'ヒントを見る（使用済み）' : 'ヒント'} kind="secondary" onPress={onHint} disabled={busy} style={{ flex: 1 }} />
              <Button label="わからない" kind="secondary" onPress={onDontKnow} disabled={busy} style={{ flex: 1 }} />
            </View>
          </>
        ) : (
          <Button label="つぎへ" onPress={onNext} disabled={busy} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignSelf: 'center', backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: C.leaf, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
  close: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  closeText: { ...T.head, fontSize: 28, color: C.ink },
  qual: { ...T.head, fontSize: 13, lineHeight: 19, color: C.sub, marginBottom: 2 },
  bar: { height: 10, borderRadius: 5, backgroundColor: '#fffaf0', overflow: 'hidden' },
  barFill: { height: 10, borderRadius: 5, backgroundColor: C.accent },
  count: { ...T.head, fontSize: 13, lineHeight: 19, color: C.ink, minWidth: 40, textAlign: 'right', paddingRight: 8 },
  content: { padding: 12, gap: 12 },
  panel: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1.5, borderColor: C.line, padding: 16, gap: 10 },
  panelTitle: { ...T.head, fontSize: 19, lineHeight: 28, color: C.ink },
  tag: { ...T.head, alignSelf: 'flex-start', fontSize: 13, lineHeight: 19, color: C.sub },
  prompt: { ...T.head, fontSize: 19, lineHeight: 28, fontWeight: '600', color: C.ink },
  // 枠は常に2px。選択は色と薄い塗りだけで示し、レイアウトを動かさない
  opt: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderWidth: 2, borderColor: C.line, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  optChosen: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  optAnswer: { borderColor: C.accent, backgroundColor: C.okBg },
  mark: { ...T.body, fontSize: 18, width: 24, textAlign: 'center', color: C.ink },
  optText: { ...T.body, flex: 1, fontSize: 17, lineHeight: 24, color: C.ink },
  optNote: { ...T.head, fontSize: 13, lineHeight: 19, color: C.accentDark },
  numInput: { minHeight: 56, borderWidth: 2, borderColor: C.line, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#fff', ...T.body, fontSize: 22, lineHeight: 30, color: C.ink },
  numInputErr: { borderColor: C.warn },
  numErr: { ...T.head, fontSize: 14, lineHeight: 20, color: C.warn },
  reportLink: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  reportLinkText: { ...T.head, fontSize: 14, lineHeight: 20, color: C.sub, textDecorationLine: 'underline' },
  reportBox: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1.5, borderColor: C.line, padding: 12, gap: 8 },
  reportTitle: { ...T.head, fontSize: 16, lineHeight: 23, color: C.ink },
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  reason: { minHeight: 44, paddingHorizontal: 12, borderRadius: 14, borderWidth: 2, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  reasonOn: { borderColor: C.accentDark, backgroundColor: C.chosenBg },
  reasonText: { ...T.body, fontSize: 14, lineHeight: 20, color: C.ink },
  memo: { minHeight: 56, borderWidth: 2, borderColor: C.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#fff', ...T.body, fontSize: 15, lineHeight: 22, color: C.ink },
  holdRow: { minHeight: 44, justifyContent: 'center' },
  hintBox: { backgroundColor: C.hintBg, borderRadius: 18, padding: 14 },
  hintTitle: { ...T.head, fontSize: 13, lineHeight: 19, color: C.warn },
  fb: { borderRadius: 18, padding: 14 },
  fbTitle: { ...T.head, fontSize: 19, lineHeight: 28, color: C.ink },
  actions: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, gap: 4, backgroundColor: C.bg },
  row: { flexDirection: 'row', gap: 8 },
});
