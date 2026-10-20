// Web ではネイティブのログインに対応しない。token を localStorage / AsyncStorage に入れる代用はしない。
// 状態は常に「未対応(web)」で、通信もしない。
import type { KeyValue } from '../state/kv.ts';
import type { GenerationKv } from './backup.ts';
import { createAccountService } from './factory.ts';
import type { IdpPort } from './service.ts';
import { MemorySecureKv } from './session.ts';

const none: IdpPort = { isAvailable: async () => false, signIn: async () => ({ kind: 'unavailable' }) };

export function createNativeAccount(data: GenerationKv, meta: KeyValue) {
  return createAccountService({
    runtime: 'web',
    env: { apiBaseUrl: undefined, googleIosClientId: undefined, isDev: false },
    fetch: () => Promise.reject(new Error('web では使いません')),
    secure: new MemorySecureKv(), // 使われない（状態が unsupported のため init でも読まない）
    installMarker: meta,
    data,
    meta,
    idp: { google: none, apple: none },
    now: Date.now,
    newId: () => 'web',
  });
}
