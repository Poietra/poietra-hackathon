import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_BYTES_LIMIT } from '../shared/images';
import { MEDIA_CHUNK_BYTES, MEDIA_FILE_LIMIT } from '../shared/media';
// Keep Workers' generated globals out of the app's DOM TypeScript compilation.
// The helper is typechecked by tsconfig.worker.json and exercised here in Node.
const helperPath = '../worker/r2-upload';
const { uploadImageRequestToR2, uploadImageToR2, uploadMediaToR2 } = await import(helperPath);

const PART_BYTES = 5 * 1024 * 1024;
const key = 'rooms/example/pending/unique-upload';
function wav(size: number) { const bytes = new Uint8Array(size); bytes.set(new TextEncoder().encode('RIFF0000WAVE')); return bytes; }
function png(size = 32) { const bytes = new Uint8Array(size); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); return bytes; }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function reached() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function mockBucket() {
  const uploaded: Uint8Array[] = [];
  const multipart = {
    key, uploadId: 'upload-1',
    uploadPart: vi.fn(async (partNumber: number, value: Uint8Array) => {
      if (!(value instanceof Uint8Array)) throw new Error('Expected a bounded typed-array part');
      uploaded.push(value.slice());
      return { partNumber, etag: `part-${partNumber}` };
    }),
    complete: vi.fn(async () => ({ size: uploaded.reduce((sum, part) => sum + part.byteLength, 0) })),
    abort: vi.fn(async () => {}),
  };
  const bucket = {
    createMultipartUpload: vi.fn(async () => multipart),
    resumeMultipartUpload: () => multipart,
    put: vi.fn(async (_key: string, value: Uint8Array) => {
      if (!(value instanceof Uint8Array)) throw new Error('Expected bounded image bytes');
      uploaded.push(value.slice()); return { size: value.byteLength };
    }),
    head: async () => null, get: async () => null,
    delete: async () => {}, list: async () => ({ objects: [], truncated: false }),
  };
  return { bucket, multipart, uploaded };
}

