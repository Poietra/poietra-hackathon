import { IMAGE_ASSET_PATH, IMAGE_UPLOAD_PATH, IMAGE_BYTES_LIMIT, imageHeaders } from '../shared/images';
import { MEDIA_ASSET_PATH, MEDIA_UPLOAD_PATH, MEDIA_FILE_LIMIT, MEDIA_CHUNK_BYTES, MediaUploadError, mediaResponsePlan } from '../shared/media';
import type { AssetKind, AssetMetadata, AssetResult } from './room-assets';
import { uploadImageRequestToR2, uploadMediaToR2 } from './r2-upload';

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
export function assetValue<T>(result: AssetResult<T>): T {
  if (!result.ok) throw new MediaUploadError(result.error, result.status);
  return result.value;
}

/** Keep an early validation/storage failure from resetting its HTTP response.
 * The upload reader can stop immediately; drain only a bounded, promptly
 * arriving remainder before giving ownership back to the HTTP runtime. */
function uploadIngress(request: Request, limit: number) {
  if (!request.body) return { request, close: async () => {} };
  const reader = request.body.getReader();
  let stopped = false, ended = false, size = 0;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const read = () => pending ??= reader.read().then(result => {
    ended = result.done;
    if (!result.done) size += result.value.byteLength;
    return result;
  }).finally(() => { pending = undefined; });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await read();
        if (stopped) return;
        if (result.done) controller.close(); else controller.enqueue(result.value);
      } catch (error) { if (!stopped) controller.error(error); }
    },
    cancel() { stopped = true; },
  });
  return {
    request: new Request(request, { body }),
    async close() {
      stopped = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Upload drain deadline')), 2000); });
      try {
        while (!ended && size <= limit + MEDIA_CHUNK_BYTES) await Promise.race([read(), timeout]);
      } catch { /* Aborted/slow/oversized input is left to the HTTP runtime. */ }
      finally {
        clearTimeout(timer);
        if (!ended) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

export async function r2AssetResponse(request: Request, bucket: R2Bucket, kind: AssetKind, digest: string, metadata: AssetMetadata): Promise<Response | null> {
  if (!metadata.objectKey) return null;
  let status = 200, range: { start: number; end: number } | undefined;
  let headers: Record<string, string>;
  if (kind === 'media') {
    const plan = mediaResponsePlan({ range: request.method === 'GET' ? request.headers.get('Range') : null, ifRange: request.headers.get('If-Range'), ifNoneMatch: request.headers.get('If-None-Match') }, metadata, digest);
    status = plan.status; range = plan.range; headers = plan.headers;
  } else {
    headers = { ...imageHeaders(metadata.mime), 'Content-Length': String(metadata.size), ETag: `"${digest}"` };
    if (request.headers.get('If-None-Match')?.split(',').some(value => value.trim().replace(/^W\//, '') === headers.ETag || value.trim() === '*')) {
      status = 304; delete headers['Content-Length'];
    }
  }
  headers['X-Robots-Tag'] = 'noindex';
  if (status === 304 || status === 416 || request.method === 'HEAD') return new Response(null, { status, headers });
  const object = await bucket.get(metadata.objectKey, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object || !('body' in object)) return null;
  if (object.size !== metadata.size) {
    await object.body.cancel(); throw new Error('Stored asset size does not match its metadata');
  }
  return new Response(object.body, { status, headers });
}

/** Transfer the file at the edge; only small coordination RPCs visit the room. */
export async function handleAssetRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const image = IMAGE_ASSET_PATH.exec(url.pathname), imageUpload = IMAGE_UPLOAD_PATH.exec(url.pathname);
  const media = MEDIA_ASSET_PATH.exec(url.pathname), mediaUpload = MEDIA_UPLOAD_PATH.exec(url.pathname);
  const route = image || imageUpload || media || mediaUpload;
  if (!route) return null;
  const kind: AssetKind = image || imageUpload ? 'images' : 'media';
  const asset = image || media, upload = imageUpload || mediaUpload;
  const room = route[1], stub = env.ROOMS.getByName(room);
  if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
    const metadata = await stub.getAssetMetadata(kind, asset[2]);
    if (!metadata) return json({ error: kind === 'images' ? '画像が見つかりません。' : '音声・動画が見つかりません。' }, 404);
    try {
      const response = await r2AssetResponse(request, env.MEDIA_BUCKET, kind, asset[2], metadata);
      if (response) return response;
    } catch {
      // The first rollout retains legacy SQLite bytes for a failed copy/read.
      console.warn('asset_r2_read_fallback');
    }
    return stub.fetch(request);
  }
  if (!upload || request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (request.headers.get('Origin') !== url.origin) return json({ error: kind === 'images' ? 'この編集画面から画像を追加してください。' : 'この編集画面から音声・動画を追加してください。' }, 403);
  const ingress = uploadIngress(request, kind === 'images' ? IMAGE_BYTES_LIMIT : MEDIA_FILE_LIMIT);
  let key: string | undefined;
  try {
    key = assetValue(await stub.beginAssetUpload(room, kind));
    const metadata = kind === 'images'
      ? await uploadImageRequestToR2(env.MEDIA_BUCKET, key, ingress.request)
      : await uploadMediaToR2(env.MEDIA_BUCKET, key, ingress.request);
    assetValue(await stub.finishAssetUpload(key, metadata.digest, metadata.mime, metadata.size));
    return json({ src: `/api/rooms/${room}/${kind}/${metadata.digest}` });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : '素材を保存できませんでした。' }, error instanceof MediaUploadError ? error.status : 400);
  } finally {
    // A committed key has no pending row. This also cleans dedup losers safely.
    if (key) await stub.discardAssetUpload(key).catch(() => { console.warn('asset_cleanup_deferred'); });
    await ingress.close();
  }
}
