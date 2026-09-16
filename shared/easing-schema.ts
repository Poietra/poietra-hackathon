import { z } from 'zod';

const coordinate = z.number().finite().min(0).max(1);

/** Timing curves use normalized time/progress coordinates, not Scene pixels. */
export const CubicBezierEasingSchema = z.object({
  type: z.literal('cubicBezier'),
  x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate,
}).strict();

export const EasingSchema = z.union([
  z.enum(['linear', 'easeInOut', 'easeIn', 'easeOut']),
  CubicBezierEasingSchema,
]);
