// Web のキーボード操作用: ダイアログの焦点の閉じ込め、背景の操作停止(inert)、画面外ページの抑止。
// DOM に触る関数は Web でだけ呼ぶ。数の計算(wrapIndex)は純粋関数として試験する。

/** Tab / Shift+Tab の次の位置。範囲の外(-1)から入った時は最初(Tab)/最後(Shift+Tab)。端では反対側へ回す */
export function wrapIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

export const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
}

/** Tab を root の中で一周させる。root の外へ出さない */
export function trapTab(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const list = focusablesIn(root);
  if (list.length === 0) {
    e.preventDefault();
    root.focus({ preventScroll: true });
    return;
  }
  const at = list.indexOf(document.activeElement as HTMLElement);
  const next = wrapIndex(list.length, at, e.shiftKey);
  e.preventDefault();
  list[next]?.focus({ preventScroll: true });
}

export function setInert(el: HTMLElement | null, on: boolean): void {
  if (!el) return;
  if (on) el.setAttribute('inert', '');
  else el.removeAttribute('inert');
}

/**
 * node の外側（兄弟）を操作できなくする。製品の枠(data-product-frame)の中だけが対象で、比較用の帯や picker は止めない。
 * data-keep の要素（背景のタップで閉じる面）は止めない。戻す関数を返す。
 */
export function inertOutside(node: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let cur: HTMLElement | null = node;
  while (cur?.parentElement) {
    const parent: HTMLElement = cur.parentElement;
    for (const sib of Array.from(parent.children) as HTMLElement[]) {
      if (sib === cur || sib.hasAttribute('data-keep') || sib.hasAttribute('inert')) continue;
      sib.setAttribute('inert', '');
      changed.push(sib);
    }
    if (parent.hasAttribute('data-product-frame')) break;
    cur = parent;
  }
  return () => changed.forEach((el) => el.removeAttribute('inert'));
}
