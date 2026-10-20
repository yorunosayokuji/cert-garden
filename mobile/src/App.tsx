import { useCallback, useEffect, useRef, useState } from 'react';
import { QUALIFICATIONS } from '../../src/mobile.ts';
import { useHolds, useLearnQual } from './state/holdsController';
import { LearnTab } from './ui/LearnTab';
import { useDiagnostic } from './state/diagnosticController';
import { useLayout } from './state/layoutController';
import { Diagnostic } from './ui/Diagnostic';
import { BackHandler, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { asyncKv } from './state/asyncKv';
import { useController } from './state/controller';
import { Body, Button, Card } from './ui/common';
import { Complete } from './ui/Complete';
import { useOsReduceMotion } from './ui/hooks';
import { ReduceMotionContext, Reveal } from './ui/motion';
import { Home } from './ui/Home';
import { MotionCheck } from './ui/MotionCheck';
import type { LabTab } from './ui/MotionLab.tsx';
import { Study } from './ui/Study';
import { NotebookTab, ShopTab } from './ui/Tabs';
import { C, MAX_W, T } from './ui/theme';

type Tab = 'home' | 'learn' | 'notebook' | 'shop';
const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: '箱庭' },
  { id: 'learn', label: '学ぶ' },
  { id: 'notebook', label: '手帳' },
  { id: 'shop', label: 'お店' },
];

