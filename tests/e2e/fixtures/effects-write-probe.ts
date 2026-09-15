import { installEffectsProbe } from './effects-probe';

/** Count browser API requests, not opaque browser-internal decode work or GPU completion. */
export function installWriteProbe() {
  const resources = installEffectsProbe();
  const counts = { svgImageLoads: 0, svgImageLoaded: 0, textureUploads: 0 };
  const svgUrls = new Set<string>();
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = value => {
    const url = createUrl(value);
    if (value instanceof Blob && value.type.startsWith('image/svg+xml')) svgUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = url => { svgUrls.delete(url); revokeUrl(url); };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...src,
    set(value: string) {
      if (svgUrls.has(value)) {
        counts.svgImageLoads++;
        this.addEventListener('load', () => counts.svgImageLoaded++, { once: true });
      }
      src.set!.call(this, value);
    },
  });
  const captured = new Set<WebGL2RenderingContext>();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    const gl = Reflect.apply(getContext, this, args);
    if (args[0] === 'webgl2' && gl && !captured.has(gl)) {
      captured.add(gl);
      for (const name of ['texImage2D', 'texSubImage2D']) {
        const api = gl as unknown as Record<string, (...args: unknown[]) => unknown>;
        const original = api[name];
        api[name] = (...parameters) => {
          // Null allocates storage; only non-null sources transfer pixel content.
          if (parameters.at(-1) !== null) counts.textureUploads++;
          return Reflect.apply(original, gl, parameters);
        };
      }
    }
    return gl;
  } as typeof getContext;
  return { ...resources, counts: () => ({ ...counts }) };
}
