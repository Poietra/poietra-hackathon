import type { Scene } from '../../shared/model';
import type { Frame, RenderObject } from './evaluate';
import type { ObjectBounds, SvgOptions } from './render-contract';
import { GLOW_STYLE } from './effects/glow-style';
import { EQUATION_UNITS_PER_EM, EQUATION_WRITE_STROKE_UNITS, equationMarkup, getEquation, prepareEquations } from './rendering/equations';
import { embeddedFontStyles, measureText, prepareFonts } from './rendering/fonts';
import { textMarkup } from './rendering/text-markup';
import { arrowHeadPath, arrowHeadProgress, numberlineTickPath, numberlineTickProgress, SHAPE_STYLE, shapeGeometry } from './rendering/shape-geometry';
import { color, escapeXml, finite, number as n, safeId, unit } from './rendering/svg';
import { prepareImages, preparedImage } from './rendering/images';

export { prepareVideoFrame as prepareFrame } from './rendering/videos';

let nextSvg = 0;

/** Precompute local equation paths once per content change; frame rendering remains synchronous. */
export async function prepareScene(scene: Scene): Promise<void> {
  await prepareImages(scene);
  const equations = Object.values(scene.objects).filter(object => object.kind === 'equation');
  await prepareEquations(Object.values(scene.compositions).flatMap(composition => equations.flatMap(object => {
    const state = composition.states[object.id];
    return state ? [state.text] : [];
  })));
  await prepareFonts(Object.values(scene.compositions).flatMap(composition => Object.values(scene.objects).flatMap(object => {
    const state = composition.states[object.id];
    return state && (object.kind === 'text' || (object.kind === 'equation' && !getEquation(state.text))) ? [state.text] : [];
  })));
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function cubicRange(p1: number, p2: number, p3: number): [number, number] {
  const a = 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p2 - 2 * p1);
  const c = p1;
  const extrema = [0, p3];
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) roots.push((-b + Math.sqrt(discriminant)) / (2 * a), (-b - Math.sqrt(discriminant)) / (2 * a));
  }
  for (const t of roots) if (t > 0 && t < 1) extrema.push(cubic(0, p1, p2, p3, t));
  return [Math.min(...extrema), Math.max(...extrema)];
}

function textSize(item: RenderObject): { width: number; height: number } {
  const size = Math.max(0, finite(item.state.fontSize));
  const equation = item.object.kind === 'equation' && getEquation(item.state.text);
  if (equation) return { width: equation.width * size / EQUATION_UNITS_PER_EM, height: equation.height * size / EQUATION_UNITS_PER_EM };
  return measureText(item.state.text, size);
}

