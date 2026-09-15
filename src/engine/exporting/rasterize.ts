import { checkAbort, exportAbortError } from './abort';

/** SVGs come from the same renderer as preview, including embedded local fonts. */
export async function drawSvgFrame(
  svg: string,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  sceneWidth: number,
  sceneHeight: number,
  background: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const image = new Image();
  let removeAbort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(exportAbortError());
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('フレームを画像に変換できませんでした。ページを再読み込みしてお試しください。'));
      signal?.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal?.removeEventListener('abort', abort);
      image.src = url;
      if (signal?.aborted) abort();
    });
    checkAbort(signal);
    // Preserve scene coordinates and aspect ratio, including when the user chooses another output size.
    const scale = Math.min(width / sceneWidth, height / sceneHeight);
    const drawWidth = sceneWidth * scale;
    const drawHeight = sceneHeight * scale;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  } finally {
    removeAbort();
    image.onload = null;
    image.onerror = null;
    image.src = '';
    URL.revokeObjectURL(url);
  }
}
