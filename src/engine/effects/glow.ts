import { compositeFragmentShader, fullscreenVertexShader, gaussianFragmentShader } from './shaders';

/** Match the existing SVG Glow: sigma is measured in Scene pixels before output scaling. */
export const GLOW_STYLE = {
  sigmaScenePixels: 4,
  // Four standard deviations retain more than 99.99% of a one-dimensional Gaussian.
  cutoffStandardDeviations: 4,
} as const;

export interface GlowRenderer {
  readonly canvas: HTMLCanvasElement;
  /** Context loss permanently disables this renderer; the caller continues through Canvas 2D. */
  readonly lost: boolean;
  render(source: TexImageSource, width: number, height: number, sigmaPixels: number): void;
  dispose(): void;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Glow shader allocation failed.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader) ?? 'Unknown compilation error';
    gl.deleteShader(shader);
    throw new Error(`Glow shader compilation failed: ${detail}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, fullscreenVertexShader);
  let fragment: WebGLShader | undefined;
  let program: WebGLProgram | null = null;
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new Error('Glow program allocation failed.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Glow program linking failed: ${gl.getProgramInfoLog(program) ?? 'Unknown link error'}`);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    program = null;
    throw error;
  } finally {
    // Linked programs retain their compiled code; shader handles are no longer needed.
    if (program && fragment) {
      gl.detachShader(program, vertex);
      gl.detachShader(program, fragment);
    }
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function uniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`Glow shader uniform is unavailable: ${name}`);
  return location;
}