/** Unrotated visual bounds; path controls are relative to the start anchor. */
export function objectBounds(item: RenderObject): ObjectBounds {
  const s = item.state;
  const x = finite(s.x), y = finite(s.y), width = finite(s.width), height = finite(s.height);
  const writingEquation = item.object.kind === 'equation' && item.writeProgress > 0 && item.writeProgress < 1 && getEquation(s.text);
  const writeStroke = writingEquation ? EQUATION_WRITE_STROKE_UNITS * Math.max(0, finite(s.fontSize)) / EQUATION_UNITS_PER_EM : 0;
  const stroke = Math.max(0, finite(s.strokeWidth), writeStroke) / 2;
  let bounds: ObjectBounds;
  if (item.object.kind === 'path') {
    const xs = cubicRange(finite(s.path.c1.x), finite(s.path.c2.x), width);
    const ys = cubicRange(finite(s.path.c1.y), finite(s.path.c2.y), height);
    bounds = { x: x + xs[0], y: y + ys[0], width: xs[1] - xs[0], height: ys[1] - ys[0] };
  } else if (item.object.kind === 'arrow' || item.object.kind === 'numberline') {
    const angle = Math.atan2(height, width);
    const length = Math.hypot(width, height);
    const head = Math.min(length, Math.max(SHAPE_STYLE.minimumArrowHead, stroke * 2 * SHAPE_STYLE.arrowHeadStrokeWidths));
    const spread = item.object.kind === 'numberline' ? Math.max(SHAPE_STYLE.tickHalfLength, head * SHAPE_STYLE.arrowHeadSpread) : head * SHAPE_STYLE.arrowHeadSpread;
    const points = [[0, 0], [width, height], [width - head * Math.cos(angle) + spread * Math.sin(angle), height - head * Math.sin(angle) - spread * Math.cos(angle)], [width - head * Math.cos(angle) - spread * Math.sin(angle), height - head * Math.sin(angle) + spread * Math.cos(angle)]];
    if (item.object.kind === 'numberline') for (const t of [0, 1]) points.push([width * t + SHAPE_STYLE.tickHalfLength * Math.sin(angle), height * t - SHAPE_STYLE.tickHalfLength * Math.cos(angle)], [width * t - SHAPE_STYLE.tickHalfLength * Math.sin(angle), height * t + SHAPE_STYLE.tickHalfLength * Math.cos(angle)]);
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    bounds = { x: x + Math.min(...xs), y: y + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } else {
    const size = item.object.kind === 'text' || item.object.kind === 'equation' ? textSize(item) : { width: Math.abs(width), height: Math.abs(height) };
    bounds = { x: x - size.width / 2, y: y - size.height / 2, ...size };
  }
  return { x: bounds.x - stroke, y: bounds.y - stroke, width: bounds.width + stroke * 2, height: bounds.height + stroke * 2 };
}

function shapeMarkup(item: RenderObject, prefix: string): string {
  const s = item.state, kind = item.object.kind, progress = unit(item.writeProgress);
  const draw = progress < 1 ? ` pathLength="1" stroke-dasharray="1" stroke-dashoffset="${n(1 - progress)}"` : '';
  if (kind === 'text') return textMarkup(item, prefix);
  if (kind === 'image' || kind === 'video') {
    const src = kind === 'video' ? item.videoFrame : preparedImage(item.object.image?.src);
    if (!src) return '';
    const width = Math.abs(finite(s.width)), height = Math.abs(finite(s.height));
    const x = -width / 2, y = -height / 2, radius = Math.max(0, Math.min(finite(s.cornerRadius), width / 2, height / 2));
    return `<defs><clipPath id="${prefix}-image"><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="${n(radius)}"/></clipPath><clipPath id="${prefix}-reveal"><rect x="${n(x)}" y="${n(y)}" width="${n(width * progress)}" height="${n(height)}"/></clipPath></defs><g clip-path="url(#${prefix}-reveal)"><image href="${escapeXml(src)}" x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="none" clip-path="url(#${prefix}-image)"/><rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="${n(radius)}" fill="none"/></g>`;
  }
  if (kind === 'equation') {
    const equation = getEquation(s.text);
    if (!equation) return textMarkup(item, prefix);
    const scale = Math.max(0, finite(s.fontSize)) / EQUATION_UNITS_PER_EM;
    return `<g transform="scale(${n(scale)}) translate(${n(-equation.x - equation.width / 2)} ${n(-equation.y - equation.height / 2)})" fill="currentColor" stroke="none">${equationMarkup(equation, progress, item.order)}</g>`;
  }
  const shape = shapeGeometry(item);
  if (!shape) return '';
  if (shape.kind === 'circle') return `<ellipse cx="0" cy="0" rx="${n(shape.radiusX)}" ry="${n(shape.radiusY)}" fill-opacity="${n(progress)}"${draw}/>`;
  if (shape.kind === 'rectangle') return `<rect x="${n(-shape.width / 2)}" y="${n(-shape.height / 2)}" width="${n(shape.width)}" height="${n(shape.height)}" rx="${n(shape.radius)}" fill-opacity="${n(progress)}"${draw}/>`;
  if (shape.kind === 'path') return `<path d="${shape.path}" fill="none"${draw}/>`;
  const ticks = shape.kind === 'numberline' ? Array.from({ length: SHAPE_STYLE.numberlineTicks }, (_, index) => `<path d="${numberlineTickPath(shape.length, index)}" opacity="${n(numberlineTickProgress(progress, index))}"/>`).join('') : '';
  return `<g transform="rotate(${n(shape.angle)})" fill="none"><path d="M0 0 H${n(shape.length)}"${draw}/>${ticks}<path d="${arrowHeadPath(shape)}" opacity="${n(arrowHeadProgress(progress))}"/></g>`;
}

/** Produce self-contained SVG, with no authored markup, external assets, or executable content. */
export function frameToSvg(frame: Frame, options: SvgOptions = {}): string {
  const prefix = `poietra-${safeId(options.idPrefix ?? `frame-${nextSvg++}`)}`;
  const width = Math.max(1, finite(frame.width, 1280)), height = Math.max(1, finite(frame.height, 720));
  const objects = frame.objects.map((item, index) => {
    if (!item.state.visible || unit(item.state.opacity) === 0 || unit(item.writeProgress) === 0) return '';
    const s = item.state, id = `${prefix}-${index}`, glow = s.effect === 'glow';
    const bounds = glow ? objectBounds(item) : null;
    const halo = GLOW_STYLE.sigmaScenePixels * GLOW_STYLE.cutoffStandardDeviations;
    const filter = glow ? `<defs><filter id="${id}-glow" filterUnits="userSpaceOnUse" x="${n(bounds!.x - s.x - halo)}" y="${n(bounds!.y - s.y - halo)}" width="${n(bounds!.width + halo * 2)}" height="${n(bounds!.height + halo * 2)}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${GLOW_STYLE.sigmaScenePixels}"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` : '';
    return `${filter}<g data-object-id="${escapeXml(item.object.id)}" transform="translate(${n(s.x)} ${n(s.y)}) rotate(${n(s.rotation)})" opacity="${n(unit(s.opacity))}" fill="${escapeXml(color(s.fill))}" color="${escapeXml(color(s.fill, '#d7d8e4'))}" stroke="${escapeXml(color(s.stroke))}" stroke-width="${n(Math.max(0, finite(s.strokeWidth)))}" stroke-linecap="round" stroke-linejoin="round"${glow ? ` filter="url(#${id}-glow)"` : ''}>${shapeMarkup(item, id)}</g>`;
  }).join('');
  const fontStyles = embeddedFontStyles(frame.objects.filter(item => item.object.kind === 'text' || (item.object.kind === 'equation' && !getEquation(item.state.text))).map(item => item.state.text));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">${fontStyles}${options.background === false ? '' : `<rect width="${n(width)}" height="${n(height)}" fill="${escapeXml(color(frame.background, '#08090b'))}"/>`}${objects}</svg>`;
}
