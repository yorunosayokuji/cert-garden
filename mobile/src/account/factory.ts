// AccountService を組み立てる（RN/Expo に依存しない部分）。native.ts が実ポートを渡し、試験は偽ポートを渡す。
import type { KeyValue } from '../state/kv.ts';
import { ApiClient, type FetchLike, type Provider } from './api.ts';
import type { GenerationKv } from './backup.ts';
import { resolveAccountConfig, sessionScope, type AccountEnv, type RuntimeKind } from './config.ts';
import type { SecureKv } from './session.ts';
import { SessionStore } from './session.ts';
import { AccountService, type AccountState, type IdpPort } from './service.ts';

export interface FactoryInput {
  /** 実行環境。native 以外（Web・Android・Expo Go）は未対応で、通信もしない */
  runtime: RuntimeKind;
  env: AccountEnv;
  /** bundle ID（公開してよい識別子）。session の接続先の組に含める */
  bundleId?: string | null;
  fetch: FetchLike;
  secure: SecureKv;
  /** アプリを消すと消える保存（install の目印・閉じた印用）。比較の名前空間とも本体とも別 */
  installMarker: KeyValue;
  data: GenerationKv;
  meta: KeyValue;
  idp: Record<Provider, IdpPort>;
  lifecycle?: { onActive(cb: () => void): () => void };
  now: () => number;
  newId: () => string;
  idpTimeoutMs?: number;
}

/** 状態の決め方: 未対応の環境/設定が足りなければ未設定（成功を偽らない）。ゲストで学習・箱庭は常に使える */
export function createAccountService(i: FactoryInput): AccountService {
  const cfg = resolveAccountConfig(i.env);
  let initial: Extract<AccountState, { phase: 'unsupported' | 'unconfigured' }> | null = null;
  if (i.runtime === 'web') initial = { phase: 'unsupported', reason: 'web' };
  else if (i.runtime === 'expoGo') initial = { phase: 'unsupported', reason: 'expoGo' };
  else if (i.runtime === 'platform') initial = { phase: 'unsupported', reason: 'platform' };
  else if (cfg.status === 'unconfigured') initial = { phase: 'unconfigured', reasons: cfg.reasons };
  const api = new ApiClient({ baseUrl: cfg.status === 'ready' ? cfg.apiBaseUrl : 'https://invalid.invalid', fetch: i.fetch });
  const scope = sessionScope({ apiBaseUrl: cfg.apiBaseUrl, googleIosClientId: cfg.googleIosClientId, bundleId: i.bundleId ?? null });
  return new AccountService({
    api,
    sessions: new SessionStore(i.secure, i.installMarker, i.newId, scope),
    data: i.data,
    meta: i.meta,
    idp: i.idp,
    now: i.now,
    newId: i.newId,
    newRequestId: () => i.newId().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).padEnd(8, '0'),
    ...(i.lifecycle ? { lifecycle: i.lifecycle } : null),
    ...(i.idpTimeoutMs ? { idpTimeoutMs: i.idpTimeoutMs } : null),
    initial,
  });
}
