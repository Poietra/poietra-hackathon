import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Scene } from '../../shared/model';
import type { Frame } from '../engine/evaluate';
import type { FramePainter, PainterContract } from '../engine/painter-contract';
import type { RendererContract } from '../engine/render-contract';

export interface CanvasPresentation {
  frame: Frame;
  key: string;
  width: number;
  height: number;
}

interface Props {
  frame: Frame;
  scene: Scene;
  renderer: RendererContract;
  createFramePainter: PainterContract['createFramePainter'];
  presentationKey: string;
  width: number;
  height: number;
  visible: boolean;
  onPresent: (presentation: CanvasPresentation | null) => void;
}

interface PaintJob extends CanvasPresentation { scene: Scene; pixelWidth: number; pixelHeight: number }

function waitFor<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void task.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Serialize painting offscreen, retaining at most one pending preview frame. */
export function CanvasFrame({ frame, scene, renderer, createFramePainter, presentationKey, width, height, visible, onPresent }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const enqueue = useRef<((job: PaintJob) => void) | null>(null);
  const callback = useRef(onPresent); callback.current = onPresent;
  const [density, setDensity] = useState(() => window.devicePixelRatio || 1);
  const job: PaintJob = { frame, scene, key: presentationKey, width, height, pixelWidth: Math.max(1, Math.round(width * density)), pixelHeight: Math.max(1, Math.round(height * density)) };
  const latest = useRef(job); latest.current = job;

  useEffect(() => {
    let media: MediaQueryList;
    function update() {
      const ratio = window.devicePixelRatio || 1;
      setDensity(ratio);
      media?.removeEventListener('change', update);
      media = matchMedia(`(resolution: ${ratio}dppx)`);
      media.addEventListener('change', update);
    }
    update(); window.addEventListener('resize', update);
    return () => { media?.removeEventListener('change', update); window.removeEventListener('resize', update); };
  }, []);

  useLayoutEffect(() => {
    const output = canvas.current!;
    const outputContext = output.getContext('2d', { alpha: false });
    if (!outputContext) { callback.current(null); return; }
    const display = outputContext;
    const target = document.createElement('canvas');
    const lifetime = new AbortController();
    let active = true, failed = false, running = false;
    let painter: FramePainter | undefined;
    let pending: PaintJob | null = latest.current;
    let preparedScene: Scene | null = null;
    callback.current(null);

    function dispose() {
      try { painter?.dispose(); } catch { /* The SVG fallback remains available. */ }
      painter = undefined;
      target.width = 0; target.height = 0;
    }

    async function drain() {
      if (running || !painter || !active || failed) return;
      running = true;
      try {
        while (active && pending && !failed) {
          let next: PaintJob = pending; pending = null;
          if (next.width <= 0 || next.height <= 0) continue;
          if (preparedScene !== next.scene) {
            await waitFor(renderer.prepareScene(next.scene), lifetime.signal);
            preparedScene = next.scene;
          }
          if (!active) return;
          // Preparation may take longer than a preview tick; use the newest ready scene.
          const queued = pending as PaintJob | null;
          if (queued) {
            if (queued.scene !== preparedScene) continue;
            next = queued; pending = null;
          }
          if (target.width !== next.pixelWidth) target.width = next.pixelWidth;
          if (target.height !== next.pixelHeight) target.height = next.pixelHeight;
          await painter!.render(next.frame, { signal: lifetime.signal });
          const current = latest.current;
          if (!active || next.key !== current.key || next.pixelWidth !== current.pixelWidth || next.pixelHeight !== current.pixelHeight) continue;
          // Never let a disposed painter or a render for another viewport touch the visible canvas.
          if (output.width !== next.pixelWidth) output.width = next.pixelWidth;
          if (output.height !== next.pixelHeight) output.height = next.pixelHeight;
          display.resetTransform(); display.globalCompositeOperation = 'copy'; display.drawImage(target, 0, 0);
          callback.current({ frame: next.frame, key: next.key, width: next.width, height: next.height });
        }
      } catch {
        if (active) {
          failed = true; pending = null; lifetime.abort(); dispose(); callback.current(null);
        }
      } finally { running = false; }
    }

    enqueue.current = next => {
      if (!active || failed) return;
      pending = next; void drain();
    };
    void Promise.resolve().then(() => createFramePainter(target)).then(instance => {
      if (!active) { instance.dispose(); return; }
      painter = instance; void drain();
    }).catch(() => {
      if (active) { failed = true; pending = null; lifetime.abort(); dispose(); callback.current(null); }
    });
    return () => {
      active = false; pending = null; enqueue.current = null; lifetime.abort(); dispose();
    };
  }, [createFramePainter, renderer, presentationKey]);

  useLayoutEffect(() => { enqueue.current?.(latest.current); }, [frame, scene, width, height, density, createFramePainter, renderer, presentationKey]);

  return <canvas ref={canvas} className="scene-canvas" aria-hidden="true" style={{ visibility: visible ? 'visible' : 'hidden' }} />;
}
