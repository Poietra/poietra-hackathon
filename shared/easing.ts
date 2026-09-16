export type PresetEasing = 'linear' | 'easeInOut' | 'easeIn' | 'easeOut';

/** Unit-square control points for a time (x) → progress (y) curve. */
export interface CubicBezierEasing {
  type: 'cubicBezier';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Easing = PresetEasing | CubicBezierEasing;

export const DEFAULT_CUSTOM_EASING: CubicBezierEasing = Object.freeze({ type: 'cubicBezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });

export function isValidEasing(value: unknown): value is Easing {
  if (typeof value === 'string') return ['linear', 'easeInOut', 'easeIn', 'easeOut'].includes(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const curve = value as Record<string, unknown>;
  const keys = Object.keys(curve);
  return keys.length === 5 && keys.every(key => ['type', 'x1', 'y1', 'x2', 'y2'].includes(key)) && curve.type === 'cubicBezier' && ['x1', 'y1', 'x2', 'y2'].every(key => typeof curve[key] === 'number' && Number.isFinite(curve[key]) && curve[key] >= 0 && curve[key] <= 1);
}

/** Shared documents recreate object values; equality must not depend on identity. */
export function easingsEqual(a: Easing | null | undefined, b: Easing | null | undefined): boolean {
  if (a === b) return true;
  return !!a && !!b && typeof a === 'object' && typeof b === 'object' && a.type === b.type && a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}
