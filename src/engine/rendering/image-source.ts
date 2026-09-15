import { IMAGE_ASSET_PATH, IMAGE_DATA_URL, IMAGE_BYTES_LIMIT } from '../../../shared/images';

export const blobDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('画像を読み取れませんでした。')); reader.readAsDataURL(blob);
});


export async function imageBlob(src: string, signal?: AbortSignal): Promise<Blob> {
  if (!IMAGE_ASSET_PATH.test(src) && !IMAGE_DATA_URL.test(src)) throw new Error('画像の参照が正しくありません。');
  const response = await fetch(src, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('共有画像を読み込めませんでした。接続を確認して再試行してください。');
  const reader = response.body?.getReader(); if (!reader) throw new Error('画像がありません。');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > IMAGE_BYTES_LIMIT) { await reader.cancel(); throw new Error('画像が大きすぎます。'); }
      chunks.push(new Uint8Array(value));
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('Content-Type')?.split(';')[0] || 'image/png' });
}

