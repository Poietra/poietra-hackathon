import { compositeFragmentShader, gaussianFragmentShader } from './shaders';
import { checkGraphicsError, createProgram, createRenderTarget, createTexture, resizeTexture, uniform, type RenderTarget } from './webgl';

import { GLOW_STYLE } from './glow-style';
export { GLOW_STYLE } from './glow-style';

export interface GlowRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Context loss permanently disables this renderer; the caller uses Canvas 2D afterward. */
  readonly lost: boolean;
  render(source: TexImageSource, width: number, height: number, sigmaPixels: number): void;
  dispose(): void;
}

/** Named targets make the source -> horizontal blur -> vertical blur path explicit. */
function createResources(gl: WebGL2RenderingContext) {
  let sourceTexture: WebGLTexture | undefined;
  let horizontal: RenderTarget | undefined;
  let vertical: RenderTarget | undefined;
  let blurProgram: WebGLProgram | undefined;
  let compositeProgram: WebGLProgram | undefined;

  function dispose() {
    if (sourceTexture) gl.deleteTexture(sourceTexture);
    for (const target of [horizontal, vertical]) {
      if (!target) continue;
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    if (blurProgram) gl.deleteProgram(blurProgram);
    if (compositeProgram) gl.deleteProgram(compositeProgram);
  }

  try {
    sourceTexture = createTexture(gl);
    horizontal = createRenderTarget(gl);
    vertical = createRenderTarget(gl);
    blurProgram = createProgram(gl, gaussianFragmentShader);
    compositeProgram = createProgram(gl, compositeFragmentShader);
    const blurUniforms = {
      source: uniform(gl, blurProgram, 'uSource'),
      texelStep: uniform(gl, blurProgram, 'uTexelStep'),
      sigma: uniform(gl, blurProgram, 'uSigma'),
      radius: uniform(gl, blurProgram, 'uRadius'),
    };
    const compositeUniforms = {
      source: uniform(gl, compositeProgram, 'uSource'),
      halo: uniform(gl, compositeProgram, 'uHalo'),
      haloStrength: uniform(gl, compositeProgram, 'uHaloStrength'),
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { sourceTexture, horizontal, vertical, blurProgram, compositeProgram, blurUniforms, compositeUniforms, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

type GlowResources = ReturnType<typeof createResources>;

function resizeTargets(gl: WebGL2RenderingContext, resources: GlowResources, width: number, height: number) {
  gl.activeTexture(gl.TEXTURE0);
  for (const texture of [resources.sourceTexture, resources.horizontal.texture, resources.vertical.texture]) {
    resizeTexture(gl, texture, width, height);
  }
  for (const target of [resources.horizontal, resources.vertical]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Glow framebuffer is incomplete.');
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  checkGraphicsError(gl);
}

function blur(gl: WebGL2RenderingContext, resources: GlowResources, width: number, height: number, sigma: number) {
  const uniforms = resources.blurUniforms;
  gl.useProgram(resources.blurProgram);
  gl.uniform1i(uniforms.source, 0);
  gl.uniform1f(uniforms.sigma, sigma);
  gl.uniform1i(uniforms.radius, Math.ceil(sigma * GLOW_STYLE.cutoffStandardDeviations));
  gl.activeTexture(gl.TEXTURE0);

  gl.bindTexture(gl.TEXTURE_2D, resources.sourceTexture);
  gl.bindFramebuffer(gl.FRAMEBUFFER, resources.horizontal.framebuffer);
  gl.uniform2f(uniforms.texelStep, 1 / width, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.bindTexture(gl.TEXTURE_2D, resources.horizontal.texture);
  gl.bindFramebuffer(gl.FRAMEBUFFER, resources.vertical.framebuffer);
  gl.uniform2f(uniforms.texelStep, 0, 1 / height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function composite(gl: WebGL2RenderingContext, resources: GlowResources, withGlow: boolean) {
  const uniforms = resources.compositeUniforms;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(resources.compositeProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, resources.sourceTexture);
  gl.uniform1i(uniforms.source, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, withGlow ? resources.vertical.texture : resources.sourceTexture);
  gl.uniform1i(uniforms.halo, 1);
  gl.uniform1f(uniforms.haloStrength, withGlow ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Shrink before growing so an aspect change cannot allocate both larger axes. */
function resizeDrawingBuffer(canvas: HTMLCanvasElement, width: number, height: number) {
  if (width < canvas.width) canvas.width = width;
  if (height < canvas.height) canvas.height = height;
  if (width > canvas.width) canvas.width = width;
  if (height > canvas.height) canvas.height = height;
}

/** Use a private WebGL canvas so the caller's output remains available for Canvas 2D fallback. */
export function createGlowRenderer(): GlowRenderer | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      // Keep the completed pixels valid until the caller copies them to its object cache.
      preserveDrawingBuffer: true,
    });
  } catch { return null; }
  if (!gl) return null;
  const context = gl;
  let resources: GlowResources | undefined;
  let disposed = false;
  let contextLost = context.isContextLost();
  let textureWidth = 0;
  let textureHeight = 0;

  function onContextLost(event: Event) {
    event.preventDefault();
    contextLost = true;
  }
  const isLost = () => contextLost || context.isContextLost();
  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', onContextLost);
    resources?.dispose();
    canvas.width = 0;
    canvas.height = 0;
    // The canvas is private; release its context so repeated exports do not retain contexts.
    if (!context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
  }
  canvas.addEventListener('webglcontextlost', onContextLost);

  try {
    if (isLost()) throw new Error('WebGL context is lost.');
    const maxTextureSize = context.getParameter(context.MAX_TEXTURE_SIZE) as number;
    const maxViewport = context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array;
    resources = createResources(context);
    const gpu = resources;
    context.disable(context.BLEND);
    context.disable(context.DEPTH_TEST);
    context.disable(context.STENCIL_TEST);
    context.disable(context.SCISSOR_TEST);
    context.disable(context.DITHER);

    function render(source: TexImageSource, width: number, height: number, sigmaPixels: number) {
      if (disposed) throw new Error('Glow renderer has been disposed.');
      if (isLost()) throw new Error('WebGL context is lost.');
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width > maxTextureSize || height > maxTextureSize || width > maxViewport[0] || height > maxViewport[1]) {
        throw new Error('The Glow source exceeds WebGL texture or viewport limits.');
      }
      if (!Number.isFinite(sigmaPixels) || sigmaPixels < 0
        || Math.ceil(sigmaPixels * GLOW_STYLE.cutoffStandardDeviations) > maxTextureSize) {
        throw new Error('The Glow blur radius is invalid or exceeds WebGL texture limits.');
      }
      if (width !== textureWidth || height !== textureHeight) {
        resizeDrawingBuffer(canvas, width, height);
        if (context.drawingBufferWidth !== width || context.drawingBufferHeight !== height) {
          throw new Error('WebGL cannot allocate the requested Glow output size.');
        }
        resizeTargets(context, gpu, width, height);
        textureWidth = width;
        textureHeight = height;
      }
      context.viewport(0, 0, width, height);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, gpu.sourceTexture);
      // DOM sources start at the top left. Shader passes use bottom-left UVs and premultiplied RGBA.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      context.texSubImage2D(context.TEXTURE_2D, 0, 0, 0, context.RGBA, context.UNSIGNED_BYTE, source);
      if (sigmaPixels > 0) blur(context, gpu, width, height, sigmaPixels);
      composite(context, gpu, sigmaPixels > 0);
      context.flush();
      // One final check covers upload and drawing errors before the caller can copy pixels.
      checkGraphicsError(context);
    }
    return { canvas, get lost() { return isLost(); }, render, dispose };
  } catch {
    dispose();
    return null;
  }
}
