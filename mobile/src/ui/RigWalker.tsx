import { useMemo } from 'react';
import { drawList, restRigPose, rigPoseAt } from './gaitRig.ts';
import { RigView } from './RigView';

interface Props {
  /** 0〜29。moving=false のときは使わず、中立の立ち姿 */
  frame: number;
  moving: boolean;
  scale: number;
  ground: { x: number; y: number };
  flip?: boolean;
  label?: string;
}

/** 関節から作る歩行の1体。30姿勢と休憩の立ち姿は同じパーツ・同じ倍率・同じ床線 */
export function RigWalker({ frame, moving, scale, ground, flip, label }: Props) {
  const items = useMemo(() => drawList(moving ? rigPoseAt(frame) : restRigPose()), [frame, moving]);
  return <RigView items={items} scale={scale} ground={ground} flip={flip} label={label} />;
}
