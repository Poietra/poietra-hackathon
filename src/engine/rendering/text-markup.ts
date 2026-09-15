import type { RenderObject } from '../evaluate';
import { FONT_FAMILY, measureText } from './fonts';
import { escapeXml, finite, number as n, unit } from './svg';

// The clip extends past the measured ink vertically to include accents and stroke edges.
export const TEXT_CLIP_VERTICAL_EM = 0.2;

/** Keep each line intact for the browser's shaping, including spaces and combining characters. */
export function textMarkup(item: RenderObject, prefix: string, glyphOpacity?: (index: number) => number): string {
  const s = item.state, size = Math.max(0, finite(s.fontSize)), progress = unit(item.writeProgress);
  const lines = s.text.split('\n');
  const metrics = measureText(s.text, size);
  const glyphCount = Array.from(s.text.replaceAll('\n', '')).length;
  const opacity = glyphOpacity ?? (item.order === 'sequential' && progress < 1
    ? (index: number) => unit(progress * glyphCount - index) : undefined);
  let index = 0;
  const body = lines.map((line, lineIndex) => {
    const text = opacity
      ? Array.from(line).map(character => `<tspan opacity="${n(opacity(index++))}">${escapeXml(character)}</tspan>`).join('') : escapeXml(line);
    return `<text x="0" y="${n((lineIndex - (lines.length - 1) / 2) * metrics.lineHeight + metrics.baseline)}" text-anchor="middle" xml:space="preserve">${text}</text>`;
  }).join('');
  const font = `text-rendering="geometricPrecision" font-family="${escapeXml(FONT_FAMILY)}" font-size="${n(size)}"`;
  if (item.order === 'sequential' || progress >= 1) return `<g ${font}>${body}</g>`;
  const padding = size * TEXT_CLIP_VERTICAL_EM;
  return `<defs><clipPath id="${prefix}-text"><rect x="${n(-metrics.width / 2)}" y="${n(-metrics.height / 2 - padding)}" width="${n(metrics.width * progress)}" height="${n(metrics.height + padding * 2)}"/></clipPath></defs><g clip-path="url(#${prefix}-text)" ${font}>${body}</g>`;
}
