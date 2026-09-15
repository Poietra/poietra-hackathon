import { AudioBufferSink, type Input, type WrappedAudioBuffer } from 'mediabunny';
import type { AudioTrack } from '../../shared/media';
import { openMedia } from './media-source';

export const AUDIO_SAMPLE_RATE = 48000;
export const audibleTracks = (tracks: Record<string, AudioTrack> | undefined): AudioTrack[] => Object.values(tracks ?? {}).filter(track => !track.muted && track.volume > 0 && track.duration > 0);
type Decoder = { track: AudioTrack; input: Input; sink: AudioBufferSink; iterator?: AsyncGenerator<WrappedAudioBuffer, void, unknown>; current?: WrappedAudioBuffer; done?: boolean };

/** Forward-only, one decoded packet per track plus one output chunk, independent of project length. */
export class AudioMixer {
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private decoders: Decoder[] = [];
  private prepared?: Promise<void>;
  private lastEnd = -Infinity;
  constructor(private readonly tracks: AudioTrack[], signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    this.signal.addEventListener('abort', () => { for (const decoder of this.decoders) decoder.input.dispose(); }, { once: true });
  }
  prepare() {
    return this.prepared ??= this.initialize();
  }
  private async initialize() {
    for (const track of this.tracks) {
      this.signal.throwIfAborted();
      const input = await openMedia(track.asset.src, this.signal);
      try {
        const audio = await input.getPrimaryAudioTrack();
        this.signal.throwIfAborted();
        if (!audio || !await audio.canDecode()) throw new Error(`音声「${track.name}」のコーデックを再生できません。`);
        this.signal.throwIfAborted();
        this.decoders.push({ track, input, sink: new AudioBufferSink(audio) });
      } catch (error) { input.dispose(); throw error; }
    }
  }
  /** Time and length are in seconds. Returned stereo PCM has the requested exact timeline position. */
  async mix(start: number, frames: number): Promise<AudioBuffer> {
    await this.prepare(); this.signal.throwIfAborted();
    if (start + 1e-8 < this.lastEnd) throw new Error('音声のシークには新しいミキサーが必要です。');
    const output = new AudioBuffer({ numberOfChannels: 2, sampleRate: AUDIO_SAMPLE_RATE, length: frames });
    const end = start + frames / AUDIO_SAMPLE_RATE;
    for (const decoder of this.decoders) {
      const { track } = decoder;
      const trackStart = track.start / 1000, trackEnd = (track.start + track.duration) / 1000;
      if (end <= trackStart || start >= trackEnd) continue;
      const offset = track.offset / 1000;
      const assetStart = Math.max(start, trackStart) - trackStart + offset;
      const assetEnd = Math.min(end, trackEnd) - trackStart + offset;
      decoder.iterator ??= decoder.sink.buffers(assetStart, offset + track.duration / 1000);
      while (!decoder.done) {
        if (!decoder.current) {
          const next = await decoder.iterator.next(); this.signal.throwIfAborted();
          if (next.done) { decoder.done = true; break; }
          decoder.current = next.value;
        }
        const sample = decoder.current;
        if (sample.timestamp >= assetEnd - 1e-9) break;
        const from = Math.max(assetStart, sample.timestamp);
        const to = Math.min(assetEnd, sample.timestamp + sample.duration);
        if (to > from) {
          const begin = Math.max(0, Math.ceil((from - offset + trackStart - start) * AUDIO_SAMPLE_RATE - 1e-6));
          const finish = Math.min(frames, Math.ceil((to - offset + trackStart - start) * AUDIO_SAMPLE_RATE - 1e-6));
          for (let channel = 0; channel < 2; channel++) {
            const source = sample.buffer.getChannelData(Math.min(channel, sample.buffer.numberOfChannels - 1));
            const target = output.getChannelData(channel);
            for (let index = begin; index < finish; index++) {
              const position = (start + index / AUDIO_SAMPLE_RATE - trackStart + offset - sample.timestamp) * sample.buffer.sampleRate;
              const left = Math.max(0, Math.min(source.length - 1, Math.floor(position)));
              const right = Math.min(source.length - 1, left + 1), fraction = Math.max(0, Math.min(1, position - left));
              target[index] += (source[left] * (1 - fraction) + source[right] * fraction) * track.volume;
            }
          }
        }
        if (sample.timestamp + sample.duration >= assetEnd - 1e-9) break;
        decoder.current = undefined;
      }
    }
    for (let channel = 0; channel < 2; channel++) {
      const samples = output.getChannelData(channel);
      for (let index = 0; index < samples.length; index++) samples[index] = Math.max(-1, Math.min(1, samples[index]));
    }
    this.lastEnd = end;
    return output;
  }
  dispose() {
    this.lifetime.abort();
    for (const decoder of this.decoders) { void decoder.iterator?.return().catch(() => {}); decoder.input.dispose(); }
    this.decoders = [];
  }
}
