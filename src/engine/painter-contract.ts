import type { Frame } from './evaluate';

export type PaintBackend = 'webgl2' | 'canvas2d';

export interface PaintOptions {
  signal?: AbortSignal;
}

/** Browser drawing shared by preview and export; independent of React and editing state. */
export interface FramePainter {
  /** The active backend, including a change to Canvas 2D after WebGL context loss. */
  readonly backend: PaintBackend;
  /**
   * Render a complete frame, including background and object effects, to the target canvas.
   * prepareScene(scene) must have completed first. Do not mutate the supplied frame.
   * Use the current canvas.width/height; preserve the Scene aspect ratio and letterbox
   * with frame.background. Callers serialize renders and resize only between renders.
   * The promise resolves when pixels can be captured by WebCodecs. Export must not skip
   * frames; preview may coalesce pending frames before calling this method.
   * Cancellation rejects with AbortError.
   */
  render(frame: Frame, options?: PaintOptions): Promise<void>;
  /** Idempotent. Release GPU and image resources; an in-flight render must stop safely. */
  dispose(): void;
}

/** Implement createFramePainter in src/engine/painter.ts. The caller owns the canvas. */
export interface PainterContract {
  createFramePainter(canvas: HTMLCanvasElement): Promise<FramePainter>;
}