function request(bytes: Uint8Array, options: { declaredSize?: number | string; chunkSize?: number; signal?: AbortSignal } = {}) {
  let offset = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const next = Math.min(bytes.length, offset + (options.chunkSize ?? 31_337));
      controller.enqueue(bytes.subarray(offset, next)); offset = next;
    }, cancel,
  });
  return {
    cancel,
    input: new Request('https://example.test/upload', {
      method: 'POST', body, signal: options.signal,
      headers: { 'Content-Type': 'audio/x-wav', ...(options.declaredSize !== undefined ? { 'Content-Length': String(options.declaredSize) } : {}) },
      ...{ duplex: 'half' },
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe('bounded media upload to R2', () => {
  it.each([undefined, PART_BYTES * 2 + 73])('streams exact bytes and digest through sequential uniform parts (declared size %s)', async declaredSize => {
    const bytes = wav(PART_BYTES * 2 + 73); bytes[PART_BYTES + 9] = 123;
    const { bucket, multipart, uploaded } = mockBucket();
    const { input } = request(bytes, { declaredSize });
    expect(await uploadMediaToR2(bucket, key, input)).toEqual({ size: bytes.length, mime: 'audio/wav', digest: digest(bytes) });
    expect(uploaded.map(part => part.length)).toEqual([PART_BYTES, PART_BYTES, 73]);
    expect(Buffer.concat(uploaded).equals(Buffer.from(bytes))).toBe(true);
    expect(bucket.createMultipartUpload).toHaveBeenCalledWith(key, { httpMetadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=31536000, immutable' } });
    expect(multipart.complete).toHaveBeenCalledWith([{ partNumber: 1, etag: 'part-1' }, { partNumber: 2, etag: 'part-2' }, { partNumber: 3, etag: 'part-3' }]);
    expect(multipart.abort).not.toHaveBeenCalled(); expect(input.body!.locked).toBe(false);
  });

  it.each([44, PART_BYTES])('supports final parts and exact part boundaries (%i bytes)', async size => {
    const bytes = wav(size), { bucket, uploaded } = mockBucket();
    expect((await uploadMediaToR2(bucket, key, request(bytes).input)).size).toBe(size);
    expect(uploaded.map(part => part.length)).toEqual([size]);
  });

  it('stops reading while a part is being uploaded and safely reuses its buffer afterward', async () => {
    const { bucket, multipart, uploaded } = mockBucket(), partStarted = reached(), release = reached();
    let received = 0, calls = 0;
    vi.mocked(multipart.uploadPart).mockImplementation(async (partNumber, value) => {
      if (!(value instanceof Uint8Array)) throw new Error('Expected bytes');
      calls += 1;
      if (calls === 1) { partStarted.resolve(); await release.promise; }
      uploaded.push(value.slice()); return { partNumber, etag: `part-${partNumber}` };
    });
    const bytes = wav(PART_BYTES * 2), body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (received === bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.subarray(received, received + MEDIA_CHUNK_BYTES)); received += MEDIA_CHUNK_BYTES;
      },
    }, { highWaterMark: 0 });
    const input = new Request('https://example.test/upload', { method: 'POST', body, ...{ duplex: 'half' } });
    const result = uploadMediaToR2(bucket, key, input);
    await partStarted.promise;
    expect(received).toBe(PART_BYTES); expect(calls).toBe(1);
    release.resolve(); await result;
    expect(Buffer.concat(uploaded).equals(Buffer.from(bytes))).toBe(true);
  });

  it.each(['0', '-1', '1e3', 'oops', String(MEDIA_FILE_LIMIT + 1)])('rejects invalid declared sizes without completing an object (%s)', async declaredSize => {
    const { bucket, multipart } = mockBucket(), { input } = request(wav(44), { declaredSize });
    await expect(uploadMediaToR2(bucket, key, input)).rejects.toMatchObject({ status: Number(declaredSize) > MEDIA_FILE_LIMIT ? 413 : 400 });
    expect(multipart.complete).not.toHaveBeenCalled(); expect(input.body!.locked).toBe(false);
  });

  it('rejects invalid containers before creating any R2 upload', async () => {
    const { bucket } = mockBucket(), { input } = request(new TextEncoder().encode('<script>no</script>'));
    await expect(uploadMediaToR2(bucket, key, input)).rejects.toMatchObject({ status: 400 });
    expect(bucket.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('aborts already-uploaded parts when a chunked body exceeds 32 MiB', async () => {
    const { bucket, multipart } = mockBucket();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(sent ? new Uint8Array(MEDIA_CHUNK_BYTES) : wav(MEDIA_CHUNK_BYTES));
      sent += MEDIA_CHUNK_BYTES;
    } }, { highWaterMark: 0 });
    const input = new Request('https://example.test/upload', { method: 'POST', body, ...{ duplex: 'half' } });
    await expect(uploadMediaToR2(bucket, key, input)).rejects.toMatchObject({ status: 413 });
    expect(sent).toBe(MEDIA_FILE_LIMIT + MEDIA_CHUNK_BYTES);
    expect(multipart.abort).toHaveBeenCalledOnce(); expect(multipart.complete).not.toHaveBeenCalled();
  });

  it.each(['create', 'part', 'complete'])('cleans up when R2 rejects %s', async stage => {
    const { bucket, multipart } = mockBucket(), { input, cancel } = request(wav(PART_BYTES * 2));
    if (stage === 'create') vi.mocked(bucket.createMultipartUpload).mockRejectedValue(new Error('R2 unavailable'));
    if (stage === 'part') vi.mocked(multipart.uploadPart).mockRejectedValue(new Error('R2 unavailable'));
    if (stage === 'complete') vi.mocked(multipart.complete).mockRejectedValue(new Error('R2 unavailable'));
    await expect(uploadMediaToR2(bucket, key, input)).rejects.toMatchObject({ status: 502 });
    if (stage !== 'create') expect(multipart.abort).toHaveBeenCalledOnce();
    if (stage !== 'complete') expect(cancel).toHaveBeenCalledOnce();
    expect(input.body!.locked).toBe(false);
  });

  it('cancels a stalled input read when the client aborts, and aborts its multipart session', async () => {
    const { bucket, multipart } = mockBucket(), controller = new AbortController(), stalled = reached(), cancel = vi.fn();
    let first = true;
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (first) { first = false; stream.enqueue(wav(MEDIA_CHUNK_BYTES)); }
      else stalled.resolve();
    }, cancel }, { highWaterMark: 0 });
    const input = new Request('https://example.test/upload', { method: 'POST', body, signal: controller.signal, ...{ duplex: 'half' } });
    const result = uploadMediaToR2(bucket, key, input), rejected = expect(result).rejects.toMatchObject({ status: 499 });
    await stalled.promise; controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(multipart.abort).toHaveBeenCalledOnce(); expect(multipart.complete).not.toHaveBeenCalled();
  });

  it('bounds stalled uploads to five minutes', async () => {
    vi.useFakeTimers();
    const { bucket } = mockBucket(), cancel = vi.fn();
    const input = new Request('https://example.test/upload', { method: 'POST', body: new ReadableStream({ cancel }), ...{ duplex: 'half' } });
    const result = uploadMediaToR2(bucket, key, input), rejected = expect(result).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(bucket.createMultipartUpload).not.toHaveBeenCalled();
  });

  it.each(['create', 'part', 'complete'])('cleans up if cancellation happens during R2 %s', async stage => {
    const { bucket, multipart } = mockBucket(), controller = new AbortController(), started = reached(), release = reached();
    const { input } = request(wav(PART_BYTES + 100), { signal: controller.signal });
    if (stage === 'create') vi.mocked(bucket.createMultipartUpload).mockImplementation(async () => { started.resolve(); await release.promise; return multipart; });
    if (stage === 'part') vi.mocked(multipart.uploadPart).mockImplementation(async partNumber => { started.resolve(); await release.promise; return { partNumber, etag: 'part' }; });
    if (stage === 'complete') vi.mocked(multipart.complete).mockImplementation(async () => { started.resolve(); await release.promise; return { size: PART_BYTES + 100 }; });
    const result = uploadMediaToR2(bucket, key, input), rejected = expect(result).rejects.toMatchObject({ status: 499 });
    await started.promise; controller.abort(); release.resolve(); await rejected;
    expect(multipart.abort).toHaveBeenCalledOnce();
    if (stage !== 'complete') expect(multipart.complete).not.toHaveBeenCalled();
    expect(input.body!.locked).toBe(false);
  });

  it('aborts partial uploads if the declared size disagrees with received bytes', async () => {
    const { bucket, multipart } = mockBucket();
    await expect(uploadMediaToR2(bucket, key, request(wav(PART_BYTES + 30), { declaredSize: PART_BYTES + 40 }).input)).rejects.toMatchObject({ status: 400 });
    expect(multipart.abort).toHaveBeenCalledOnce(); expect(multipart.complete).not.toHaveBeenCalled();
  });

  it('cleans up if the request body fails after its first valid chunk', async () => {
    const { bucket, multipart } = mockBucket(); let first = true;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (first) { first = false; controller.enqueue(wav(MEDIA_CHUNK_BYTES)); }
      else controller.error(new Error('connection lost'));
    } }, { highWaterMark: 0 });
    const input = new Request('https://example.test/upload', { method: 'POST', body, ...{ duplex: 'half' } });
    await expect(uploadMediaToR2(bucket, key, input)).rejects.toMatchObject({ status: 400 });
    expect(multipart.abort).toHaveBeenCalledOnce(); expect(input.body!.locked).toBe(false);
  });
});

