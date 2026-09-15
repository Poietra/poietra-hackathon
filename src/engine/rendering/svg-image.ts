function imageAbortError(): DOMException {
  return new DOMException('フレームの描画をキャンセルしました。', 'AbortError');
}

/** Own an SVG image only for the synchronous draw callback, releasing it on every exit path. */
export async function withSvgImage<T>(
  svg: string,
  signal: AbortSignal | undefined,
  draw: (image: HTMLImageElement) => T,
): Promise<T> {
  if (signal?.aborted) throw imageAbortError();
  let url: string | undefined;
  let image: HTMLImageElement | undefined;
  let abort: (() => void) | undefined;
  try {
    const imageUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    url = imageUrl;
    const loadedImage = new Image();
    image = loadedImage;
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(imageAbortError());
      loadedImage.onload = () => resolve();
      loadedImage.onerror = () => reject(new Error('フレームを画像に変換できませんでした。ページを再読み込みしてお試しください。'));
      signal?.addEventListener('abort', abort);
      loadedImage.src = imageUrl;
      if (signal?.aborted) abort();
    });
    if (signal?.aborted) throw imageAbortError();
    const result = draw(loadedImage);
    if (signal?.aborted) throw imageAbortError();
    return result;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw imageAbortError();
    throw error;
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    if (url !== undefined) URL.revokeObjectURL(url);
  }
}
