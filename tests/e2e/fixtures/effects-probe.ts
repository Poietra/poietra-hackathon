/** Test-only observation: the production painter needs no instrumentation API. */
const CONTEXT_LOSS_TIMEOUT_MS = 5000;

export function installEffectsProbe(disableWebgl = false) {
  const contexts: WebGL2RenderingContext[] = [];
  const live = new Map<object, string>();
  const urls = new Set<string>();
  let allocations = 0;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    if (disableWebgl && args[0] === 'webgl2') return null;
    const context = Reflect.apply(getContext, this, args);
    if (args[0] === 'webgl2' && context && !contexts.includes(context)) {
      const gl = context as WebGL2RenderingContext;
      contexts.push(gl);
      for (const kind of ['Texture', 'Framebuffer', 'Renderbuffer', 'Buffer', 'VertexArray', 'Shader', 'Program']) {
        const api = gl as unknown as Record<string, (...args: unknown[]) => unknown>;
        const create = api[`create${kind}`];
        const remove = api[`delete${kind}`];
        api[`create${kind}`] = (...args) => {
          const resource = Reflect.apply(create, gl, args);
          if (resource) { live.set(resource as object, kind); allocations++; }
          return resource;
        };
        api[`delete${kind}`] = (...args) => {
          live.delete(args[0] as object);
          return Reflect.apply(remove, gl, args);
        };
      }
    }
    return context;
  } as typeof getContext;
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = value => { const url = createUrl(value); urls.add(url); return url; };
  URL.revokeObjectURL = url => { urls.delete(url); revokeUrl(url); };
  return {
    contexts,
    snapshot() { return { liveGpuResources: live.size, liveObjectUrls: urls.size, allocations, contexts: contexts.length }; },
    environment() {
      const gl = contexts.findLast(context => !context.isContextLost());
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        userAgent: navigator.userAgent,
        renderer: gl ? String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)) : 'Canvas 2D',
        vendor: gl ? String(gl.getParameter(info?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)) : '',
      };
    },
    async loseContext(index = 0) {
      const gl = contexts[index];
      if (!gl) throw new Error('No real WebGL2 context was created.');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('WEBGL_lose_context is unavailable.');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Context loss event did not arrive.')), CONTEXT_LOSS_TIMEOUT_MS);
        gl.canvas.addEventListener('webglcontextlost', () => { clearTimeout(timeout); resolve(); }, { once: true });
        extension.loseContext();
      });
    },
  };
}
