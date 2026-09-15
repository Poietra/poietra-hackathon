import { z } from 'zod';

export const IMAGE_BYTES_LIMIT = 1024 * 1024;
export const IMAGE_ROOM_BYTES_LIMIT = 64 * 1024 * 1024;
export const IMAGE_EDGE_LIMIT = 2048;
export const IMAGE_ASSET_PATH = /^\/api\/rooms\/([a-zA-Z0-9_-]{16,80})\/images\/([a-f0-9]{64})$/;
export const IMAGE_UPLOAD_PATH = /^\/api\/rooms\/([a-zA-Z0-9_-]{16,80})\/images$/;
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const imageSource = z.string().max(Math.ceil(IMAGE_BYTES_LIMIT * 4 / 3) + 64).refine(value => IMAGE_ASSET_PATH.test(value) || IMAGE_DATA_URL.test(value));
export const ImageAssetSchema = z.object({ src: imageSource, width: z.number().int().min(1).max(IMAGE_EDGE_LIMIT), height: z.number().int().min(1).max(IMAGE_EDGE_LIMIT) });
export type ImageAsset = z.infer<typeof ImageAssetSchema>;

/** Uploaded assets are immutable, raster-only, and content addressed. */
export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 16 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
export async function imageDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export async function readImageBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('画像がありません。');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > IMAGE_BYTES_LIMIT) { await reader.cancel(); throw new Error('画像データは 1 MB 以下にしてください。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (!imageMime(bytes)) throw new Error('PNG・JPEG・WebP の画像を選択してください。');
  return bytes;
}
export const imageHeaders = (mime: string) => ({ 'Content-Type': mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' });
