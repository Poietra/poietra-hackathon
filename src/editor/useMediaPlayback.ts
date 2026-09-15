import { useEffect, useRef } from 'react';
import type { Scene } from '../../shared/model';
import { AudioMixer, AUDIO_SAMPLE_RATE, audibleTracks } from '../engine/audio';

/** Call unlock from the play user gesture before starting the visual clock. */
export function useMediaPlayback(scene: Scene | null, time: number, playing: boolean, onError?: (error: Error) => void) {
  const context = useRef<AudioContext | null>(null);
  const pending = useRef<AudioMixer | null>(null);
  const latest = useRef({ time, playing, onError }); latest.current = { time, playing, onError };
  const tracks = audibleTracks(scene?.audioTracks);
  const signature = JSON.stringify(tracks);
  const owner = useRef(0);
  useEffect(() => {
    return () => { owner.current++; pending.current?.dispose(); pending.current = null; void context.current?.close(); context.current = null; };
  }, []);
  useEffect(() => {
    if (!playing || tracks.length === 0) { pending.current?.dispose(); pending.current = null; return; }
    const audio = context.current;
    if (!audio || audio.state !== 'running') { latest.current.onError?.(new Error('再生ボタンを押して音声を有効にしてください。')); return; }
    const mixer = pending.current ?? new AudioMixer(tracks); pending.current = null;
    const nodes = new Set<AudioBufferSourceNode>();
    const epoch = { clock: audio.currentTime, position: latest.current.time / 1000 };
    let next = epoch.position, stopped = false, busy = false;
    const pump = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        while (!stopped && next < epoch.position + audio.currentTime - epoch.clock + 0.6) {
          const buffer = await mixer.mix(next, AUDIO_SAMPLE_RATE / 4);
          if (stopped) break;
          const at = epoch.clock + next - epoch.position;
          const skip = Math.max(0, audio.currentTime - at);
          if (skip < buffer.duration) {
            const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
            source.onended = () => { nodes.delete(source); source.disconnect(); };
            nodes.add(source); source.start(Math.max(at, audio.currentTime), skip);
          }
          next += buffer.duration;
        }
      } catch (error) {
        if (!stopped) { stopped = true; for (const node of nodes) { node.stop(); node.disconnect(); } nodes.clear(); latest.current.onError?.(error instanceof Error ? error : new Error(String(error))); }
      } finally { busy = false; }
    };
    void pump(); const interval = setInterval(() => { void pump(); }, 80);
    return () => { stopped = true; clearInterval(interval); mixer.dispose(); for (const node of nodes) { node.stop(); node.disconnect(); } nodes.clear(); };
  }, [playing, signature, scene?.id]);
  return { cancel() { owner.current++; pending.current?.dispose(); pending.current = null; }, async unlock(): Promise<void> {
    if (!tracks.length && typeof AudioContext === 'undefined') return;
    const generation = owner.current;
    const audio = context.current ??= new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    await audio.resume();
    if (generation !== owner.current || !tracks.length) return;
    pending.current?.dispose();
    const mixer = new AudioMixer(tracks); pending.current = mixer;
    try { await mixer.prepare(); } catch (error) { mixer.dispose(); if (pending.current === mixer) pending.current = null; throw error; }
    if (generation !== owner.current) mixer.dispose();
  } };
}
