import type { RenderObject } from '../evaluate';
import { arrowHeadPath, arrowHeadProgress, numberlineTickPath, numberlineTickProgress, SHAPE_STYLE, shapeGeometry, type ShapeGeometry } from './shape-geometry';
import { color, finite, number as n, unit } from './svg';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const UTF16_BYTES_PER_CHARACTER = 2;

export interface ShapeDrawing {
  readonly key: string;
  /** Logical geometry source bytes; Path2D's internal allocation is not measurable. */
  readonly sourceBytes: number;
  /** Draw in local Scene coordinates; the caller applies bounds and output scaling. */
  paint(context: CanvasRenderingContext2D, item: RenderObject): void;
}

interface Outline {
  path: Path2D;
  length: number;
}

function pathLength(data: string): number {
  const element = document.createElementNS(SVG_NAMESPACE, 'path');
  element.setAttribute('d', data);
  const length = element.getTotalLength();
  if (!Number.isFinite(length)) throw new Error('Unsupported shape length.');
  return length;
}

function measuredPath(data: string): Outline {
  return { path: new Path2D(data), length: pathLength(data) };
}

function outline(shape: ShapeGeometry): Outline {
  switch (shape.kind) {
    case 'circle': {
      const x = n(shape.radiusX), y = n(shape.radiusY);
      if (Number(x) === 0 || Number(y) === 0) return { path: new Path2D(), length: 0 };
      const length = pathLength(`M${x} 0 A${x} ${y} 0 1 1 ${n(-shape.radiusX)} 0 A${x} ${y} 0 1 1 ${x} 0 Z`);
      const path = new Path2D();
      path.ellipse(0, 0, Number(x), Number(y), 0, 0, Math.PI * 2);
      path.closePath();
      return { path, length };
    }
    case 'rectangle': {
      if (Number(n(shape.width)) === 0 || Number(n(shape.height)) === 0) return { path: new Path2D(), length: 0 };
      const x = shape.width / 2, y = shape.height / 2, r = shape.radius;
      if (r === 0) return measuredPath(`M${n(-x)} ${n(-y)} H${n(x)} V${n(y)} H${n(-x)} Z`);
      return measuredPath(`M${n(-x + r)} ${n(-y)} H${n(x - r)} A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(-y + r)} V${n(y - r)} A${n(r)} ${n(r)} 0 0 1 ${n(x - r)} ${n(y)} H${n(-x + r)} A${n(r)} ${n(r)} 0 0 1 ${n(-x)} ${n(y - r)} V${n(-y + r)} A${n(r)} ${n(r)} 0 0 1 ${n(-x + r)} ${n(-y)} Z`);
    }
    case 'path': return measuredPath(shape.path);
    case 'arrow':
    case 'numberline': return { path: new Path2D(`M0 0 H${n(shape.length)}`), length: Number(n(shape.length)) };
  }
}

function strokeOutline(context: CanvasRenderingContext2D, drawing: Outline, progress: number) {
  context.setLineDash(progress < 1 && drawing.length > 0 ? [drawing.length, drawing.length] : []);
  context.lineDashOffset = progress < 1 ? (1 - progress) * drawing.length : 0;
  context.stroke(drawing.path);
}

/** Each object owns at most 13 paths (a numberline's shaft, head, and 11 ticks). */
export function prepareShapeDrawing(item: RenderObject, previous?: ShapeDrawing): ShapeDrawing | null {
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return null;
  const shape = shapeGeometry(item);
  if (!shape) return null;
  const key = JSON.stringify(shape);
  if (previous?.key === key) return previous;
  try {
    const drawing = outline(shape);
    const head = shape.kind === 'arrow' || shape.kind === 'numberline' ? new Path2D(arrowHeadPath(shape)) : null;
    const ticks = shape.kind === 'numberline' ? Array.from({ length: SHAPE_STYLE.numberlineTicks }, (_, index) => new Path2D(numberlineTickPath(shape.length, index))) : [];
    return {
      key, sourceBytes: key.length * UTF16_BYTES_PER_CHARACTER,
      paint(context, current) {
        const progress = unit(current.writeProgress);
        if (progress === 0) return;
        const fill = color(current.state.fill), stroke = color(current.state.stroke);
        const strokeWidth = Math.max(0, finite(current.state.strokeWidth));
        context.save();
        try {
          const opacity = context.globalAlpha;
          // Invalid fill/stroke values use the SVG initial paint, never prior Canvas state.
          context.fillStyle = '#000000';
          context.strokeStyle = 'transparent';
          context.fillStyle = fill;
          context.strokeStyle = stroke;
          context.lineCap = 'round';
          context.lineJoin = 'round';
          if (strokeWidth > 0) context.lineWidth = strokeWidth;
          if (shape.kind === 'arrow' || shape.kind === 'numberline') context.rotate(Number(n(shape.angle)) * Math.PI / 180);
          if ((shape.kind === 'circle' || shape.kind === 'rectangle') && fill.toLowerCase() !== 'none') {
            context.globalAlpha = opacity * progress;
            context.fill(drawing.path);
          }
          if (stroke.toLowerCase() !== 'none' && strokeWidth > 0) {
            context.globalAlpha = opacity;
            strokeOutline(context, drawing, progress);
            context.setLineDash([]);
            context.lineDashOffset = 0;
            for (const [index, tick] of ticks.entries()) {
              context.globalAlpha = opacity * numberlineTickProgress(progress, index);
              context.stroke(tick);
            }
            if (head) {
              context.globalAlpha = opacity * arrowHeadProgress(progress);
              context.stroke(head);
            }
          }
        } finally { context.restore(); }
      },
    };
  } catch { return null; }
}
