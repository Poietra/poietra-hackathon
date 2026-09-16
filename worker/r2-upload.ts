import { createHash } from 'node:crypto';
import { IMAGE_BYTES_LIMIT, imageMime } from '../shared/images';
import { MEDIA_FILE_LIMIT, MediaUploadError, mediaMime, writeMediaChunks } from '../shared/media';

interface UploadedAsset { size: number; mime: string; digest: string }

// All non-final R2 multipart parts must have the same size, at least 5 MiB.
// Reuse this one buffer only after R2 has finished consuming the previous part.
const PART_BYTES = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const cacheControl = 'private, max-age=31536000, immutable';

function cancelled(): MediaUploadError {
  return new MediaUploadError('アップロードを中止しました。', 499);
}

function storageFailure(error: unknown): MediaUploadError {
  if (error instanceof MediaUploadError) return error;
  return new MediaUploadError('素材を保存できませんでした。もう一度お試しください。', 502);
}

/** The caller owns the unique key and publishes its room metadata only after this resolves. */
export async function uploadMediaToR2(bucket: R2Bucket, key: string, request: Request): Promise<UploadedAsset> {
  const reader = request.body?.getReader();
  if (!reader) throw new MediaUploadError('音声・動画ファイルを選択してください。');
  const hash = createHash('sha256'), parts: R2UploadedPart[] = [];
  const lengthHeader = request.headers.get('Content-Length');
  const declaredType = request.headers.get('Content-Type') ?? '';
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), UPLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const interruption = () => request.signal.aborted ? cancelled() : new MediaUploadError('アップロードが時間内に完了しませんでした。もう一度お試しください。', 408);
  let upload: R2MultipartUpload | undefined;
  let buffer: Uint8Array<ArrayBuffer> | undefined, filled = 0;
  let cancellation: Promise<void> | undefined;
  const checkActive = () => { if (signal.aborted) throw interruption(); };
  const cancelReader = () => cancellation ??= reader.cancel().catch(() => {});
  const onAbort = () => { void cancelReader(); };
  signal.addEventListener('abort', onAbort, { once: true });

  async function* chunks() {
    while (true) {
      checkActive();
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader!.read(); }
      catch { throw signal.aborted ? interruption() : new MediaUploadError('素材の読み込みが中断されました。もう一度お試しください。'); }
      checkActive();
      if (result.done) return;
      yield result.value;
    }
  }

  async function flush() {
    if (!filled || !buffer || !upload) return;
    checkActive();
    parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
    checkActive();
    filled = 0;
  }

  try {
    checkActive();
    if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)))) {
      throw new MediaUploadError('素材のサイズが正しくありません。');
    }
    if (lengthHeader !== null && Number(lengthHeader) > MEDIA_FILE_LIMIT) {
      throw new MediaUploadError('音声・動画は 32 MB 以下にしてください。', 413);
    }
    if (lengthHeader !== null && Number(lengthHeader) === 0) {
      throw new MediaUploadError('空の音声・動画ファイルは追加できません。');
    }
    const metadata = await writeMediaChunks(chunks(), declaredType, lengthHeader, async chunk => {
      checkActive();
      if (!upload) {
        // writeMediaChunks has already validated the first chunk's signature.
        const mime = mediaMime(chunk, declaredType)!;
        upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: mime, cacheControl } });
        checkActive();
        buffer = new Uint8Array(PART_BYTES);
      }
      hash.update(chunk);
      for (let offset = 0; offset < chunk.length;) {
        const count = Math.min(PART_BYTES - filled, chunk.length - offset);
        buffer!.set(chunk.subarray(offset, offset + count), filled);
        filled += count; offset += count;
        if (filled === PART_BYTES) await flush();
      }
    });
    if (lengthHeader !== null && metadata.size !== Number(lengthHeader)) {
      throw new MediaUploadError('素材のサイズが一致しません。もう一度お試しください。');
    }
    checkActive();
    await flush();
    checkActive();
    // The validator rejects empty/invalid inputs before this point.
    if (!upload) throw new MediaUploadError('空の音声・動画ファイルは追加できません。');
    const completed = await upload.complete(parts);
    checkActive();
    if (completed.size !== metadata.size) throw new Error('Incomplete R2 media upload');
    return { ...metadata, digest: hash.digest('hex') };
  } catch (error) {
    await cancelReader();
    if (upload) {
      try { await upload.abort(); }
      catch { console.warn(JSON.stringify({ event: 'r2_multipart_abort_failed' })); }
    }
    throw signal.aborted ? interruption() : storageFailure(error);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    await cancelReader();
    reader.releaseLock();
  }
}

