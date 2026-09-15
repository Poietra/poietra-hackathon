import type { RenderObject } from '../evaluate';
import { getEquation } from './equations';
import { embeddedFontStyles, measureText } from './fonts';
import { color, finite, number as n, unit } from './svg';
import { withSvgImage } from './svg-image';
import { TEXT_CLIP_VERTICAL_EM, textMarkup } from './text-markup';

const RGBA_BYTES_PER_PIXEL = 4;
const EDGE_PADDING_PIXELS = 1;
const MAX_ATLAS_EDGE_PIXELS = 4096;
const MAX_SEQUENTIAL_CHARACTERS = 128;
// Fill and stroke are separate masks. Two working cells preserve their paint order
// before the per-character opacity is applied to the combined glyph.
const MASKS_PER_CELL = 2;
const WORKING_CELLS = 2;

export interface TextDrawing {
  readonly key: string;
  readonly bytes: number;
  paint(context: CanvasRenderingContext2D, item: RenderObject): void;
  dispose(): void;
}

/** Appearance that changes glyph coverage; color and object transforms do not. */
export function textDrawingKey(item: RenderObject, scale: number): string | null {
  const text = item.object.kind === 'text' || (item.object.kind === 'equation' && !getEquation(item.state.text));
  // Color-font glyphs cannot be represented by a single alpha mask.
  if (!text || /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Presentation}\uFE0F\u20E3]/u.test(item.state.text)) return null;
  return JSON.stringify([item.state.text, Math.max(0, finite(item.state.fontSize)), Math.max(0, finite(item.state.strokeWidth)), item.order, scale]);
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    canvas.width = 0; canvas.height = 0;
    throw new Error('文字を描画する Canvas を作成できませんでした。');
  }
  return { canvas, context };
}

/** A single SVG request prepares all masks with the same full-line shaping as the SVG renderer. */
export async function prepareTextDrawing(item: RenderObject, scale: number, maxBytes: number, signal: AbortSignal): Promise<TextDrawing | null> {
  signal.throwIfAborted();
  const key = textDrawingKey(item, scale);
  if (key === null || !Number.isFinite(scale) || scale <= 0) return null;
  const size = Math.max(0, finite(item.state.fontSize));
  const strokeWidth = Math.max(0, finite(item.state.strokeWidth));
  const metrics = measureText(item.state.text, size);
  const glyphCount = Array.from(item.state.text.replaceAll('\n', '')).length;
  const sequential = item.order === 'sequential';
  if (sequential && glyphCount > MAX_SEQUENTIAL_CHARACTERS) return null;
  const padding = strokeWidth / 2 + EDGE_PADDING_PIXELS / scale;
  const x = -metrics.width / 2 - padding, y = -metrics.height / 2 - padding;
  const width = Math.max(1, Math.ceil((metrics.width + padding * 2) * scale));
  const height = Math.max(1, Math.ceil((metrics.height + padding * 2) * scale));
  const cellCount = MASKS_PER_CELL * (1 + (sequential ? glyphCount : 0));
  // Pack full text cells into rows. This bounds both allocation and SVG image dimensions.
  const columns = Math.min(cellCount, Math.floor(MAX_ATLAS_EDGE_PIXELS / width));
  if (!columns || height > MAX_ATLAS_EDGE_PIXELS) return null;
  const rows = Math.ceil(cellCount / columns);
  const atlasWidth = columns * width, atlasHeight = rows * height;
  const bytes = (atlasWidth * atlasHeight + width * height * WORKING_CELLS) * RGBA_BYTES_PER_PIXEL;
  if (!Number.isFinite(bytes) || bytes > maxBytes || atlasHeight > MAX_ATLAS_EDGE_PIXELS) return null;

  const cell = (index: number) => ({ x: index % columns * width, y: Math.floor(index / columns) * height });
  const complete: RenderObject = { ...item, writeProgress: 1 };
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const position = cell(index);
    const glyph = Math.floor(index / MASKS_PER_CELL) - 1;
    const body = textMarkup(complete, `text-mask-${index}`, glyph < 0 ? undefined : candidate => Number(candidate === glyph));
    const paint = index % MASKS_PER_CELL === 0 ? 'fill="white" stroke="none"' : `fill="none" stroke="white" stroke-width="${n(strokeWidth)}"`;
    // Match the SVG cutout's viewport and translation. Rounding the viewBox size
    // changes its fitted scale slightly, enough to change small-font hinting.
    return `<svg x="${position.x}" y="${position.y}" width="${width}" height="${height}" viewBox="0 0 ${width / scale} ${height / scale}"><g transform="translate(${n(-x)} ${n(-y)})" ${paint} stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${atlasWidth}" height="${atlasHeight}" viewBox="0 0 ${atlasWidth} ${atlasHeight}">${embeddedFontStyles([item.state.text])}${cells}</svg>`;
  const surfaces: HTMLCanvasElement[] = [];
  const dispose = () => { for (const canvas of surfaces) { canvas.width = 0; canvas.height = 0; } };
  function surface(width: number, height: number) {
    const result = createCanvas(width, height);
    surfaces.push(result.canvas);
    return result;
  }
  try {
    const atlas = surface(atlasWidth, atlasHeight);
    const tint = surface(width, height), glyph = surface(width, height);
    await withSvgImage(svg, signal, image => atlas.context.drawImage(image, 0, 0));

    function paintMask(index: number, value: string, fallback: string) {
      const css = color(value);
      if (css.toLowerCase() === 'none') return;
      const source = cell(index);
      const context = tint.context;
      context.clearRect(0, 0, width, height);
      context.drawImage(atlas.canvas, source.x, source.y, width, height, 0, 0, width, height);
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = fallback;
      context.fillStyle = css;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = 'source-over';
      glyph.context.drawImage(tint.canvas, 0, 0);
    }

    function paintCell(context: CanvasRenderingContext2D, item: RenderObject, index: number, opacity: number) {
      if (opacity <= 0) return;
      glyph.context.clearRect(0, 0, width, height);
      paintMask(index * MASKS_PER_CELL, item.state.fill, '#000000');
      if (strokeWidth > 0) paintMask(index * MASKS_PER_CELL + 1, item.state.stroke, 'transparent');
      const previousAlpha = context.globalAlpha;
      context.globalAlpha *= opacity;
      context.drawImage(glyph.canvas, x, y, width / scale, height / scale);
      context.globalAlpha = previousAlpha;
    }

    return {
      key, bytes, dispose,
      paint(context, current) {
        const progress = unit(current.writeProgress);
        if (!progress || !size) return;
        context.save();
        try {
          if (current.order === 'together' && progress < 1) {
            const padding = size * TEXT_CLIP_VERTICAL_EM;
            context.beginPath();
            context.rect(-metrics.width / 2, -metrics.height / 2 - padding, metrics.width * progress, metrics.height + padding * 2);
            context.clip();
          }
          if (current.order === 'sequential' && progress < 1) {
            for (let index = 0; index < glyphCount; index++) paintCell(context, current, index + 1, unit(progress * glyphCount - index));
          } else paintCell(context, current, 0, 1);
        } finally { context.restore(); }
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
