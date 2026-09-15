import { z } from 'zod';

export const MEDIA_FILE_LIMIT = 32 * 1024 * 1024;
export const MEDIA_ROOM_BYTES_LIMIT = 128 * 1024 * 1024;
export const MEDIA_CHUNK_BYTES = 128 * 1024;
export const MEDIA_MIMES = ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/webm'] as const;
export const MEDIA_ACCEPT = MEDIA_MIMES.join(',') + ',audio/x-wav,audio/x-flac,audio/x-m4a,.mp3,.wav,.ogg,.flac,.m4a,.mp4,.webm';
export const MEDIA_ASSET_PATH = /^\/api\/rooms\/([a-zA-Z0-9_-]{16,80})\/media\/([a-f0-9]{64})$/;
export const MEDIA_UPLOAD_PATH = /^\/api\/rooms\/([a-zA-Z0-9_-]{16,80})\/media$/;
export const MEDIA_DATA_URL = /^data:(video\/(?:mp4|webm)|audio\/(?:mpeg|wav|ogg|flac|mp4|webm));base64,[A-Za-z0-9+/]+={0,2}$/;
const mediaTime = z.number().finite().min(0).max(24 * 60 * 60 * 1000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));

export const MediaAssetSchema = z.object({
  src: z.string().max(Math.ceil(MEDIA_FILE_LIMIT * 4 / 3) + 64).refine(value => MEDIA_ASSET_PATH.test(value) || MEDIA_DATA_URL.test(value)),
  mime: z.enum(MEDIA_MIMES), duration: mediaTime.refine(value => value > 0),
  width: z.number().int().min(1).max(8192).optional(), height: z.number().int().min(1).max(8192).optional(),
  hasAudio: z.boolean(), waveform: z.array(z.number().finite().min(0).max(1)).max(160).optional(),
}).refine(asset => !asset.mime.startsWith('video/') || !!asset.width && !!asset.height)
  .refine(asset => !asset.src.startsWith('data:') || asset.src.startsWith(`data:${asset.mime};`));
export interface MediaAsset { src: string; mime: string; duration: number; width?: number; height?: number; hasAudio: boolean; waveform?: number[] }
export const MediaPlaybackSchema = z.object({ start: mediaTime, offset: mediaTime, duration: mediaTime });
export type MediaPlayback = z.infer<typeof MediaPlaybackSchema>;
export const AudioTrackSchema = MediaPlaybackSchema.extend({
  id, name: z.string().max(200), asset: MediaAssetSchema, volume: z.number().finite().min(0).max(1), muted: z.boolean(),
}).refine(track => track.asset.hasAudio && track.offset + track.duration <= track.asset.duration + 1);
export interface AudioTrack extends MediaPlayback { id: string; name: string; asset: MediaAsset; volume: number; muted: boolean }

export function canonicalMediaMime(mime: string): string {
  const value = mime.split(';', 1)[0].trim().toLowerCase();
  return ({ 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-flac': 'audio/flac', 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg' } as Record<string, string>)[value] ?? value;
}

/** Container signatures limit uploads to inert media; the browser checks decodability. */
export function mediaMime(bytes: Uint8Array, declared = ''): string | null {
  const text = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 4 && text(0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.length >= 4 && text(0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 4 && (text(0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0 && (bytes[1] & 0x18) !== 0x08)) return 'audio/mpeg';
  const mime = canonicalMediaMime(declared);
  if (bytes.length >= 12 && text(4, 8) === 'ftyp' && /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4[ABVP] |MSNV)$/.test(text(8, 12))) return mime === 'audio/mp4' ? mime : 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return mime === 'audio/webm' ? mime : 'video/webm';
  return null;
}

export type ByteRange = { start: number; end: number };
/** Single RFC byte range. Multiple/invalid/unsatisfiable ranges return null (416). */
export function mediaByteRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || !size || !match[1] && !match[2]) return null;
  if (!match[1]) {
    const length = Number(match[2]);
    return Number.isSafeInteger(length) && length > 0 ? { start: Math.max(0, size - length), end: size - 1 } : null;
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start ? { start, end: Math.min(size - 1, end) } : null;
}
export const mediaHeaders = (mime: string, digest: string) => ({
  'Content-Type': mime, 'Accept-Ranges': 'bytes', ETag: `"${digest}"`,
  'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin',
});

export class MediaUploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Bound memory and storage while ingesting. The sink must not retain chunk buffers. */
export async function writeMediaChunks(input: AsyncIterable<Uint8Array>, declared: string, contentLength: string | null, write: (chunk: Uint8Array, part: number) => void | Promise<void>): Promise<{ size: number; mime: string }> {
  if (contentLength && Number(contentLength) > MEDIA_FILE_LIMIT) throw new MediaUploadError('音声・動画は 32 MB 以下にしてください。', 413);
  let buffer = new Uint8Array(MEDIA_CHUNK_BYTES), filled = 0, size = 0, part = 0, mime: string | null = null;
  const flush = async () => {
    const chunk = buffer.subarray(0, filled);
    if (!mime) {
      mime = mediaMime(chunk, declared);
      if (!mime) throw new MediaUploadError('対応する音声・動画ファイルを選択してください。');
    }
    await write(chunk, part++); buffer = new Uint8Array(MEDIA_CHUNK_BYTES); filled = 0;
  };
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > MEDIA_FILE_LIMIT) throw new MediaUploadError('音声・動画は 32 MB 以下にしてください。', 413);
    for (let offset = 0; offset < chunk.length;) {
      const length = Math.min(buffer.length - filled, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + length), filled); filled += length; offset += length;
      if (filled === buffer.length) await flush();
    }
  }
  if (filled) await flush();
  if (!size || !mime) throw new MediaUploadError('空の音声・動画ファイルは追加できません。');
  return { size, mime };
}

/** The two storage backends share precisely the same HTTP range semantics. */
export function mediaResponsePlan(request: { range: string | null; ifRange: string | null; ifNoneMatch: string | null }, metadata: { size: number; mime: string }, digest: string): { status: number; headers: Record<string, string>; range?: ByteRange } {
  const headers: Record<string, string> = mediaHeaders(metadata.mime, digest);
  if (request.ifNoneMatch?.split(',').some(value => value.trim().replace(/^W\//, '') === headers.ETag || value.trim() === '*')) return { status: 304, headers };
  let range: ByteRange = { start: 0, end: metadata.size - 1 }, status = 200;
  if (request.range && /^bytes=/i.test(request.range.trim()) && (!request.ifRange || request.ifRange === headers.ETag)) {
    const requested = mediaByteRange(request.range, metadata.size);
    if (!requested) return { status: 416, headers: { ...headers, 'Content-Range': `bytes */${metadata.size}`, 'Content-Length': '0' } };
    range = requested; status = 206;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${metadata.size}`;
  }
  headers['Content-Length'] = String(range.end - range.start + 1);
  return { status, headers, range };
}
