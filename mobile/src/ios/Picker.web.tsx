// Web確認用の候補 picker。PICKER.md（design/libraries/emilkowalski-skills/skills/prototype/PICKER.md）の
// マークアップ・CSS・操作規則をそのまま使う。製品の部品ではなく、RN の木の外（document.body）へ描く。
// 製品の下タブと重ならないよう data-position="top"。候補の切り替えは即時（ハイライトだけが滑る）。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { VARIANTS, pickerKeyAction } from './compare.ts';

export const PICKER_CSS = `
.proto-picker {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(10, 10, 10, 0.82);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  backdrop-filter: blur(12px) saturate(1.4);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08) inset,
    0 8px 24px rgba(0, 0, 0, 0.24),
    0 2px 6px rgba(0, 0, 0, 0.12);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  -webkit-user-select: none;
}
.proto-picker-highlight {
  position: absolute;
  top: 4px;
  left: 0;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  will-change: transform;
}
.proto-picker[data-ready] .proto-picker-highlight {
  transition:
    transform 250ms cubic-bezier(0.23, 1, 0.32, 1),
    width 250ms cubic-bezier(0.23, 1, 0.32, 1);
}
@media (prefers-reduced-motion: reduce) {
  .proto-picker[data-ready] .proto-picker-highlight { transition: none; }
}
.proto-picker-item {
  position: relative;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  font: inherit;
  cursor: pointer;
  transition: color 150ms ease-out;
}
.proto-picker-item:hover { color: rgba(255, 255, 255, 0.85); }
.proto-picker-item:active { transform: scale(0.97); }
.proto-picker-item:focus-visible { outline: 2px solid rgba(255, 255, 255, 0.4); outline-offset: 2px; }
.proto-picker-item[data-active] { color: #fff; }
.proto-picker-divider { width: 1px; height: 16px; margin: 0 4px; background: rgba(255, 255, 255, 0.12); }
.proto-picker-replay { padding: 0 10px; font-size: 14px; }
.proto-picker[data-position="top"] { bottom: auto; top: 24px; }
`;

interface Props {
  variant: number;
  onSet: (variant: number) => void;
  onReplay: () => void;
}

export function VariantPicker({ variant, onSet, onReplay }: Props) {
  const navRef = useRef<HTMLElement | null>(null);
  const hlRef = useRef<HTMLSpanElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [ready, setReady] = useState(false);
  // 狭い画面（スマホ幅）では名前が収まらないので番号だけ。名前は aria-label と title、比較バーに出る
  const [wide, setWide] = useState(() => window.innerWidth >= 560);
  const cur = useRef(variant);
  const setRef = useRef(onSet);
  const replayRef = useRef(onReplay);
  cur.current = variant;
  setRef.current = onSet;
  replayRef.current = onReplay;

  const place = () => {
    setWide(window.innerWidth >= 560);
    const el = itemRefs.current[variant - 1];
    const hl = hlRef.current;
    if (!el || !hl) return;
    hl.style.width = `${el.offsetWidth}px`;
    hl.style.transform = `translateX(${el.offsetLeft}px)`;
  };
  useLayoutEffect(place, [variant, wide]);
  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });
  useEffect(() => {
    // 読み込み時には滑らせない（最初の描画の後で有効にする）
    let a = 0;
    let b = 0;
    a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const action = pickerKeyAction(
        { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, targetTag: t?.tagName ?? '', targetEditable: !!t?.isContentEditable },
        cur.current,
      );
      if (!action) return;
      if (action.type === 'set') setRef.current(action.variant);
      else replayRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return createPortal(
    <>
      <style>{PICKER_CSS}</style>
      <nav className="proto-picker" aria-label="Prototype variants" data-position="top" data-ready={ready ? '' : undefined} ref={navRef}>
        <span className="proto-picker-highlight" aria-hidden="true" ref={hlRef} />
        {VARIANTS.map((v, i) => (
          <button
            key={v.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className="proto-picker-item"
            data-active={variant === v.id ? '' : undefined}
            aria-current={variant === v.id ? 'true' : undefined}
            aria-label={`候補${v.id} ${v.name}`}
            title={`${v.id} ${v.name}`}
            onClick={() => onSet(v.id)}
          >
            {wide ? v.name : v.id}
          </button>
        ))}
        <span className="proto-picker-divider" aria-hidden="true" />
        <button className="proto-picker-item proto-picker-replay" aria-label="Replay animation (R)" title="Replay (R)" onClick={onReplay}>
          ↻
        </button>
      </nav>
    </>,
    document.body,
  );
}
