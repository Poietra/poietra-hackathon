import type { FontAsset } from './font-assets';

export const FONT_FAMILY = "'Poietra Inter', 'Poietra Noto Sans JP', sans-serif";
let faces: FontAsset[] = [];
const styles = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
let context: CanvasRenderingContext2D | null | undefined;

function requiredFaces(sources: string[]) {
  const codePoints = [...new Set(Array.from(sources.join(''), character => character.codePointAt(0)!))];
  return codePoints.length ? faces.filter(face => !face.ranges || face.ranges.some(([start, end]) => codePoints.some(point => point > 255 && point >= start && point <= end))) : [];
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  return btoa(chunks.join(''));
}

/** The editor and SVG image rasterization use the same local, embedded font bytes. */
export async function prepareFonts(sources: string[]): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !sources.some(Boolean)) return;
  if (!faces.length) faces = (await import('./font-assets')).fontAssets;
  await Promise.all(requiredFaces(sources).map(face => {
    let loading = pending.get(face.url);
    if (!loading) {
      loading = (async () => {
        const response = await fetch(face.url);
        if (!response.ok) throw new Error(`Font asset could not be loaded: ${face.family}`);
        const buffer = await response.arrayBuffer();
        const font = new FontFace(face.family, buffer, { style: 'normal', weight: '400', ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}) });
        await font.load();
        document.fonts.add(font);
        styles.set(face.url, `@font-face{font-family:'${face.family}';font-style:normal;font-weight:400;${face.unicodeRange ? `unicode-range:${face.unicodeRange};` : ''}src:url(data:font/woff2;base64,${base64(buffer)}) format('woff2');}`);
      })().catch(error => { pending.delete(face.url); throw error; });
      pending.set(face.url, loading);
    }
    return loading;
  }));
}

export function embeddedFontStyles(sources: string[]): string {
  const css = requiredFaces(sources).map(face => styles.get(face.url) ?? '').join('');
  return css ? `<style>${css}</style>` : '';
}

export interface TextMetrics { width: number; height: number; lineHeight: number; baseline: number }

/** Browser measurements use prepared fonts; Node callers get stable approximate text bounds. */
export function measureText(text: string, size: number): TextMetrics {
  const lines = text.split('\n');
  const lineHeight = size * 1.25;
  if (size <= 0) return { width: 0, height: 0, lineHeight: 0, baseline: 0 };
  if (context === undefined && typeof document !== 'undefined') context = document.createElement('canvas').getContext('2d');
  if (!context) {
    const width = Math.max(0, ...lines.map(line => Array.from(line).reduce((sum, character) => sum + (character.codePointAt(0)! > 255 ? 1 : 0.62), 0))) * size;
    return { width, height: size + (lines.length - 1) * lineHeight, lineHeight, baseline: size * 0.3 };
  }
  context.font = `400 ${size}px ${FONT_FAMILY}`;
  // Keep glyph advances proportional when a painter rasterizes text below Scene size.
  // Integer hinting at small sizes otherwise makes the bitmap wider than these bounds.
  context.textRendering = 'geometricPrecision';
  const measurements = lines.map(line => context!.measureText(line));
  const ascent = Math.max(size * 0.8, ...measurements.map(metrics => metrics.actualBoundingBoxAscent));
  const descent = Math.max(size * 0.2, ...measurements.map(metrics => metrics.actualBoundingBoxDescent));
  // SVG text-anchor="middle" centers the advance, not the ink. Keep either glyph
  // overhang inside a symmetric crop around that same anchor (for example Inter's j).
  const width = Math.max(0, ...measurements.map(metrics => 2 * Math.max(
    metrics.width / 2,
    metrics.width / 2 + metrics.actualBoundingBoxLeft,
    metrics.actualBoundingBoxRight - metrics.width / 2,
  )));
  return { width, height: ascent + descent + (lines.length - 1) * lineHeight, lineHeight, baseline: (ascent - descent) / 2 };
}
