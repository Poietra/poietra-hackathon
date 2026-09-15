import type { Scene } from '../../../shared/model';
import { ImageAssetSchema, IMAGE_DATA_URL } from '../../../shared/images';
import { blobDataUrl, imageBlob } from './image-source';

const sources = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

export function preparedImage(src: string | undefined): string | null {
  if (!src) return null;
  if (IMAGE_DATA_URL.test(src)) return src;
  return sources.get(src) || null;
}

export async function prepareImages(scene: Scene): Promise<void> {
  const images = Object.values(scene.objects).filter(object => object.kind === 'image' && Object.values(scene.compositions).some(composition => composition.states[object.id]?.visible));
  for (const object of images) {
    const asset = ImageAssetSchema.safeParse(object.image);
    if (!asset.success) throw new Error(`「${object.name}」の画像がありません。画像を追加し直してください。`);
    const { src } = asset.data;
    if (preparedImage(src)) continue;
    let task = pending.get(src);
    if (!task) {
      task = (async () => { sources.set(src, await blobDataUrl(await imageBlob(src))); })().finally(() => pending.delete(src));
      pending.set(src, task);
    }
    await task;
  }
}
