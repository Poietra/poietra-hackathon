import { escapeXml, number, unit } from './svg';

interface MathNode { tag: string; attributes: Record<string, string>; children: MathNode[] }
export interface Equation { width: number; height: number; x: number; y: number; tree: MathNode; glyphs: number }
const cache = new Map<string, Equation | null>();
let loadMath: Promise<(source: string) => Equation | null> | undefined;

const geometryAttributes = new Set(['d', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'points', 'transform', 'stroke-width']);
const tags = new Set(['g', 'path', 'rect', 'line', 'polygon', 'polyline', 'circle', 'ellipse']);

async function converter() {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] = await Promise.all([
    import('mathjax-full/js/mathjax.js'), import('mathjax-full/js/input/tex.js'), import('mathjax-full/js/output/svg.js'),
    import('mathjax-full/js/adaptors/liteAdaptor.js'), import('mathjax-full/js/handlers/html.js'),
    import('mathjax-full/js/input/tex/ams/AmsConfiguration.js'),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document('', {
    InputJax: new TeX({ packages: ['base', 'ams'], maxBuffer: 10000, maxMacros: 1000 }),
    OutputJax: new SVG({ fontCache: 'none' }),
  });
  return (source: string): Equation | null => {
    if (source.length > 10000) return null;
    try {
      const container = document.convert(source, { display: true });
      const svg = adaptor.firstChild(container) as typeof container;
      const viewBox = adaptor.getAttribute(svg, 'viewBox')?.trim().split(/\s+/).map(Number);
      if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) return null;
      let glyphs = 0;
      let invalid = false;
      const read = (element: typeof container): MathNode | null => {
        const tag = adaptor.kind(element);
        // Do not serialize MathJax HTML, links, foreign objects, styles, or error text.
        if (adaptor.getAttribute(element, 'data-mml-node') === 'merror') invalid = true;
        if (!tags.has(tag)) return null;
        const attributes: Record<string, string> = {};
        for (const { name, value } of adaptor.allAttributes(element)) {
          if (geometryAttributes.has(name)) attributes[name] = value;
          if ((name === 'fill' || name === 'stroke') && ['none', 'currentColor'].includes(value)) attributes[name] = value;
        }
        if (tag !== 'g') glyphs += 1;
        return { tag, attributes, children: adaptor.childNodes(element).flatMap(child => {
          const node = read(child as typeof container);
          return node ? [node] : [];
        }) };
      };
      const tree: MathNode = { tag: 'g', attributes: {}, children: adaptor.childNodes(svg).flatMap(child => {
        const node = read(child as typeof container);
        return node ? [node] : [];
      }) };
      return !invalid && glyphs ? { x: viewBox[0], y: viewBox[1], width: viewBox[2], height: viewBox[3], tree, glyphs } : null;
    } catch { return null; }
  };
}

export async function prepareEquations(sources: string[]): Promise<void> {
  const missing = [...new Set(sources)].filter(source => !cache.has(source));
  if (!missing.length) return;
  const convert = await (loadMath ??= converter());
  for (const source of missing) cache.set(source, convert(source));
}

export function getEquation(source: string): Equation | null { return cache.get(source) ?? null; }

export function equationMarkup(equation: Equation, progress: number, order: 'together' | 'sequential'): string {
  let index = 0;
  const render = (node: MathNode): string => {
    const attributes = Object.entries(node.attributes).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
    if (node.tag === 'g') return `<g${attributes}>${node.children.map(render).join('')}</g>`;
    const glyphProgress = order === 'sequential' ? unit(progress * equation.glyphs - index++) : unit(progress);
    if (glyphProgress === 0) return '';
    if (glyphProgress === 1) return `<${node.tag}${attributes}/>`;
    // Each glyph is drawn along its own outline; fills settle in at the end of its stroke.
    const fillProgress = unit((glyphProgress - 0.55) / 0.45);
    return `<g fill-opacity="${number(fillProgress)}" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"><${node.tag}${attributes} pathLength="1" stroke-dasharray="1" stroke-dashoffset="${number(1 - glyphProgress)}"/></g>`;
  };
  return render(equation.tree);
}
