import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { AccountPanel } from '../account/AccountPanel';
import type { AccountService } from '../account/service.ts';
import { Home } from '../ui/Home';
import { LearnTab } from '../ui/LearnTab';
import type { LabTab } from '../ui/MotionLab.tsx';
import { NotebookTab, ShopTab } from '../ui/Tabs';
import { Reveal } from '../ui/motion';
import type { CompareSettings } from './namespace.ts';
import type { SkeletonKind } from './compare.ts';
import { LoadFailure, LoadView } from './Skeletons';
import { MOTION } from './Press';
import type { GardenRuntime } from './useGardenRuntime';

export type ScreenKind = 'home' | 'learn' | 'notebook' | 'shop';

export interface UiCtx {
  rt: GardenRuntime;
  cfg: CompareSettings;
  /** 起動の読み込み表示中（実際の準備＋比較用の最低表示） */
  bootVisible: boolean;
  /** 読込失敗後の再試行 */
  retry: () => void;
  /** キーボードを避ける時の、画面上端から製品領域までの高さ */
  keyboardOffset: number;
  /** 動きの見くらべを開く。比較の入口だけが渡す（製品は undefined ＝ 箱庭に「新しい動き」を出さない） */
  openLab?: (tab: LabTab) => void;
  /** ログイン・クラウド保存（手帳の「せってい」の下） */
  account: AccountService;
  /** 比較用: 読み込み表示を固定している画面（null なら固定なし） */
  pin: SkeletonKind | null;
  /** ホームバー等の下端の安全領域 */
  bottomInset: number;
}

/** 4つの内容画面。読み込み中はその画面に対応する骨組み(または通常ローダー)、失敗は再試行、準備が整えば本物の画面に置き換える */
export function TabScreen({ kind, ctx, homeChrome = 'standard', extraBottom = 0 }: { kind: ScreenKind; ctx: UiCtx; homeChrome?: 'standard' | 'overlay'; extraBottom?: number }) {
  const { rt, cfg, bootVisible } = ctx;
  const { c } = rt;
  if (bootVisible || ctx.pin === kind) return <LoadView kind={kind as SkeletonKind} skeleton={cfg.skeleton} />;
  if (c.boot.kind === 'error') return <LoadFailure message={c.boot.message} onRetry={ctx.retry} busy={false} />;
  const bottomInset = extraBottom;
  let body = null;
  if (kind === 'home' && c.snapshot) {
    body = (
      <Home
        snapshot={c.snapshot}
        room={c.room}
        roster={c.roster}
        layout={rt.furniture.layout}
        onSaveLayout={rt.furniture.save}
        reduceMotion={rt.reduceMotion}
        onRoom={(r) => void c.saveRoom(r)}
        onOpenLab={ctx.openLab}
        chrome={homeChrome}
        plainNote
      />
    );
  } else if (kind === 'learn' && c.snapshot) {
    body = (
      <LearnTab
        snapshot={c.snapshot}
        resumable={c.resumable}
        busy={c.busy || rt.starting}
        onStart={(q, t, m) => void rt.startLearn(q, t, m)}
        onResume={() => void rt.startLearn()}
        onReview={(q, m) => void rt.startReview(q, m)}
        onClaim={(k) => void c.claimMission(k)}
        qual={rt.learnQual.qual}
        onQual={rt.learnQual.setQual}
        holds={rt.holds.holds()}
        onRelease={(id) => void rt.holds.release(id)}
        diag={rt.diag.summary}
        onDiag={rt.diag.open}
        onDiagDismiss={rt.diag.dismiss}
        bottomInset={bottomInset}
      />
    );
  } else if (kind === 'notebook') {
    body = (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={ctx.keyboardOffset} style={{ flex: 1 }}>
        <NotebookTab snapshot={c.snapshot} entries={c.notebook} error={c.notebookError} settings={c.settings} onSave={c.saveNotebook} onSettings={(v) => void c.saveSettings(v)} bottomInset={bottomInset} footer={<AccountPanel service={ctx.account} />} />
      </KeyboardAvoidingView>
    );
  } else if (kind === 'shop') {
    body = (
      <ShopTab
        roster={c.roster}
        snapshot={c.snapshot}
        busy={c.busy}
        onBuy={(id) => void c.buyFurniture(id)}
        onSlot={(s, id) => void c.chooseSlot(s, id)}
        onCompanion={(id) => void c.chooseCompanion(id)}
        bottomInset={bottomInset}
      />
    );
  }
  return (
    <Reveal key={kind} ms={MOTION.screen} dx={0} style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>{body}</View>
    </Reveal>
  );
}
