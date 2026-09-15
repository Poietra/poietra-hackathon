import { withSvgImage } from '../rendering/svg-image';

/** SVGs come from the same renderer as preview, including embedded local fonts. */
export function drawSvgFrame(
  svg: string,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  sceneWidth: number,
  sceneHeight: number,
  background: string,
  signal?: AbortSignal,
): Promise<void> {
  return withSvgImage(svg, signal, image => {
    // Preserve scene coordinates and aspect ratio, including when the user chooses another output size.
    const scale = Math.min(width / sceneWidth, height / sceneHeight);
    const drawWidth = sceneWidth * scale;
    const drawHeight = sceneHeight * scale;
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  });
}
