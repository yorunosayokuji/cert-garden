import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

/** OS 標準の「Appleでサインイン」ボタン（対応していない端末では何も出さない）。見た目はシステムが描く */
export function AppleButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    AppleAuthentication.isAvailableAsync().then((v) => alive && setOk(v), () => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!ok) return null;
  return (
    <AppleAuthentication.AppleAuthenticationButton
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
      cornerRadius={14}
      onPress={disabled ? () => undefined : onPress}
      style={[styles.btn, disabled && { opacity: 0.4 }]}
    />
  );
}

const styles = StyleSheet.create({ btn: { height: 48, width: '100%' } });
