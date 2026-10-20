import type { ReactElement } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { QUALIFICATIONS } from '../../../src/mobile.ts';
import { Complete } from '../ui/Complete';
import { Diagnostic } from '../ui/Diagnostic';
import type { LabTab } from '../ui/MotionLab.tsx';
import { Study } from '../ui/Study';
import type { UiCtx } from './Screens';
import { LoadView } from './Skeletons';

export type FlowKind = 'question' | 'result' | 'diagnostic' | 'lab';

/**
 * 全画面の学習フロー（設問・結果・初回チェック・動きの見くらべ）。本体(App.tsx)と同じ部品・同じコントローラーを使う。
 * 候補ごとに変わるのは入口とナビゲーションで、設問と採点の中身は共通。
 * skeletonOn: 設問/結果の読み込み表示中（実際の準備＋比較用の最低表示）
 */
/**
 * 動きの見くらべ（lab）の画面は、このファイルでは読み込まない。比較の入口だけが renderLab を渡す
 * （製品の依存の木・書き出しに lab の部品を入れないため）。
 */
export type RenderLab = (initialId: string, onBack: () => void) => ReactElement;

export function FlowScreen({ ctx, lab, renderLab, onCloseLab, goHome, loadingKind }: { ctx: UiCtx; lab: LabTab | null; renderLab?: RenderLab; onCloseLab: () => void; goHome: () => void; loadingKind: 'question' | 'result' | null }) {
  const { rt } = ctx;
  const { c, diag, holds } = rt;
  const wrap = (node: ReactElement) => (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={ctx.keyboardOffset} style={{ flex: 1 }}>
      <View style={{ flex: 1, paddingBottom: ctx.bottomInset }}>{node}</View>
    </KeyboardAvoidingView>
  );
  if (loadingKind) return <LoadView kind={loadingKind} skeleton={ctx.cfg.skeleton} />;
  if (c.session) {
    const s = c.session;
    if (s.view.phase === 'completed' && s.result) {
      return wrap(<Complete result={s.result} companion={c.roster.companion} reduceMotion={rt.reduceMotion} plain onHome={() => { goHome(); c.returnHome(); }} />);
    }
    return wrap(
      <Study
        session={s}
        companion={c.roster.companion}
        reduceMotion={rt.reduceMotion}
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
      />,
    );
  }
  if (diag.qual) {
    const dq = diag.qual;
    const qd = QUALIFICATIONS.find((x) => x.id === dq);
    return wrap(
      <Diagnostic
        isHeld={(id) => holds.engine.isHeld(id)}
        onReport={async (ref, reason, memo, hold) => {
          const ok = reason ? await holds.report(ref, reason, memo, hold) : hold ? await holds.hold(ref) : null;
          return ok !== null;
        }}
        companion={c.roster.companion}
        reduceMotion={rt.reduceMotion}
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
        onStartTheme={(themeId) => { diag.close(); void rt.startLearn(dq, themeId); }}
      />,
    );
  }
  if (lab && renderLab) return renderLab(c.roster.room[0] ?? 'anzu', onCloseLab);
  return null;
}

/** いま全画面のフローを出すべきか（設問の準備中・設問・結果・初回チェック・見くらべ） */
export function hasFlow(rt: UiCtx['rt'], lab: LabTab | null): boolean {
  return !!rt.c.session || !!rt.diag.qual || !!lab || rt.starting;
}
