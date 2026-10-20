import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyValue } from './kv.ts';
import { LayoutStore, starterLayout, type Layout } from './furniture.ts';

/** 家具の配置。学習コアの hook とは分け、別キーに保存する。保存に成功した時だけ画面へ反映し、壊れた保存は上書きしない */
export function useLayout(kv: KeyValue, onNotice: (message: string) => void) {
  const store = useMemo(() => new LayoutStore(kv), [kv]);
  const [layout, setLayout] = useState<Layout>(() => starterLayout());
  const corruptRef = useRef(false);
  const layoutRef = useRef(layout);
  const busyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    store.load().then(
      (r) => {
        if (!alive) return;
        corruptRef.current = r.corrupt;
        layoutRef.current = r.layout;
        setLayout(r.layout);
        if (r.corrupt) onNotice('家具の配置の保存データを読めません。データはそのまま残し、はじめの配置で表示しています。');
      },
      () => {
        if (!alive) return;
        corruptRef.current = true;
        onNotice('家具の配置を読み込めませんでした。はじめの配置で表示しています。');
      },
    );
    return () => {
      alive = false;
    };
  }, [store, onNotice]);

  const save = useCallback(async (next: Layout): Promise<boolean> => {
    if (busyRef.current) return false;
    if (corruptRef.current) {
      onNotice('家具の配置の保存データが壊れているため、変更を保存できません。データはそのまま残してあります。');
      return false;
    }
    busyRef.current = true;
    try {
      await store.save(next);
      layoutRef.current = next;
      setLayout(next);
      return true;
    } catch {
      onNotice('家具の配置を保存できませんでした。もう一度ためしてください。');
      return false;
    } finally {
      busyRef.current = false;
    }
  }, [store, onNotice]);

  return { layout, save };
}
