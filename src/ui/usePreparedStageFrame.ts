import { useEffect, useMemo, useRef, useState } from 'react';
import type { Frame } from '../engine/evaluate';
import type { RendererContract } from '../engine/render-contract';

/** Decode at most one frame at a time and keep only the newest pending preview. */
export function usePreparedStageFrame(source: Frame, renderer: RendererContract, scope: string) {
  const [prepared, setPrepared] = useState<{ scope: string; source: Frame; frame: Frame } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; source: Frame } | null>(null);
  const enqueue = useRef<((frame: Frame) => void) | null>(null);
  const needsPreparation = !!renderer.prepareFrame && source.objects.some(item => item.object.kind === 'video' && !item.videoFrame);

  useEffect(() => {
    const lifetime = new AbortController();
    let running = false, pending: Frame | null = null;
    async function drain() {
      if (running) return;
      running = true;
      try {
        while (!lifetime.signal.aborted && pending) {
          const next: Frame = pending; pending = null;
          try {
            const frame = structuredClone(next);
            await renderer.prepareFrame?.(frame, lifetime.signal);
            if (lifetime.signal.aborted) return;
            setPrepared({ scope, source: next, frame }); setFailure(null);
          } catch {
            if (!lifetime.signal.aborted) setFailure({ scope, source: next });
          }
        }
      } finally { running = false; }
    }
    enqueue.current = frame => { pending = frame; void drain(); };
    return () => { lifetime.abort(); pending = null; enqueue.current = null; };
  }, [renderer, scope]);

  useEffect(() => { if (needsPreparation) enqueue.current?.(source); }, [source, renderer, scope, needsPreparation]);
  const frame = useMemo(() => {
    if (!needsPreparation) return source;
    if (prepared?.scope === scope) return prepared.frame;
    // No old scene or unprepared video snapshot may appear in a new composition.
    return { ...source, objects: source.objects.filter(item => item.object.kind !== 'video') };
  }, [source, needsPreparation, prepared, scope]);
  return { frame, ready: !needsPreparation || prepared?.scope === scope, pending: needsPreparation && prepared?.source !== source, error: failure?.scope === scope && failure.source === source };
}
