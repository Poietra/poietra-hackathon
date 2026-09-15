import { EQUATION_WRITE_STROKE_UNITS, equationFillProgress, equationGlyphProgress, type Equation } from './equations';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// Path2D does not expose its native memory size. Larger equations keep the SVG route.
const MAX_GLYPHS = 2048;
const MAX_SOURCE_BYTES = 1024 * 1024;
const UTF16_BYTES_PER_CHARACTER = 2;

type MathNode = Equation['tree'];
type Paint = { fill: boolean; stroke: boolean; strokeWidth: number | null };
type Geometry = { path: Path2D; length: number; rectangle?: { x: number; y: number; width: number; height: number } };
type Glyph = Geometry & {
  transform: DOMMatrix;
  complete: Paint;
  writing: Paint;
};

export interface EquationDrawing {
  /** Serialized UTF-16 source size; Path2D's internal allocation is not measurable. */
  readonly sourceBytes: number;
  readonly glyphCount: number;
  /** Draw in MathJax coordinates; the caller applies equation centering and output scale. */
  paint(context: CanvasRenderingContext2D, progress: number, order: 'together' | 'sequential', color: string): void;
}

function numericAttribute(node: MathNode, name: string, fallback: number): number {
  const source = node.attributes[name];
  if (source === undefined) return fallback;
  const value = Number(source);
  if (!source.trim() || !Number.isFinite(value)) throw new Error('Unsupported equation geometry.');
  return value;
}

function nodePaint(node: MathNode, inherited: Paint): Paint {
  const { fill, stroke } = node.attributes;
  if ([fill, stroke].some(value => value !== undefined && value !== 'none' && value !== 'currentColor')) {
    throw new Error('Unsupported equation paint.');
  }
  const strokeWidth = node.attributes['stroke-width'] === undefined ? inherited.strokeWidth : numericAttribute(node, 'stroke-width', 0);
  if (strokeWidth !== null && strokeWidth < 0) throw new Error('Unsupported equation stroke.');
  return {
    fill: fill === undefined ? inherited.fill : fill !== 'none',
    stroke: stroke === undefined ? inherited.stroke : stroke !== 'none',
    strokeWidth,
  };
}

function nodeTransform(node: MathNode, parent: DOMMatrix): DOMMatrix {
  const source = node.attributes.transform;
  if (!source) return parent;
  // Let the SVG parser handle MathJax's transform lists and number separators.
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('transform', source);
  const local = group.transform.baseVal.consolidate()?.matrix;
  if (!local) throw new Error('Unsupported equation transform.');
  const result = parent.multiply(local);
  if (![result.a, result.b, result.c, result.d, result.e, result.f].every(Number.isFinite)) {
    throw new Error('Unsupported equation transform.');
  }
  return result;
}

function createGeometry(node: MathNode): Geometry {
  let element: SVGGeometryElement;
  let path: Path2D;
  if (node.tag === 'path' && node.attributes.d) {
    element = document.createElementNS(SVG_NAMESPACE, 'path');
    element.setAttribute('d', node.attributes.d);
    path = new Path2D(node.attributes.d);
  } else if (node.tag === 'rect') {
    const x = numericAttribute(node, 'x', 0), y = numericAttribute(node, 'y', 0);
    const width = numericAttribute(node, 'width', 0), height = numericAttribute(node, 'height', 0);
    // MathJax uses unrounded rectangles for fraction bars and rules.
    if (width <= 0 || height <= 0 || numericAttribute(node, 'rx', 0) !== 0 || numericAttribute(node, 'ry', 0) !== 0) {
      throw new Error('Unsupported equation rectangle.');
    }
    path = new Path2D();
    path.rect(x, y, width, height);
    // Unlike paths, detached SVG rects cannot be measured in Chrome. Their perimeter is exact.
    return { path, length: 2 * (width + height), rectangle: { x, y, width, height } };
  } else {
    throw new Error('Unsupported equation glyph.');
  }
  const length = element.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) throw new Error('Unsupported equation path length.');
  return { path, length };
}

