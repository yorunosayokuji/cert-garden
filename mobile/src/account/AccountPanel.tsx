import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, H } from '../ui/common';
import { C, T } from '../ui/theme';
import { AppleButton } from './AppleButton';
import { FAIL_TEXT, UNSUPPORTED_TEXT, UPLOAD_SCOPE, deleteDoneText, labelKeys } from './messages';
import type { AccountService, LocalStatus, RestoreResult, UploadResult } from './service.ts';

type Choice = { kind: 'cloudHasData' | 'otherAccount' | 'conflict' } | null;
type Step = 'none' | 'restore' | 'delete';

function useAccountState(s: AccountService) {
  return useSyncExternalStore((cb) => s.subscribe(cb), () => s.getState());
}
function useBusy(s: AccountService) {
  return useSyncExternalStore((cb) => s.subscribe(cb), () => s.isBusy());
}
/** 結果の通知はサービスが持つ（復元・ログインで画面が作り直されても消えない） */
function useNotice(s: AccountService) {
  return useSyncExternalStore((cb) => s.subscribe(cb), () => s.getNotice());
}

/**
 * アカウント（手帳の「せってい」の下）。ログインしなくても学習・箱庭・無料復習は使える。
 * クラウドへの保存・復元は本人の操作だけ。別端末のデータの自動上書き・自動の送信はしない。
 */
