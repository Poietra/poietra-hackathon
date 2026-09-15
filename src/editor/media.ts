import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import { MEDIA_ASSET_PATH, MEDIA_FILE_LIMIT, MEDIA_DATA_URL, canonicalMediaMime, mediaMime, type MediaAsset } from '../../shared/media';

export type ImportProgress = { phase: 'reading' | 'waveform' | 'uploading' | 'saving'; progress: number };
const mimeByExtension: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4' };

/** Inspect/decode before upload so unsupported codecs never become broken shared objects. */
export async function prepareMedia(file: File, signal: AbortSignal, progress?: (value: ImportProgress) => void): Promise<{ asset: Omit<MediaAsset, 'src'>; blob: Blob; kind: 'audio' | 'video' }> {
  signal.throwIfAborted();
  if (!file.size || file.size > MEDIA_FILE_LIMIT) throw new Error(`音声・動画は ${MEDIA_FILE_LIMIT / 1024 / 1024} MB 以下にしてください。`);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const cancel = () => input.dispose();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    progress?.({ phase: 'reading', progress: 0 });
    const [video, audio, seconds] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), input.computeDuration()]);
    signal.throwIfAborted();
    if ((!video && !audio) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new Error('10 分以内の音声・動画を選択してください。');
    if (video && !await video.canDecode()) throw new Error('この動画のコーデックを再生できません。対応する MP4 / WebM を選択してください。');
    if (audio && !await audio.canDecode()) throw new Error('この音声のコーデックを再生できません。MP3 / WAV などに変換してください。');
    const duration = Math.round(seconds * 1000);
    const width = video ? await video.getDisplayWidth() : undefined;
    const height = video ? await video.getDisplayHeight() : undefined;
    if (video && (!width || !height || width > 8192 || height > 8192)) throw new Error('動画の解像度は 8,192 px 以下にしてください。');
    if (video) {
      const first = await new CanvasSink(video, { width: 160 }).getCanvas(0);
      if (!first) throw new Error('動画の最初のフレームを読み取れませんでした。');
    }
    let waveform: number[] | undefined;
    if (audio) {
      progress?.({ phase: 'waveform', progress: 0 });
      waveform = [];
      const sink = new AudioBufferSink(audio);
      for await (const sample of sink.buffersAtTimestamps(Array.from({ length: 128 }, (_, i) => i / 128 * seconds))) {
        signal.throwIfAborted();
        let peak = 0;
        if (sample) for (let channel = 0; channel < sample.buffer.numberOfChannels; channel++) {
          const values = sample.buffer.getChannelData(channel);
          for (let i = 0; i < values.length; i++) peak = Math.max(peak, Math.abs(values[i]));
        }
        waveform.push(Math.min(1, Math.round(peak * 1000) / 1000));
        progress?.({ phase: 'waveform', progress: waveform.length / 128 });
      }
    }
    signal.throwIfAborted();
    const kind = video ? 'video' : 'audio';
    const declared = canonicalMediaMime(file.type || mimeByExtension[file.name.split('.').at(-1)?.toLowerCase() || ''] || '');
    const detected = mediaMime(new Uint8Array(await file.slice(0, 32).arrayBuffer()), declared);
    const mime = detected?.endsWith('/mp4') ? `${kind}/mp4` : detected?.endsWith('/webm') ? `${kind}/webm` : detected;
    if (!mime) throw new Error('対応する MP4・WebM・MP3・WAV・OGG・FLAC・M4A を選択してください。');
    return { kind, blob: file.slice(0, file.size, mime), asset: { mime, duration, width, height, hasAudio: !!audio, ...(waveform ? { waveform } : {}) } };
  } finally { signal.removeEventListener('abort', cancel); input.dispose(); }
}

export function uploadMedia(room: string, blob: Blob, signal?: AbortSignal, progress?: (value: ImportProgress) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) { reject(signal.reason); return; }
    xhr.open('POST', `/api/rooms/${room}/media`); xhr.timeout = 120000;
    xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = event => progress?.({ phase: event.loaded >= event.total && event.lengthComputable ? 'saving' : 'uploading', progress: event.lengthComputable ? event.loaded / event.total : 0 });
    xhr.onload = () => {
      done();
      let data: { src?: string; error?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* Error response may be plain text. */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.src && MEDIA_ASSET_PATH.test(data.src)) resolve(data.src);
      else reject(new Error(data.error || '素材を保存できませんでした。接続を確認して再試行してください。'));
    };
    xhr.onerror = xhr.ontimeout = () => { done(); reject(new Error('素材のアップロードに失敗しました。接続を確認して再試行してください。')); };
    xhr.onabort = () => { done(); reject(new DOMException('素材の追加を中止しました。', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    progress?.({ phase: 'uploading', progress: 0 }); xhr.send(blob);
  });
}

export async function mediaBlob(src: string, signal?: AbortSignal): Promise<Blob> {
  if (!MEDIA_ASSET_PATH.test(src) && !MEDIA_DATA_URL.test(src)) throw new Error('素材の参照が正しくありません。');
  const response = await fetch(src, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('共有素材を読み込めませんでした。');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MEDIA_FILE_LIMIT) { await reader.cancel(); throw new Error('素材が大きすぎます。'); }
      chunks.push(new Uint8Array(value));
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('Content-Type')?.split(';')[0] || 'application/octet-stream' });
}
