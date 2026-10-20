// Web 用: 96×76 の低解像度 canvas へパーツを合成し、画面では image-rendering: pixelated で拡大する。
// 原PNGは加工せず、描画時の切り抜きと変形だけ。imageSmoothingEnabled=false。
// ブラウザ globalThis は描画時（effect内）にだけ参照し、import 時には触れない（native/Expo の起動で落ちない）。
import { Asset } from 'expo-asset';
import { createElement, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RIG_ANCHOR, RIG_CANVAS, type DrawItem } from './gaitRig.ts';
import { RIG_IMAGE } from './motionStudyAssets';
import type { RigViewProps } from './RigView';

let atlasPromise: Promise<any> | null = null;

function loadAtlas(): Promise<any> {
  if (atlasPromise) return atlasPromise;
  atlasPromise = new Promise((resolve, reject) => {
    const ImageCtor = (globalThis as any).Image;
    if (!ImageCtor) {
      reject(new Error('no Image'));
      return;
    }
    // react-native-web の Image には resolveAssetSource が無いので、expo-asset 経由で dev/export どちらでも実在URLを得る
    let uri: string | undefined;
    try {
      uri = Asset.fromModule(RIG_IMAGE as any).uri;
    } catch (e) {
      atlasPromise = null;
      reject(e);
      return;
    }
    if (!uri) {
      atlasPromise = null;
      reject(new Error('rig image uri unresolved'));
      return;
    }
    const img = new ImageCtor();
    img.onload = () => resolve(img);
    img.onerror = () => {
      atlasPromise = null;
      reject(new Error(`rig image failed to load: ${uri}`));
    };
    img.src = uri;
  });
  return atlasPromise;
}

function paint(canvas: any, img: any, items: DrawItem[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, RIG_CANVAS[0], RIG_CANVAS[1]);
  ctx.imageSmoothingEnabled = false;
  for (const it of items) {
    const [rx, ry, rw, rh] = it.rect;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(it.pivot[0], it.pivot[1]);
    ctx.rotate(it.rot);
    ctx.scale(it.scale, it.scale);
    ctx.drawImage(img, rx, ry, rw, rh, -it.pivotSrc[0], -it.pivotSrc[1], rw, rh);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function RigView({ items, scale: s, ground, flip, label }: RigViewProps) {
  const [cw, ch] = RIG_CANVAS;
  const ref = useRef<any>(null);
  const latest = useRef(items);
  latest.current = items;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadAtlas().then(
      (img) => {
        if (alive && ref.current) paint(ref.current, img, latest.current);
      },
      (e) => {
        // 黙殺しない: コンソールに出し、画面にも読込失敗を示す（アプリは止めない）
        console.error('RigView: 関節歩行の画像を読み込めない', e);
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [items]);
  const ax = flip ? cw - RIG_ANCHOR.x : RIG_ANCHOR.x;
  return (
    <View
      pointerEvents="none"
      accessible={!!label}
      accessibilityLabel={label}
      accessibilityRole={label ? 'image' : undefined}
      style={[styles.box, { left: ground.x - ax * s, top: ground.y - RIG_ANCHOR.y * s, width: cw * s, height: ch * s }, flip ? { transform: [{ scaleX: -1 }] } : null]}
    >
      {createElement('canvas', { ref, width: cw, height: ch, style: { width: cw * s, height: ch * s, display: 'block', imageRendering: 'pixelated' } })}
      {failed ? <Text style={styles.err}>画像を読み込めません</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', overflow: 'hidden' },
  err: { position: 'absolute', left: 2, top: 2, fontSize: 10, color: '#b00020' },
});