export function AccountPanel({ service }: { service: AccountService }) {
  const state = useAccountState(service);
  const busy = useBusy(service);
  const msg = useNotice(service);
  const setMsg = useCallback((s: string | null) => service.setNotice(s), [service]);
  const [choice, setChoice] = useState<Choice>(null);
  const [step, setStep] = useState<Step>('none');
  /** Appleの連携解除に一時失敗した後だけ出す、別の選択（本人が選んだ時だけ使う） */
  const [forceOffer, setForceOffer] = useState(false);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [undo, setUndo] = useState<'none' | 'previous' | 'toGuest'>('none');

  useEffect(() => {
    void service.init();
  }, [service]);
  // 状態・処理中・通知が変わるたびに、端末の世代の記録から「取り消せるか」と未送信かを問い合わせ直す（画面を作り直しても・再起動しても分かる）
  useEffect(() => {
    if (state.phase !== 'signedIn') {
      setStatus(null);
      setUndo('none');
      return;
    }
    let alive = true;
    void service.localStatus().then((s) => alive && setStatus(s));
    void service.undoKind().then((k) => alive && setUndo(k));
    return () => {
      alive = false;
    };
  }, [service, state, busy, msg]);

  const fail = (r: { kind: string }) => setMsg((FAIL_TEXT as Record<string, string>)[r.kind] ?? FAIL_TEXT.unknown);

  const signIn = useCallback(
    async (p: 'google' | 'apple') => {
      setMsg(null);
      const r = await service.signIn(p);
      if (!r.ok) fail(r);
      else setMsg('ログインしました。');
    },
    [service],
  );

  const upload = useCallback(
    async (overwrite = false) => {
      setMsg(null);
      setChoice(null);
      setStep('none');
      const r: UploadResult = await service.upload({ overwrite });
      if (r.ok) setMsg(r.replayed ? 'すでに保存されています。' : 'クラウドに保存しました。');
      else if (r.kind === 'needsChoice') setChoice({ kind: r.reason });
      else if (r.kind === 'conflict') setChoice({ kind: 'conflict' });
      else if (r.kind === 'nothing') setMsg('保存できるデータがまだありません。');
      else if (r.kind === 'invalidLocal') setMsg(`この端末の「${labelKeys(r.keys)}」を読めないため、送りませんでした。データはそのまま残しています。`);
      else if (r.kind === 'tooLarge') setMsg(`「${labelKeys(r.keys)}」が大きすぎて送れません。`);
      else fail(r);
    },
    [service],
  );

  const restore = useCallback(async () => {
    setMsg(null);
    setChoice(null);
    setStep('none');
    const r: RestoreResult = await service.restore({ confirmed: true });
    if (r.ok) setMsg('クラウドから復元しました。ゲストのデータは残っていて、ログアウトすると元のまま見えます。「復元を元に戻す」でも戻せます。');
    else if (r.kind === 'noCloudData') setMsg('クラウドにはまだ保存がありません。');
    else if (r.kind === 'invalidCloud' || r.kind === 'incompleteCloud') setMsg(`クラウドの「${labelKeys(r.keys)}」を使えないため、復元しませんでした。この端末のデータは変えていません。`);
    else if (r.kind === 'writeFailed') setMsg('この端末への書き込みに失敗しました。この端末のデータは変えていません。もう一度ためせます。');
    else fail(r);
  }, [service]);

  const doUndo = useCallback(async () => {
    const r = await service.undoRestore();
    setMsg(r.ok ? '復元を元に戻しました。' : '元に戻せませんでした。');
  }, [service]);

  const logout = useCallback(async () => {
    setMsg(null);
    setChoice(null);
    setStep('none');
    const r = await service.logout();
    setMsg(r.ok ? 'ログアウトしました。この端末のゲストのデータは残っています。' : 'この端末のログイン情報を消せませんでした。アプリを再起動するとログイン状態に戻る場合があります。');
  }, [service]);

  const del = useCallback(
    async (force: boolean) => {
      setMsg(null);
      setStep('none');
      setForceOffer(false);
      const r = await service.deleteAccount({ forceWithoutAppleRevocation: force });
      if (r.ok) setMsg(deleteDoneText(r.appleRevocation, r.localCleanup));
      else {
        fail(r);
        if (r.kind === 'revokeFailed') setForceOffer(true);
      }
    },
    [service],
  );

  return (
    <Card>
      <H>アカウント</H>
      {state.phase === 'loading' ? <Body sub>確認中です…</Body> : null}
      {state.phase === 'unsupported' ? <Body sub>{UNSUPPORTED_TEXT[state.reason]}ログインしなくても、学習・箱庭・無料復習は使えます。</Body> : null}
      {state.phase === 'unconfigured' ? (
        <View style={{ gap: 4 }}>
          <Body sub>ログインはまだ設定されていません。ログインしなくても、学習・箱庭・無料復習は使えます。</Body>
          {state.reasons.map((r) => (
            <Text key={r} style={styles.reason}>{r}</Text>
          ))}
        </View>
      ) : null}
      {state.phase === 'signedOut' ? (
        <View style={{ gap: 8 }}>
          {state.notice === 'sessionExpired' ? <Body>ログインの有効期限が切れました。もう一度ログインしてください。</Body> : null}
          {state.notice === 'appleRevoked' ? <Body>Appleでこのアプリのサインインが解除されたため、ログアウトしました。この端末のデータは残っています。</Body> : null}
          <Body sub>ログインしなくても、学習・箱庭・無料復習は使えます。ログインすると、保存をクラウドに送って別の端末へ戻せます。</Body>
          <AppleButton onPress={() => void signIn('apple')} disabled={busy} />
          <Button label="Googleでログイン" kind="secondary" onPress={() => void signIn('google')} disabled={busy} />
        </View>
      ) : null}
      {state.phase === 'signedIn' ? (
        <View style={{ gap: 8 }}>
          <Body>{state.provider === 'apple' ? 'Appleでログイン中' : 'Googleでログイン中'}</Body>
          <View accessibilityLiveRegion="polite">
            <Body sub>{status === null ? '確認中…' : status.dirty === null ? 'クラウドへ未送信です。' : status.dirty ? 'この端末に未送信の変更があります。' : '最後に送った内容から変わっていません。'}</Body>
          </View>
          <Body sub>{UPLOAD_SCOPE}</Body>
          <Button label="クラウドに保存" onPress={() => void upload(false)} disabled={busy} />
          <Button label="クラウドから復元" kind="secondary" onPress={() => { setChoice(null); setStep('restore'); }} disabled={busy} />
          {undo !== 'none' ? (
            <View style={{ gap: 4 }}>
              <Button label="復元を元に戻す" kind="secondary" onPress={() => void doUndo()} disabled={busy} />
              <Body sub>{undo === 'toGuest' ? '復元する前のゲストのデータに戻ります。' : 'ひとつ前の復元の内容に戻ります。'}</Body>
            </View>
          ) : null}
          <Button label="ログアウト" kind="secondary" onPress={() => void logout()} disabled={busy} />
          <Button label="アカウントを削除" kind="quiet" onPress={() => { setChoice(null); setForceOffer(false); setStep('delete'); }} disabled={busy} />
        </View>
      ) : null}

      {step === 'restore' ? (
        <View style={styles.box}>
          <Body>クラウドの内容をこのアカウント用にこの端末へ取り込みます。途中の学習もクラウドの内容になります。ゲストのデータは変わらず、ログアウトすると元のまま見えます。</Body>
          <Button label="置き換える" onPress={() => void restore()} disabled={busy} />
          <Button label="やめる" kind="quiet" onPress={() => setStep('none')} disabled={busy} />
        </View>
      ) : null}
      {step === 'delete' ? (
        <View style={styles.box}>
          <Body>クラウドのデータとログイン情報を削除します。この端末のゲストのデータは残り、このアカウント用に取り込んだコピーは消えます。もう一度ログインして確認します。</Body>
          <Button label="削除する" onPress={() => void del(false)} disabled={busy} />
          <Button label="やめる" kind="quiet" onPress={() => setStep('none')} disabled={busy} />
        </View>
      ) : null}
      {forceOffer && state.phase === 'signedIn' ? (
        <View style={styles.box}>
          <Body>Appleとの連携を解除できなかったため、何も削除していません。もう一度ためすか、連携の解除を後にして削除できます。後にする場合は、削除のあとで端末の設定からこのアプリのAppleでサインインを自分で停止してください。どちらも、もう一度ログインして確認します。</Body>
          <Button label="もう一度削除する" onPress={() => void del(false)} disabled={busy} />
          <Button label="連携の解除を後にして削除する" kind="secondary" onPress={() => void del(true)} disabled={busy} />
          <Button label="やめる" kind="quiet" onPress={() => setForceOffer(false)} disabled={busy} />
        </View>
      ) : null}
      {choice?.kind === 'cloudHasData' ? (
        <View style={styles.box}>
          <Body>クラウドにすでに保存があります。この端末の内容で上書きすると、クラウド側の内容は失われます。</Body>
          <Button label="クラウドの内容で置き換える" onPress={() => { setChoice(null); setStep('restore'); }} disabled={busy} />
          <Button label="この端末で上書きする" kind="secondary" onPress={() => void upload(true)} disabled={busy} />
          <Button label="やめる" kind="quiet" onPress={() => setChoice(null)} disabled={busy} />
        </View>
      ) : null}
      {choice?.kind === 'otherAccount' ? (
        <View style={styles.box}>
          <Body>この端末のデータは、別のアカウントで使っていたものです。このアカウントのクラウドへ送りますか？</Body>
          <Button label="このアカウントへ送る" onPress={() => void upload(true)} disabled={busy} />
          <Button label="やめる" kind="quiet" onPress={() => setChoice(null)} disabled={busy} />
        </View>
      ) : null}
      {choice?.kind === 'conflict' ? (
        <View style={styles.box}>
          <Body>別の端末で保存が更新されています。自動では上書きしません。</Body>
          <Button label="クラウドの内容で置き換える" onPress={() => { setChoice(null); setStep('restore'); }} disabled={busy} />
          <Button label="この端末で上書きする" kind="secondary" onPress={() => void upload(true)} disabled={busy} />
          <Button label="やめる" kind="quiet" onPress={() => setChoice(null)} disabled={busy} />
        </View>
      ) : null}
      {busy ? (
        <View accessibilityLiveRegion="polite" accessibilityState={{ busy: true }}>
          <Body sub>処理中です…</Body>
        </View>
      ) : null}
      {msg ? (
        <Text style={styles.msg} accessibilityLiveRegion="polite" accessibilityRole="alert">
          {msg}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8, borderTopWidth: 1.5, borderTopColor: C.line, paddingTop: 10 },
  msg: { ...T.head, fontSize: 15, lineHeight: 22, color: C.ink },
  reason: { ...T.body, fontSize: 13, lineHeight: 19, color: C.sub },
});
