export const POSES = ['idle', 'sleep', 'roll', 'cheer', 'encourage', 'celebrate'] as const;
export type Pose = (typeof POSES)[number];

interface ManifestLike {
  assets: unknown;
  atlas: { cellWidth: number };
}
interface AtlasEntry {
  path: string;
  cells?: { index: number; pose: string; anchor: { x: number; y: number } }[];
}

/** design-assets/manifest.json のポーズ別 anchor(足元)。無ければ中央下を仮置きする */
export function anchorFrom(manifest: ManifestLike, id: string, pose: Pose): { x: number; y: number; index: number } {
  const cell = (manifest.assets as AtlasEntry[]).find((a) => a.path === `variants/${id}-atlas-v1.png`)?.cells?.find((c) => c.pose === pose);
  const cw = manifest.atlas.cellWidth;
  if (!cell) return { x: cw / 2, y: cw * 0.9, index: POSES.indexOf(pose) };
  return { x: cell.anchor.x, y: cell.anchor.y, index: cell.index };
}
