import type { RenderObject } from '../evaluate';
import { finite, number as n, unit } from './svg';

/** Shared dimensions and reveal timing for both SVG and Canvas. */
export const SHAPE_STYLE = {
  minimumArrowHead: 10,
  arrowHeadStrokeWidths: 3,
  arrowHeadSpread: 0.45,
  arrowHeadWriteStart: 0.8,
  numberlineTicks: 11,
  tickHalfLength: 6,
} as const;

export type ShapeGeometry =
  | { kind: 'circle'; radiusX: number; radiusY: number }
  | { kind: 'rectangle'; width: number; height: number; radius: number }
  | { kind: 'path'; path: string }
  | { kind: 'arrow' | 'numberline'; length: number; angle: number; head: number; spread: number };

export function shapeGeometry(item: RenderObject): ShapeGeometry | null {
  const { state: s, object: { kind } } = item;
  const width = finite(s.width), height = finite(s.height);
  switch (kind) {
    case 'circle': return { kind, radiusX: Math.abs(width) / 2, radiusY: Math.abs(height) / 2 };
    case 'rectangle': return { kind, width: Math.abs(width), height: Math.abs(height), radius: Math.max(0, Math.min(finite(s.cornerRadius), Math.abs(width) / 2, Math.abs(height) / 2)) };
    case 'path': return { kind, path: `M0 0 C${n(s.path.c1.x)} ${n(s.path.c1.y)} ${n(s.path.c2.x)} ${n(s.path.c2.y)} ${n(width)} ${n(height)}` };
    case 'arrow':
    case 'numberline': {
      const length = Math.hypot(width, height);
      const head = Math.min(length, Math.max(SHAPE_STYLE.minimumArrowHead, Math.max(0, finite(s.strokeWidth)) * SHAPE_STYLE.arrowHeadStrokeWidths));
      return { kind, length, angle: Math.atan2(height, width) * 180 / Math.PI, head, spread: head * SHAPE_STYLE.arrowHeadSpread };
    }
    default: return null;
  }
}

export function arrowHeadProgress(progress: number): number {
  return unit((progress - SHAPE_STYLE.arrowHeadWriteStart) / (1 - SHAPE_STYLE.arrowHeadWriteStart));
}

export function numberlineTickProgress(progress: number, index: number): number {
  return unit(progress * SHAPE_STYLE.numberlineTicks - index);
}

export function arrowHeadPath(shape: Extract<ShapeGeometry, { kind: 'arrow' | 'numberline' }>): string {
  return `M${n(shape.length - shape.head)} ${n(-shape.spread)} L${n(shape.length)} 0 L${n(shape.length - shape.head)} ${n(shape.spread)}`;
}

export function numberlineTickPath(length: number, index: number): string {
  return `M${n(length * index / (SHAPE_STYLE.numberlineTicks - 1))} ${-SHAPE_STYLE.tickHalfLength} V${SHAPE_STYLE.tickHalfLength}`;
}