export default function App() {
  // 通知の出し先は学習の状態(c)にあるが、保留(holds)は c より先に作る必要があるため ref でつなぐ
  const noticeRef = useRef<(message: string, retry?: () => void) => void>(() => undefined);
  const onDiagNotice = useCallback((message: string, retry?: () => void) => noticeRef.current(message, retry), []);
  const holds = useHolds(asyncKv, onDiagNotice);
  const c = useController(asyncKv, Date.now, undefined, holds.engine);
  const { setNotice } = c;
  noticeRef.current = (message, retry) => setNotice({ message, ...(retry ? { retry } : {}) });
  const diag = useDiagnostic(asyncKv, onDiagNotice, holds.engine);
  const learnQual = useLearnQual(asyncKv);
  void holds.tick;
  const onFurnitureNotice = useCallback((message: string) => onDiagNotice(message), [onDiagNotice]);
  const furniture = useLayout(asyncKv, onFurnitureNotice);
  const osReduce = useOsReduceMotion();
  const reduceMotion = osReduce || c.settings.reduceMotion;
  const [tab, setTab] = useState<Tab>('home');
  // 動きの見くらべ（独立画面。学習状態・保存には触れない）
  const [lab, setLab] = useState<LabTab | null>(null);

  // 端末の戻る操作: 見くらべ画面なら箱庭へ。学習中なら中断を保存して箱庭へ
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (lab) {
        setLab(null);
        return true;
      }
      if (diag.qual && !c.session) {
        diag.close();
        return true;
      }
      if (c.session) {
        if (c.session.view.phase === 'completed') { setTab('home'); c.returnHome(); }
        else c.closeStage();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [lab, c.session, c.closeStage, c.returnHome]);

  let body;
  if (c.boot.kind === 'loading') {
    body = (
      <View style={styles.center}>
        <Text style={styles.big}>箱庭をひらいています…</Text>
      </View>
    );
  } else if (c.boot.kind === 'error') {
    body = (
      <View style={[styles.center, { padding: 24, gap: 12 }]}>
        <Card>
          <Text style={styles.big}>ひらけませんでした</Text>
          <Body>{c.boot.message}</Body>
          <Body sub>保存データは書きかえていません。もう一度ためしてください。</Body>
          <Button label="もう一度ひらく" onPress={() => void c.load()} />
        </Card>
      </View>
    );
  } else if (c.session) {
    const s = c.session;
    body =
      s.view.phase === 'completed' && s.result ? (
        <Complete result={s.result} companion={c.roster.companion} reduceMotion={reduceMotion} onHome={() => { setTab('home'); c.returnHome(); }} />
      ) : (
        <Study
          session={s}
          companion={c.roster.companion}
          reduceMotion={reduceMotion}
          reaction={c.reaction}
          busy={c.busy}
          onClose={c.closeStage}
          onSelect={c.select}
          onConfirm={c.confirm}
          onSubmitNumber={c.submitNumber}
          isHeld={!!s.view.question && holds.engine.isHeld(s.view.question.id)}
          onReport={async (reason, memo, hold) => {
            const ref = c.currentQuestionRef();
            if (!ref) return false;
            const ok = reason ? await holds.report(ref, reason, memo, hold) : hold ? await holds.hold(ref) : null;
            return ok !== null;
          }}
          onDontKnow={c.dontKnow}
          onHint={c.hint}
          onNext={c.next}
        />
      );
  } else if (diag.qual) {
    const dq = diag.qual;
    const qd = QUALIFICATIONS.find((x) => x.id === dq);
    body = (
      <Diagnostic
        isHeld={(id) => holds.engine.isHeld(id)}
        onReport={async (ref, reason, memo, hold) => {
          const ok = reason ? await holds.report(ref, reason, memo, hold) : hold ? await holds.hold(ref) : null;
          return ok !== null;
        }}
        companion={c.roster.companion}
        reduceMotion={reduceMotion}
        qualName={qd ? `${qd.name}${qd.grade ? ` ${qd.grade}` : ''}` : dq}
        view={diag.view}
        latest={diag.summary(dq).latest}
        busy={diag.busy || c.busy}
        canStartTheme={!!c.snapshot && c.snapshot.fruits >= 1 && !c.resumable}
        onStart={() => diag.start(dq)}
        onSelect={diag.select}
        onConfirm={diag.confirm}
        onDontKnow={diag.dontKnow}
        onNext={diag.next}
        onClose={diag.close}
        onAbandon={() => diag.abandon(dq)}
        onStartTheme={(themeId) => { diag.close(); void c.startLearn(dq, themeId); }}
      />
    );
  } else if (lab) {
    body = <MotionCheck initialId={c.roster.room[0] ?? 'anzu'} onBack={() => setLab(null)} />;
  } else {
    body = (
      <>
        <Reveal key={tab} ms={150} dx={0} style={{ flex: 1 }}>
          {tab === 'home' && c.snapshot ? (
            <Home snapshot={c.snapshot} room={c.room} roster={c.roster} layout={furniture.layout} onSaveLayout={furniture.save} reduceMotion={reduceMotion} onRoom={(r) => void c.saveRoom(r)} onOpenLab={setLab} />
          ) : null}
          {tab === 'learn' && c.snapshot ? (
            <LearnTab snapshot={c.snapshot} resumable={c.resumable} busy={c.busy} onStart={(q, t, m) => void c.startLearn(q, t, m)} onResume={() => void c.startLearn()} onReview={(q, m) => void c.startReview(q, m)} onClaim={(k) => void c.claimMission(k)} qual={learnQual.qual} onQual={learnQual.setQual} holds={holds.holds()} onRelease={(id) => void holds.release(id)} diag={diag.summary} onDiag={diag.open} onDiagDismiss={diag.dismiss} />
          ) : null}
          {tab === 'notebook' ? (
            <NotebookTab snapshot={c.snapshot} entries={c.notebook} error={c.notebookError} settings={c.settings} onSave={c.saveNotebook} onSettings={(v) => void c.saveSettings(v)} />
          ) : null}
          {tab === 'shop' ? <ShopTab roster={c.roster} snapshot={c.snapshot} busy={c.busy} onBuy={(id) => void c.buyFurniture(id)} onSlot={(s, id) => void c.chooseSlot(s, id)} onCompanion={(id) => void c.chooseCompanion(id)} /> : null}
        </Reveal>
        <View style={styles.tabs} accessibilityRole="tablist">
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <Pressable key={t.id} onPress={() => setTab(t.id)} accessibilityRole="tab" accessibilityState={{ selected: on }} aria-selected={on} accessibilityLabel={t.label} style={styles.tab}>
                <View style={[styles.pill, on && styles.pillOn]}>
                  <Text style={[styles.tabText, on && { color: C.accentDark }]}>{t.label}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </>
    );
  }

  return (
    <ReduceMotionContext.Provider value={reduceMotion}>
    <View style={styles.page}>
      <SafeAreaView style={[styles.app, Platform.OS === 'android' && { paddingTop: StatusBar.currentHeight ?? 0 }]}>
        {c.notice ? (
          <View style={styles.notice} accessibilityLiveRegion="assertive">
            <Text style={styles.noticeText}>{c.notice.message}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {c.notice.retry ? <Button label="もう一度" kind="secondary" onPress={c.notice.retry} /> : null}
              <Button label="とじる" kind="quiet" onPress={() => c.setNotice(null)} />
            </View>
          </View>
        ) : null}
        {body}
      </SafeAreaView>
    </View>
    </ReduceMotionContext.Provider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.page, alignItems: 'center', ...(Platform.OS === 'web' ? ({ height: '100dvh' } as object) : null) },
  app: { flex: 1, width: '100%', maxWidth: MAX_W, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  big: { ...T.head, fontSize: 20, lineHeight: 28, color: C.ink },
  tabs: { flexDirection: 'row', borderTopWidth: 1.5, borderTopColor: C.line, backgroundColor: C.card, paddingVertical: 4 },
  tab: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  pill: { minHeight: 40, minWidth: 64, paddingHorizontal: 14, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  pillOn: { backgroundColor: C.chosenBg, borderColor: C.accentDark },
  tabText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.sub },
  notice: { backgroundColor: C.hintBg, padding: 10, gap: 6, borderBottomWidth: 2, borderBottomColor: C.line },
  noticeText: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink },
});
