import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { MEDIA_ASSET_PATH, MEDIA_DATA_URL, MEDIA_FILE_LIMIT } from '../../shared/media';

/** Media inputs are owned by a painter/mixer and always disposed with that owner. */
export async function openMedia(src: string, signal: AbortSignal): Promise<Input> {
  signal.throwIfAborted();
  if (!MEDIA_ASSET_PATH.test(src) && !MEDIA_DATA_URL.test(src)) throw new Error('素材の参照が正しくありません。');
  const response = await fetch(src, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
  if (!response.ok || !response.body) throw new Error('共有素材を読み込めませんでした。');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MEDIA_FILE_LIMIT) throw new Error('素材が大きすぎます。');
      chunks.push(new Uint8Array(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  signal.throwIfAborted();
  return new Input({ source: new BlobSource(new Blob(chunks)), formats: ALL_FORMATS });
}
