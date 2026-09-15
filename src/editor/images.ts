import { IMAGE_ASSET_PATH, IMAGE_BYTES_LIMIT, IMAGE_DATA_URL, IMAGE_EDGE_LIMIT, ImageAssetSchema, type ImageAsset } from '../../shared/images';
import { blobDataUrl, imageBlob } from '../engine/rendering/image-source';
import type { Project } from '../../shared/model';

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


/** Portable files embed raster bytes; live documents keep only immutable references. */
export async function portableProject(project: Project, signal?: AbortSignal): Promise<Project> {
  const snapshot = structuredClone(project), sources = new Map<string, string>();
  for (const scene of Object.values(snapshot.scenes)) for (const object of Object.values(scene.objects)) if (object.image) {
    ImageAssetSchema.parse(object.image);
    const src = object.image.src;
    if (!sources.has(src)) sources.set(src, IMAGE_DATA_URL.test(src) ? src : await blobDataUrl(await imageBlob(src, signal)));
    object.image.src = sources.get(src)!;
  }
  return snapshot;
}

export async function storeProjectImages(project: Project, room: string, signal?: AbortSignal): Promise<Project> {
  const snapshot = structuredClone(project), sources = new Map<string, ImageAsset>();
  for (const scene of Object.values(snapshot.scenes)) for (const object of Object.values(scene.objects)) if (object.image) {
    ImageAssetSchema.parse(object.image);
    const src = object.image.src;
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
  return snapshot;
}
