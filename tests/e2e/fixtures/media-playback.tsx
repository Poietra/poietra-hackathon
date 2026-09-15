import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useMediaPlayback } from '../../../src/editor/useMediaPlayback';
import { makeDemoProject } from '../../../shared/demo';
import type { Scene } from '../../../shared/model';

const calls: { type: string; at?: number; offset?: number; first?: number; rms?: number }[] = [];
const contexts: AudioContext[] = [];
const NativeContext = window.AudioContext;
class ObservedContext extends NativeContext {
  constructor(options?: AudioContextOptions) { super(options); contexts.push(this); }
  createBufferSource() {
    const node = super.createBufferSource(); const start = node.start.bind(node), stop = node.stop.bind(node);
    node.start = (when = 0, offset = 0, duration?: number) => {
      const values = node.buffer!.getChannelData(0);
      calls.push({ type: 'start', at: when, offset, first: values[0], rms: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) });
      start(when, offset, duration);
    };
    node.stop = (when?: number) => { calls.push({ type: 'stop' }); stop(when); };
    return node;
  }
}
window.AudioContext = ObservedContext;
const scene: Scene = makeDemoProject().scenes['scene-1'];
const rate = 48000, wave = new ArrayBuffer(44 + rate * 2 * 2), view = new DataView(wave);
const str = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
str(0, 'RIFF'); view.setUint32(4, wave.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, wave.byteLength - 44, true);
for (let i = 0; i < rate * 2; i++) view.setInt16(44 + i * 2, i < rate / 2 ? 0 : Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 16000), true);
const src = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(new Blob([wave], { type: 'audio/wav' })); });
scene.audioTracks = { tone: { id: 'tone', name: 'Tone', start: 0, offset: 500, duration: 1500, volume: 0.5, muted: false, asset: { src, mime: 'audio/wav', duration: 2000, hasAudio: true } } };
function App() {
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0), [error, setError] = useState('');
  const media = useMediaPlayback(scene, time, playing, failure => { setPlaying(false); setError(failure.message); });
  useEffect(() => { if (!playing) return; const interval = setInterval(() => setTime(value => value + 20), 20); return () => clearInterval(interval); }, [playing]);
  return <><button onClick={async () => { await media.unlock(); setPlaying(true); }}>Play</button><button onClick={() => setPlaying(false)}>Pause</button><button onClick={() => { setPlaying(false); setTime(1200); }}>Seek</button><button onClick={() => setTime(1200)}>Live seek</button><output>{error || `${playing}:${time}`}</output></>;
}
const root = createRoot(document.getElementById('root')!); root.render(<App/>);
Object.assign(window, { mediaPlaybackFixture: { calls, contexts, unmount: () => root.unmount() } });
