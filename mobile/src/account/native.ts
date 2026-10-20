// native（iOS）の実ポート: Keychain(SecureStore)、Apple 標準サインイン、Google は Expo AuthSession の一般 OIDC
// （Code + PKCE(S256) + state + nonce を ASWebAuthenticationSession で）。実 OAuth クライアント・実機・署名ビルドでの動作は未確認。
// 無料の RN Google Sign-In (Original) は iOS の nonce が有料版のみのため使わない。
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { AppState, Platform } from 'react-native';
import { asyncKv } from '../state/asyncKv';
import type { KeyValue } from '../state/kv.ts';
import type { GenerationKv } from './backup.ts';
import { classifyRuntime, resolveAccountConfig } from './config.ts';
import { GOOGLE_DISCOVERY, GOOGLE_SCOPES, googleRedirectUri } from './config.ts';
import { createAccountService } from './factory.ts';
import { idTokenNonce } from './jwt.ts';
import type { CredentialState, IdpOutcome, IdpPort } from './service.ts';
import type { SecureKv } from './session.ts';

const SECURE_OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const keychain: SecureKv = {
  get: (k) => SecureStore.getItemAsync(k, SECURE_OPTS),
  set: (k, v) => SecureStore.setItemAsync(k, v, SECURE_OPTS),
  remove: (k) => SecureStore.deleteItemAsync(k, SECURE_OPTS),
};

/** Google: AuthRequest(code, PKCE S256, state, nonce) → ASWebAuthenticationSession → 標準のトークン交換で id_token */
export function googleIdp(clientId: string): IdpPort {
  return {
    isAvailable: async () => Platform.OS === 'ios',
    async signIn(nonce): Promise<IdpOutcome> {
      try {
        const redirectUri = googleRedirectUri(clientId);
        const request = new AuthSession.AuthRequest({
          clientId,
          redirectUri,
          scopes: [...GOOGLE_SCOPES],
          responseType: AuthSession.ResponseType.Code,
          usePKCE: true,
          codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
          extraParams: { nonce },
        });
        const result = await request.promptAsync(GOOGLE_DISCOVERY);
        if (result.type === 'cancel' || result.type === 'dismiss' || result.type === 'locked') return { kind: 'cancelled' };
        if (result.type === 'error') return { kind: 'denied' };
        if (result.type !== 'success' || !result.params.code || !request.codeVerifier) return { kind: 'error' };
        const tokens = await AuthSession.exchangeCodeAsync(
          { clientId, code: result.params.code, redirectUri, extraParams: { code_verifier: request.codeVerifier } },
          GOOGLE_DISCOVERY,
        );
        // 送る前の確認だけ（署名の検証はサーバー）。nonce が載っていない/違うトークンは使わない
        if (!tokens.idToken || idTokenNonce(tokens.idToken) !== nonce) return { kind: 'error' };
        return { kind: 'success', idToken: tokens.idToken };
      } catch {
        return { kind: 'error' };
      }
    },
  };
}

/** Apple: OS 標準の sign in。サーバーの nonce と state を渡し、identityToken と authorizationCode を返す */
export const appleIdp: IdpPort = {
  isAvailable: async () => Platform.OS === 'ios' && (await AppleAuthentication.isAvailableAsync().catch(() => false)),
  async signIn(nonce): Promise<IdpOutcome> {
    try {
      const state = Crypto.randomUUID();
      const cred = await AppleAuthentication.signInAsync({ requestedScopes: [], nonce, state });
      if (!cred.identityToken || !cred.authorizationCode || cred.state !== state) return { kind: 'error' };
      return { kind: 'success', idToken: cred.identityToken, authorizationCode: cred.authorizationCode, ...(cred.user ? { appleUser: cred.user } : null) };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ERR_REQUEST_CANCELED') return { kind: 'cancelled' };
      if (code === 'ERR_REQUEST_NOT_HANDLED' || code === 'ERR_REQUEST_FAILED' || code === 'ERR_INVALID_RESPONSE') return { kind: 'denied' };
      return { kind: 'error' };
    }
  },
  // TN3194: 起動/前面復帰の照会と、OS の失効通知。照会が例外（シミュレーター・一時的な不調）なら呼び出し側は失効扱いにしない
  async credentialState(user): Promise<CredentialState> {
    const s = await AppleAuthentication.getCredentialStateAsync(user);
    if (s === AppleAuthentication.AppleAuthenticationCredentialState.REVOKED) return 'revoked';
    if (s === AppleAuthentication.AppleAuthenticationCredentialState.NOT_FOUND) return 'notFound';
    if (s === AppleAuthentication.AppleAuthenticationCredentialState.TRANSFERRED) return 'transferred';
    return 'authorized';
  },
  onRevoked(cb) {
    const sub = AppleAuthentication.addRevokeListener(cb);
    return () => sub.remove();
  },
};

const unavailable: IdpPort = { isAvailable: async () => false, signIn: async () => ({ kind: 'unavailable' }) };

/** 起動 URL から戻ってきた認証セッションを閉じる（native では何もしないが、Expo の推奨呼び出し） */
WebBrowser.maybeCompleteAuthSession();

export function createNativeAccount(data: GenerationKv, meta: KeyValue) {
  const env = {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    isDev: __DEV__,
  };
  const cfg = resolveAccountConfig(env);
  const runtime = classifyRuntime({ platform: Platform.OS, executionEnvironment: Constants.executionEnvironment, appOwnership: Constants.appOwnership });
  return createAccountService({
    runtime,
    env,
    bundleId: Constants.expoConfig?.ios?.bundleIdentifier ?? null,
    lifecycle: {
      onActive(cb) {
        const sub = AppState.addEventListener('change', (s) => {
          if (s === 'active') cb();
        });
        return () => sub.remove();
      },
    },
    fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }),
    secure: keychain,
    installMarker: asyncKv,
    data,
    meta,
    idp: { google: cfg.status === 'ready' ? googleIdp(cfg.googleIosClientId) : unavailable, apple: appleIdp },
    now: Date.now,
    newId: () => Crypto.randomUUID(),
  });
}