/** Private WebGL canvas: the caller's output canvas remains available for Canvas 2D fallback. */
export function createGlowRenderer(): GlowRenderer | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      // The caller copies these pixels immediately; keep them valid across that copy boundary.
      preserveDrawingBuffer: true,
    });
  } catch { return null; }
  if (!gl) return null;
  const context = gl;
  const programs: WebGLProgram[] = [];
  const textures: WebGLTexture[] = [];
  const framebuffers: WebGLFramebuffer[] = [];
  let vertexArray: WebGLVertexArrayObject | null = null;
  let contextLost = context.isContextLost();
  let disposed = false;
  let textureWidth = 0;
  let textureHeight = 0;
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  const isLost = () => contextLost || context.isContextLost();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('webglcontextlost', onContextLost);
    for (const framebuffer of framebuffers) context.deleteFramebuffer(framebuffer);
    for (const texture of textures) context.deleteTexture(texture);
    for (const program of programs) context.deleteProgram(program);
    if (vertexArray) context.deleteVertexArray(vertexArray);
    canvas.width = 0;
    canvas.height = 0;
    // Release the private context as well, so repeated exports do not accumulate live contexts.
    if (!context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
  };

  try {
    if (isLost()) throw new Error('WebGL context is lost.');
    const maxTextureSize = context.getParameter(context.MAX_TEXTURE_SIZE) as number;
    const maxViewport = context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array;
    const blurProgram = createProgram(context, gaussianFragmentShader);
    programs.push(blurProgram);
    const compositeProgram = createProgram(context, compositeFragmentShader);
    programs.push(compositeProgram);
    const blurUniforms = {
      source: uniform(context, blurProgram, 'uSource'),
      texelStep: uniform(context, blurProgram, 'uTexelStep'),
      sigma: uniform(context, blurProgram, 'uSigma'),
      radius: uniform(context, blurProgram, 'uRadius'),
    };
    const compositeUniforms = {
      source: uniform(context, compositeProgram, 'uSource'),
      halo: uniform(context, compositeProgram, 'uHalo'),
      haloStrength: uniform(context, compositeProgram, 'uHaloStrength'),
    };
    vertexArray = context.createVertexArray();
    if (!vertexArray) throw new Error('Glow vertex array allocation failed.');
    context.bindVertexArray(vertexArray);
    for (let index = 0; index < 3; index++) {
      const texture = context.createTexture();
      if (!texture) throw new Error('Glow texture allocation failed.');
      textures.push(texture);
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    }
    const [sourceTexture, horizontalTexture, verticalTexture] = textures;
    for (const texture of [horizontalTexture, verticalTexture]) {
      const framebuffer = context.createFramebuffer();
      if (!framebuffer) throw new Error('Glow framebuffer allocation failed.');
      framebuffers.push(framebuffer);
      context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    }
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.disable(context.BLEND);
    context.disable(context.DEPTH_TEST);
    context.disable(context.STENCIL_TEST);
    context.disable(context.SCISSOR_TEST);
    context.disable(context.DITHER);

    function checkUsable() {
      if (disposed) throw new Error('Glow renderer has been disposed.');
      if (isLost()) throw new Error('WebGL context is lost.');
    }

    function checkGraphicsError() {
      checkUsable();
      const error = context.getError();
      if (error !== context.NO_ERROR) throw new Error(`Glow rendering failed with WebGL error ${error}.`);
    }

    function resize(width: number, height: number) {
      if (width === textureWidth && height === textureHeight) return;
      canvas.width = width;
      canvas.height = height;
      if (context.drawingBufferWidth !== width || context.drawingBufferHeight !== height) {
        throw new Error('WebGL cannot allocate the requested Glow output size.');
      }
      context.activeTexture(context.TEXTURE0);
      for (const texture of textures) {
        context.bindTexture(context.TEXTURE_2D, texture);
        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, width, height, 0, context.RGBA, context.UNSIGNED_BYTE, null);
      }
      for (const framebuffer of framebuffers) {
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
        if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
          throw new Error('Glow framebuffer is incomplete.');
        }
      }
      context.bindFramebuffer(context.FRAMEBUFFER, null);
      checkGraphicsError();
      textureWidth = width;
      textureHeight = height;
    }

    function render(source: TexImageSource, width: number, height: number, sigmaPixels: number) {
      checkUsable();
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width > maxTextureSize || height > maxTextureSize || width > maxViewport[0] || height > maxViewport[1]) {
        throw new Error('The Glow source exceeds WebGL texture or viewport limits.');
      }
      const radius = Math.ceil(sigmaPixels * GLOW_STYLE.cutoffStandardDeviations);
      if (!Number.isFinite(sigmaPixels) || sigmaPixels < 0 || radius > maxTextureSize) {
        throw new Error('The Glow blur radius is invalid or exceeds WebGL texture limits.');
      }
      resize(width, height);
      context.viewport(0, 0, width, height);
      context.bindVertexArray(vertexArray);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, sourceTexture);
      // DOM images have a top-left origin. All shader passes and canvas output use bottom-left UVs.
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, true);
      context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      context.texSubImage2D(context.TEXTURE_2D, 0, 0, 0, context.RGBA, context.UNSIGNED_BYTE, source);
      checkGraphicsError();

      if (sigmaPixels > 0) {
        context.useProgram(blurProgram);
        context.uniform1i(blurUniforms.source, 0);
        context.uniform1f(blurUniforms.sigma, sigmaPixels);
        context.uniform1i(blurUniforms.radius, radius);
        context.uniform2f(blurUniforms.texelStep, 1 / width, 0);
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffers[0]);
        context.drawArrays(context.TRIANGLES, 0, 3);
        context.bindTexture(context.TEXTURE_2D, horizontalTexture);
        context.uniform2f(blurUniforms.texelStep, 0, 1 / height);
        context.bindFramebuffer(context.FRAMEBUFFER, framebuffers[1]);
        context.drawArrays(context.TRIANGLES, 0, 3);
      }

      context.bindFramebuffer(context.FRAMEBUFFER, null);
      context.useProgram(compositeProgram);
      context.activeTexture(context.TEXTURE0);
      context.bindTexture(context.TEXTURE_2D, sourceTexture);
      context.uniform1i(compositeUniforms.source, 0);
      context.activeTexture(context.TEXTURE1);
      context.bindTexture(context.TEXTURE_2D, sigmaPixels > 0 ? verticalTexture : sourceTexture);
      context.uniform1i(compositeUniforms.halo, 1);
      context.uniform1f(compositeUniforms.haloStrength, sigmaPixels > 0 ? 1 : 0);
      context.drawArrays(context.TRIANGLES, 0, 3);
      context.flush();
      checkGraphicsError();
    }

    return { canvas, get lost() { return isLost(); }, render, dispose };
  } catch {
    dispose();
    return null;
  }
}