/** Bound the incoming image's reading time before publishing any R2 metadata. */
export async function uploadImageRequestToR2(bucket: R2Bucket, key: string, request: Request): Promise<UploadedAsset> {
  const reader = request.body?.getReader();
  if (!reader) throw new MediaUploadError('画像がありません。');
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), UPLOAD_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  const interruption = () => request.signal.aborted ? cancelled() : new MediaUploadError('アップロードが時間内に完了しませんでした。もう一度お試しください。', 408);
  const checkActive = () => { if (signal.aborted) throw interruption(); };
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => cancellation ??= reader.cancel().catch(() => {});
  const onAbort = () => { void cancelReader(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    checkActive();
    const lengthHeader = request.headers.get('Content-Length');
    if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)))) {
      throw new MediaUploadError('画像のサイズが正しくありません。');
    }
    if (lengthHeader !== null && Number(lengthHeader) > IMAGE_BYTES_LIMIT) {
      throw new MediaUploadError('画像データは 1 MB 以下にしてください。');
    }
    if (lengthHeader !== null && Number(lengthHeader) === 0) throw new MediaUploadError('画像がありません。');
    const buffer = new Uint8Array(IMAGE_BYTES_LIMIT);
    let size = 0;
    while (true) {
      checkActive();
      let result: ReadableStreamReadResult<Uint8Array>;
      try { result = await reader.read(); }
      catch { throw signal.aborted ? interruption() : new MediaUploadError('画像の読み込みが中断されました。もう一度お試しください。'); }
      checkActive();
      if (result.done) break;
      if (size + result.value.byteLength > IMAGE_BYTES_LIMIT) throw new MediaUploadError('画像データは 1 MB 以下にしてください。');
      buffer.set(result.value, size); size += result.value.byteLength;
    }
    if (lengthHeader !== null && size !== Number(lengthHeader)) throw new MediaUploadError('画像のサイズが一致しません。もう一度お試しください。');
    const bytes = buffer.subarray(0, size), mime = imageMime(bytes);
    if (!mime) throw new MediaUploadError('PNG・JPEG・WebP の画像を選択してください。');
    checkActive();
    // Let an in-flight put settle before rejecting; the caller then deletes its unique key.
    const metadata = await uploadImageToR2(bucket, key, bytes, mime);
    checkActive();
    return metadata;
  } catch (error) {
    throw signal.aborted ? interruption() : storageFailure(error);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    await cancelReader();
    reader.releaseLock();
  }
}

/** Images are already bounded by the request reader or image-generation adapter. */
export async function uploadImageToR2(bucket: R2Bucket, key: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<UploadedAsset> {
  if (bytes.byteLength > IMAGE_BYTES_LIMIT) throw new MediaUploadError('画像データは 1 MB 以下にしてください。', 413);
  const detected = imageMime(bytes);
  if (!detected || detected !== mime) throw new MediaUploadError('PNG・JPEG・WebP の画像を選択してください。');
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    const object = await bucket.put(key, bytes, { httpMetadata: { contentType: detected, cacheControl }, sha256: digest });
    if (object.size !== bytes.byteLength) throw new Error('Incomplete R2 image upload');
    return { size: bytes.byteLength, mime: detected, digest };
  } catch (error) { throw storageFailure(error); }
}
