// ID token の中の nonce を、送る前に確かめるだけの補助（署名の検証ではない。検証は必ずサーバー側）。
// nonce が載らない・別の値なら、サーバーに送る前に止めて「確認できなかった」にする。

export function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = (globalThis as { atob?: (x: string) => string }).atob?.(b64);
  if (bin === undefined) throw new Error('atob が使えません');
  // UTF-8 として解釈
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function idTokenNonce(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const p = JSON.parse(decodeBase64Url(parts[1])) as { nonce?: unknown };
    return typeof p.nonce === 'string' ? p.nonce : undefined;
  } catch {
    return undefined;
  }
}
