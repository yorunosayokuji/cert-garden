const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64urlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function b64Decode(text: string): Uint8Array | null {
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** 256bit乱数のtoken。prefix は種別の目印(ログ/誤貼り付け検知)で秘密ではない */
export function randomToken(prefix: string): string {
  return `${prefix}_${b64urlEncode(randomBytes(32))}`;
}

export function randomId(prefix: string): string {
  return `${prefix}_${b64urlEncode(randomBytes(16))}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 長さ非依存に近い定数時間比較（ハッシュ同士の比較用） */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function aesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [usage]);
}

/** AES-256-GCM。aad(ユーザーID)を束ね、別ユーザー行への差し替えを復号失敗にする */
export async function encryptSecret(keyRaw: Uint8Array, plain: string, aad: string): Promise<{ ct: string; iv: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, await aesKey(keyRaw, 'encrypt'), enc.encode(plain));
  return { ct: b64urlEncode(new Uint8Array(ct)), iv: b64urlEncode(iv) };
}

export async function decryptSecret(keyRaw: Uint8Array, ct: string, iv: string, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(iv) as BufferSource, additionalData: enc.encode(aad) },
    await aesKey(keyRaw, 'decrypt'),
    b64urlDecode(ct) as BufferSource,
  );
  return new TextDecoder().decode(pt);
}
