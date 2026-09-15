// Temporary UI development adapter. The renderer/export task owns the production implementation.
// This file will be removed when src/engine/renderer.ts is integrated.
import type { RendererContract } from '../engine/render-contract';
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const draftRenderer: RendererContract = {
  async prepareScene() {},
  objectBounds({ object, state: s }) {
    if (['path', 'arrow', 'numberline'].includes(object.kind)) return { x: Math.min(s.x, s.x + s.width), y: Math.min(s.y, s.y + s.height) - 12, width: Math.abs(s.width), height: Math.max(24, Math.abs(s.height) + 24) };
    return { x: s.x - s.width / 2, y: s.y - s.height / 2, width: s.width, height: s.height };
  },
  frameToSvg(frame, options = {}) {
    const prefix = options.idPrefix || 'draft';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.width} ${frame.height}">${options.background === false ? '' : `<rect width="100%" height="100%" fill="${escape(frame.background)}"/>`}${frame.objects.map(({ object, state: s, writeProgress: p }) => {
      const id = `${prefix}-${object.id}`; let content = '';
      if (object.kind === 'circle') content = `<ellipse rx="${s.width / 2}" ry="${s.height / 2}"/>`;
      else if (object.kind === 'rectangle') content = `<rect x="${-s.width / 2}" y="${-s.height / 2}" width="${s.width}" height="${s.height}" rx="${s.cornerRadius}"/>`;
      else if (object.kind === 'path') content = `<path d="M0 0 C${s.path.c1.x} ${s.path.c1.y} ${s.path.c2.x} ${s.path.c2.y} ${s.width} ${s.height}" fill="none" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - p}"/><circle r="3" fill="${s.stroke}"/><circle cx="${s.width}" cy="${s.height}" r="3" fill="${s.stroke}"/>`;
      else if (object.kind === 'arrow') { const angle = Math.atan2(s.height, s.width) * 180 / Math.PI; content = `<path d="M0 0 L${s.width} ${s.height}" fill="none"/><path d="M-15 -7 L0 0 L-15 7" transform="translate(${s.width} ${s.height}) rotate(${angle})" fill="none"/>`; }
      else if (object.kind === 'numberline') content = `<path d="M0 0 H${s.width}" fill="none"/>${Array.from({ length: 11 }, (_, i) => `<path d="M${s.width * i / 10} -9 v18"/>`).join('')}`;
      else {
        const text = object.kind === 'equation' ? s.text.replaceAll('\\sigma', 'σ').replaceAll('\\alpha', 'α').replaceAll('\\pi', 'π') : s.text;
        content = `<defs><clipPath id="${escape(id)}"><rect x="${-s.width / 2 - 20}" y="${-s.height / 2 - 20}" width="${(s.width + 40) * p}" height="${s.height + 40}"/></clipPath></defs><text clip-path="url(#${escape(id)})" text-anchor="middle" dominant-baseline="central" font-family="${object.kind === 'equation' ? 'Times New Roman, serif' : 'Arial, sans-serif'}" font-style="${object.kind === 'equation' ? 'italic' : 'normal'}" font-size="${s.fontSize}" stroke="none">${escape(text)}</text>`;
      }
      return `<g data-object-id="${escape(object.id)}" transform="translate(${s.x} ${s.y}) rotate(${s.rotation})" fill="${escape(s.fill)}" stroke="${escape(s.stroke)}" stroke-width="${s.strokeWidth}" opacity="${s.opacity}">${content}</g>`;
    }).join('')}</svg>`;
  },
};