function paintGlyphs(context: CanvasRenderingContext2D, glyphs: Glyph[], progress: number, order: 'together' | 'sequential', color: string) {
  context.save();
  try {
    // Invalid CSS colors fall back to SVG's initial currentColor rather than old Canvas state.
    context.fillStyle = '#000000';
    context.strokeStyle = '#000000';
    context.fillStyle = color;
    context.strokeStyle = color;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const opacity = context.globalAlpha;
    for (const [index, glyph] of glyphs.entries()) {
      const amount = equationGlyphProgress(progress, order, glyphs.length, index);
      if (amount === 0) continue;
      const writing = amount < 1;
      const paint = writing ? glyph.writing : glyph.complete;
      const fillOpacity = writing ? equationFillProgress(amount) : 1;
      context.save();
      try {
        const matrix = glyph.transform;
        context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
        if (paint.fill && fillOpacity > 0) {
          context.globalAlpha = opacity * fillOpacity;
          if (glyph.rectangle) {
            // Match SVG rect antialiasing, which differs from filling a rectangular path.
            const { x, y, width, height } = glyph.rectangle;
            context.fillRect(x, y, width, height);
          } else context.fill(glyph.path);
        }
        if (paint.stroke && paint.strokeWidth !== null && paint.strokeWidth > 0) {
          context.globalAlpha = opacity;
          context.lineWidth = paint.strokeWidth;
          context.setLineDash(writing ? [glyph.length, glyph.length] : []);
          context.lineDashOffset = writing ? (1 - amount) * glyph.length : 0;
          context.stroke(glyph.path);
        }
      } finally { context.restore(); }
    }
  } finally { context.restore(); }
}

/** Prepare only the MathJax primitives we can reproduce; unsupported trees retain SVG rendering. */
export function prepareEquationDrawing(equation: Equation): EquationDrawing | null {
  if (typeof document === 'undefined' || typeof Path2D === 'undefined' || typeof DOMMatrix === 'undefined') return null;
  if (equation.glyphs <= 0 || equation.glyphs > MAX_GLYPHS) return null;
  try {
    const sourceBytes = JSON.stringify(equation.tree).length * UTF16_BYTES_PER_CHARACTER;
    if (sourceBytes > MAX_SOURCE_BYTES) return null;
    const glyphs: Glyph[] = [];
    const paths = new Map<string, Geometry>();
    function visit(node: MathNode, parent: DOMMatrix, inherited: Paint) {
      const transform = nodeTransform(node, parent);
      const complete = nodePaint(node, inherited);
      if (node.tag === 'g') {
        for (const child of node.children) visit(child, transform, complete);
        return;
      }
      if (node.children.length) throw new Error('Unsupported equation glyph children.');
      // An unresolved width comes from ObjectState; keep SVG rather than guess its value.
      if (complete.stroke && complete.strokeWidth === null) throw new Error('Inherited equation stroke width.');
      const pathData = node.tag === 'path' ? node.attributes.d : undefined;
      const geometry = (pathData && paths.get(pathData)) || createGeometry(node);
      if (pathData) paths.set(pathData, geometry);
      // The partial-glyph wrapper overrides inherited stroke, then the leaf overrides it.
      const writing = nodePaint(node, { ...inherited, stroke: true, strokeWidth: EQUATION_WRITE_STROKE_UNITS });
      glyphs.push({ ...geometry, transform, complete, writing });
    }
    visit(equation.tree, new DOMMatrix(), { fill: true, stroke: false, strokeWidth: null });
    if (glyphs.length !== equation.glyphs) return null;
    return {
      sourceBytes, glyphCount: glyphs.length,
      paint: (context, progress, order, color) => paintGlyphs(context, glyphs, progress, order, color),
    };
  } catch { return null; }
}