describe('bounded image upload to R2', () => {
  it('reads an incoming image with bounded storage and canonicalizes its raster type', async () => {
    const { bucket, uploaded } = mockBucket(), bytes = png(), { input } = request(bytes, { declaredSize: bytes.length, chunkSize: 3 });
    expect(await uploadImageRequestToR2(bucket, key, input)).toEqual({ size: bytes.length, mime: 'image/png', digest: digest(bytes) });
    expect(uploaded[0]).toEqual(bytes); expect(input.body!.locked).toBe(false);
  });

  it.each(['abort', 'timeout'])('stops stalled image input on %s without uploading or publishing', async cause => {
    if (cause === 'timeout') vi.useFakeTimers();
    const { bucket } = mockBucket(), controller = new AbortController(), stalled = reached(), cancel = vi.fn();
    let first = true;
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (first) { first = false; stream.enqueue(png().subarray(0, 16)); }
      else stalled.resolve();
    }, cancel }, { highWaterMark: 0 });
    const input = new Request('https://example.test/upload', { method: 'POST', body, signal: controller.signal, ...{ duplex: 'half' } });
    const result = uploadImageRequestToR2(bucket, key, input), rejected = expect(result).rejects.toMatchObject({ status: cause === 'abort' ? 499 : 408 });
    await stalled.promise;
    if (cause === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(bucket.put).not.toHaveBeenCalled(); expect(input.body!.locked).toBe(false);
  });

  it.each(['abort', 'timeout'])('rejects metadata after an in-flight image put settles following %s', async cause => {
    if (cause === 'timeout') vi.useFakeTimers();
    const { bucket } = mockBucket(), controller = new AbortController(), started = reached(), release = reached();
    const { input } = request(png(), { signal: controller.signal });
    vi.mocked(bucket.put).mockImplementation(async (_key, bytes) => { started.resolve(); await release.promise; return { size: bytes.byteLength }; });
    const result = uploadImageRequestToR2(bucket, key, input), rejected = expect(result).rejects.toMatchObject({ status: cause === 'abort' ? 499 : 408 });
    await started.promise;
    if (cause === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    release.resolve(); await rejected;
    expect(bucket.put).toHaveBeenCalledOnce(); expect(input.body!.locked).toBe(false);
  });

  it('rejects oversized chunked images and size mismatches before storing them', async () => {
    const { bucket } = mockBucket();
    await expect(uploadImageRequestToR2(bucket, key, request(png(IMAGE_BYTES_LIMIT + 1)).input)).rejects.toMatchObject({ status: 400 });
    await expect(uploadImageRequestToR2(bucket, key, request(png(), { declaredSize: IMAGE_BYTES_LIMIT + 1 }).input)).rejects.toMatchObject({ status: 400 });
    await expect(uploadImageRequestToR2(bucket, key, request(png(), { declaredSize: 33 }).input)).rejects.toMatchObject({ status: 400 });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('sniffs image type, computes one content digest, and supplies it for integrity checking', async () => {
    const { bucket } = mockBucket(), bytes = png();
    expect(await uploadImageToR2(bucket, key, bytes, 'image/png')).toEqual({ size: bytes.length, mime: 'image/png', digest: digest(bytes) });
    expect(bucket.put).toHaveBeenCalledWith(key, bytes, { httpMetadata: { contentType: 'image/png', cacheControl: 'private, max-age=31536000, immutable' }, sha256: digest(bytes) });
  });
  it('rejects oversized, mismatched, and invalid image bytes before uploading', async () => {
    const { bucket } = mockBucket();
    await expect(uploadImageToR2(bucket, key, png(IMAGE_BYTES_LIMIT + 1), 'image/png')).rejects.toMatchObject({ status: 413 });
    await expect(uploadImageToR2(bucket, key, png(), 'image/jpeg')).rejects.toMatchObject({ status: 400 });
    await expect(uploadImageToR2(bucket, key, new TextEncoder().encode('<svg />'), 'image/png')).rejects.toMatchObject({ status: 400 });
    expect(bucket.put).not.toHaveBeenCalled();
  });
  it('reports storage failures without exposing R2 response details', async () => {
    const { bucket } = mockBucket(); vi.mocked(bucket.put).mockRejectedValue(new Error('internal secret info'));
    await expect(uploadImageToR2(bucket, key, png(), 'image/png')).rejects.toMatchObject({ status: 502, message: '素材を保存できませんでした。もう一度お試しください。' });
  });
});
