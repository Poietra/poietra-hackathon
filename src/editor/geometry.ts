import type { ObjectState } from '../../shared/model';

export interface Point { x: number; y: number }
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
export const CORNER_SIGNS: Record<ResizeCorner, Point> = {
  nw: { x: -1, y: -1 }, ne: { x: 1, y: -1 }, sw: { x: -1, y: 1 }, se: { x: 1, y: 1 },
};

export function rotateVector(point: Point, degrees: number): Point {
  const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return { x: point.x * c - point.y * s, y: point.x * s + point.y * c };
}

/** Shape coordinates are relative to the object's anchor, before rotation. */
export function worldToLocal(point: Point, state: Pick<ObjectState, 'x' | 'y' | 'rotation'>): Point {
  return rotateVector({ x: point.x - state.x, y: point.y - state.y }, -state.rotation);
}

export function localToWorld(point: Point, state: Pick<ObjectState, 'x' | 'y' | 'rotation'>): Point {
  const rotated = rotateVector(point, state.rotation);
  return { x: rotated.x + state.x, y: rotated.y + state.y };
}

/** Resize around the opposite corner, including when the object is rotated. */
export function resizeFromCorner(state: ObjectState, size: { width: number; height: number }, corner: ResizeCorner, delta: Point, preserveAspect: boolean, text: boolean): Partial<ObjectState> {
  const local = rotateVector(delta, -state.rotation), sign = CORNER_SIGNS[corner];
  const width = Math.max(1, size.width), height = Math.max(1, size.height);
  let nextWidth = Math.max(1, width + local.x * sign.x), nextHeight = Math.max(1, height + local.y * sign.y);
  let ratio = 1;
  if (text || preserveAspect) {
    if (text) ratio = 1 + (local.x * sign.x * width + local.y * sign.y * height) / (width * width + height * height);
    else ratio = Math.abs(local.x / width) > Math.abs(local.y / height) ? nextWidth / width : nextHeight / height;
    const lower = text ? 8 / Math.max(1, state.fontSize) : Math.max(1 / width, 1 / height);
    const upper = text ? 400 / Math.max(1, state.fontSize) : Math.min(16000 / width, 16000 / height);
    ratio = Math.max(lower, Math.min(upper, ratio));
    nextWidth = width * ratio; nextHeight = height * ratio;
  } else {
    nextWidth = Math.min(16000, nextWidth); nextHeight = Math.min(16000, nextHeight);
  }
  const center = rotateVector({ x: sign.x * (nextWidth - width) / 2, y: sign.y * (nextHeight - height) / 2 }, state.rotation);
  return {
    x: state.x + center.x, y: state.y + center.y,
    width: text ? state.width * ratio : nextWidth,
    height: text ? state.height * ratio : nextHeight,
    ...(text ? { fontSize: state.fontSize * ratio } : {}),
  };
}

export function rotationFromPointer(state: Pick<ObjectState, 'x' | 'y' | 'rotation'>, start: Point, at: Point, snap: boolean): number {
  const a = Math.atan2(start.y - state.y, start.x - state.x), b = Math.atan2(at.y - state.y, at.x - state.x);
  let rotation = state.rotation + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * 180 / Math.PI;
  if (snap) rotation = Math.round(rotation / 15) * 15;
  return ((rotation + 180) % 360 + 360) % 360 - 180;
}
