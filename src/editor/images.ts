import { IMAGE_ASSET_PATH, IMAGE_BYTES_LIMIT, IMAGE_DATA_URL, IMAGE_EDGE_LIMIT, ImageAssetSchema, type ImageAsset } from '../../shared/images';
import { blobDataUrl, imageBlob } from '../engine/rendering/image-source';
import type { Project, SceneObject } from '../../shared/model';
import { MEDIA_ASSET_PATH, MEDIA_DATA_URL, MediaAssetSchema, type MediaAsset } from '../../shared/media';
import { PROJECT_FILE_LIMIT } from '../../shared/project-file';
import { mediaBlob, prepareMedia, uploadMedia } from './media';

export const IMAGE_FILE_LIMIT = 20 * 1024 * 1024;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

export async function normalizeImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  if (!IMAGE_ACCEPT.split(',').includes(file.type)) throw new Error('PNG・JPEG・WebP の画像を選択してください。');
  if (file.size > IMAGE_FILE_LIMIT) throw new Error('元の画像は 20 MB 以下にしてください。');
  const source = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('この画像を読み取れませんでした。')); image.src = source; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('画像の画素数が大きすぎます。4,000万画素以下にしてください。');
    let scale = Math.min(1, IMAGE_EDGE_LIMIT / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d'); if (!context) throw new Error('画像を準備できませんでした。');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, attempt === 0 ? 'image/png' : 'image/webp', 0.9));
        if (blob && blob.size <= IMAGE_BYTES_LIMIT) return { blob, width: canvas.width, height: canvas.height };
        if (attempt > 0) scale *= 0.75;
      }
      throw new Error('画像を小さくして、もう一度追加してください。');
    } finally { canvas.width = canvas.height = 0; }
  } finally { image.src = ''; URL.revokeObjectURL(source); }
}

export async function uploadImage(room: string, blob: Blob, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/rooms/${room}/images`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  let data: { src?: string; error?: string };
  try { data = await response.json(); } catch { throw new Error('画像を保存できませんでした。接続を確認して再試行してください。'); }
  if (!response.ok || !data.src || !IMAGE_ASSET_PATH.test(data.src)) throw new Error(data.error || '画像を保存できませんでした。');
  return data.src;
}


/** Portable files embed asset bytes; live documents keep only immutable references. */
export async function portableProject(project: Project, signal?: AbortSignal): Promise<Project> {
  const snapshot = structuredClone(project), sources = new Map<string, string>();
  let size = new TextEncoder().encode(JSON.stringify(snapshot)).length;
  const account = (before: string, after: string) => {
    size += after.length - before.length;
    if (size > PROJECT_FILE_LIMIT) throw new Error(`保存する素材や Scene を減らして、${PROJECT_FILE_LIMIT / 1024 / 1024} MB 以下にしてください。`);
  };
  for (const scene of Object.values(snapshot.scenes)) for (const object of Object.values(scene.objects)) if (object.image) {
    ImageAssetSchema.parse(object.image);
    const src = object.image.src;
    if (!sources.has(src)) sources.set(src, IMAGE_DATA_URL.test(src) ? src : await blobDataUrl(await imageBlob(src, signal)));
    account(src, sources.get(src)!); object.image.src = sources.get(src)!;
  }
  for (const scene of Object.values(snapshot.scenes)) for (const asset of sceneMediaAssets(scene)) {
    MediaAssetSchema.parse(asset);
    const src = asset.src;
    if (!sources.has(src)) {
      const blob = MEDIA_DATA_URL.test(src) ? null : await mediaBlob(src, signal);
      if (blob && blob.type !== asset.mime) throw new Error('素材の形式情報が一致しません。素材を追加し直してください。');
      sources.set(src, blob ? await blobDataUrl(blob) : src);
    }
    account(src, sources.get(src)!); asset.src = sources.get(src)!;
  }
  return snapshot;
}

export async function storeProjectImages(project: Project, room: string, signal?: AbortSignal): Promise<Project> {
  const snapshot = structuredClone(project);
  // Seed before publishing old files so offline audio additions have one shared parent.
  for (const scene of Object.values(snapshot.scenes)) scene.audioTracks ??= {};
  await rehostRasterAssets(Object.values(snapshot.scenes).flatMap(scene => Object.values(scene.objects)), room, signal);
  await rehostMediaAssets(Object.values(snapshot.scenes).flatMap(sceneMediaAssets), room, signal);
  return snapshot;
}

/** Rehost copied objects before publishing them into another shared room. */
export async function rehostImageAssets(objects: SceneObject[], room: string, signal?: AbortSignal): Promise<void> {
  await rehostRasterAssets(objects, room, signal);
  await rehostMediaAssets(objects.flatMap(object => object.media ? [object.media] : []), room, signal);
}

async function rehostRasterAssets(objects: SceneObject[], room: string, signal?: AbortSignal): Promise<void> {
  const sources = new Map<string, ImageAsset>();
  for (const object of objects) if (object.image) {
    ImageAssetSchema.parse(object.image);
    const src = object.image.src;
    if (IMAGE_ASSET_PATH.exec(src)?.[1] === room) continue;
    if (!sources.has(src)) {
      const blob = await imageBlob(src, signal);
      // Verify the pixels without re-encoding an already normalized image on every import.
      const url = URL.createObjectURL(blob), decoded = new Image();
      let width: number, height: number;
      try {
        decoded.src = url; await decoded.decode(); width = decoded.naturalWidth; height = decoded.naturalHeight;
        if (width !== object.image.width || height !== object.image.height) throw new Error('画像のサイズ情報が一致しません。元の画像を追加し直してください。');
      } finally { decoded.src = ''; URL.revokeObjectURL(url); }
      sources.set(src, { src: await uploadImage(room, blob, signal), width, height });
    }
    const stored = sources.get(src)!;
    if (stored.width !== object.image.width || stored.height !== object.image.height) throw new Error('画像のサイズ情報が一致しません。元の画像を追加し直してください。');
    object.image = { ...stored };
  }
}

function sceneMediaAssets(scene: Project['scenes'][string]): MediaAsset[] {
  return [...Object.values(scene.objects).flatMap(object => object.media ? [object.media] : []), ...Object.values(scene.audioTracks ?? {}).map(track => track.asset)];
}

async function rehostMediaAssets(assets: MediaAsset[], room: string, signal?: AbortSignal): Promise<void> {
  const sources = new Map<string, MediaAsset>();
  for (const asset of assets) {
    MediaAssetSchema.parse(asset);
    const src = asset.src;
    if (MEDIA_ASSET_PATH.exec(src)?.[1] === room) continue;
    if (!sources.has(src)) {
      const blob = await mediaBlob(src, signal);
      const prepared = await prepareMedia(new File([blob], 'shared-media', { type: asset.mime }), signal ?? new AbortController().signal);
      const decoded = prepared.asset;
      if (decoded.mime !== asset.mime || Math.abs(decoded.duration - asset.duration) > 1 || decoded.width !== asset.width || decoded.height !== asset.height || decoded.hasAudio !== asset.hasAudio) throw new Error('音声・動画の長さや形式情報が一致しません。素材を追加し直してください。');
      sources.set(src, { ...decoded, src: await uploadMedia(room, prepared.blob, signal) });
    }
    const stored = sources.get(src)!;
    if (stored.mime !== asset.mime || Math.abs(stored.duration - asset.duration) > 1 || stored.width !== asset.width || stored.height !== asset.height || stored.hasAudio !== asset.hasAudio) throw new Error('音声・動画の長さや形式情報が一致しません。素材を追加し直してください。');
    Object.assign(asset, structuredClone(stored));
  }
}
