// Web専用: 同梱した Noto Sans JP (OFL, 改変なし) を標準のCSS @font-face で宣言し、独自名 CertGarden Sans として使う。
// FontFace API には依存しない。style要素は1回だけ head へ追加し、失敗してもアプリは止めない（theme.ts のOS書体へ落ちる）。
export const WEB_FONT_FAMILY = 'CertGarden Sans';
export const WEB_FONT_URL = '/fonts/NotoSansJP-VF.ttf';
export const WEB_FONT_STYLE_ID = 'certgarden-sans-font-face';

export function loadWebFont(): void {
  try {
    const doc = (globalThis as any).document;
    if (!doc?.head || doc.getElementById(WEB_FONT_STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = WEB_FONT_STYLE_ID;
    style.textContent =
      `@font-face{font-family:"${WEB_FONT_FAMILY}";src:url("${WEB_FONT_URL}") format("truetype");` +
      'font-weight:100 900;font-style:normal;font-display:swap;}';
    doc.head.appendChild(style);
    // 診断用: 読み込み結果だけを style 要素の data 属性に残す（画面には出さない）。glyph の見た目の確認ではない。
    const set = (k: string, v: string) => style.setAttribute(`data-load-${k}`, v);
    if (typeof doc.fonts?.load !== 'function') {
      set('state', 'unsupported');
      return;
    }
    set('state', 'pending');
    doc.fonts.load(`400 17px "${WEB_FONT_FAMILY}"`, '512通り').then(
      (faces: any[]) => {
        set('state', 'resolved');
        set('count', String(faces.length));
        set('face-status', faces.map((f) => `${f?.weight}:${f?.status}`).join(','));
      },
      (e: unknown) => {
        set('state', 'rejected');
        set('error', String(e));
      },
    );
  } catch {
    // 宣言できなくても本体は動かす
  }
}
