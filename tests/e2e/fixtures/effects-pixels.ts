export interface PixelRegion { x: number; y: number; width: number; height: number }

export const OBJECT_REGION_PADDING = 30;
const RGBA_CHANNELS = 4;
const RGB_CHANNELS = 3;
// Separate visible glyphs from the dark scene and disregard tiny antialiasing differences.
const GLYPH_RGB_SUM = 180;
const CHANGED_RGB_SUM = 12;

export function readPixels(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
}

export function readPixel(image: ImageData, x: number, y: number): number[] {
  const start = (Math.floor(y) * image.width + Math.floor(x)) * RGBA_CHANNELS;
  return Array.from(image.data.slice(start, start + RGBA_CHANNELS));
}

export function comparePixels(expected: ImageData, actual: ImageData) {
  let difference = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < expected.data.length; offset += RGBA_CHANNELS) {
    let pixelDifference = 0;
    for (let channel = 0; channel < RGB_CHANNELS; channel++) {
      pixelDifference += Math.abs(expected.data[offset + channel] - actual.data[offset + channel]);
    }
    difference += pixelDifference;
    if (pixelDifference > CHANGED_RGB_SUM) changedPixels++;
  }
  return {
    meanAbsoluteError: difference / (expected.width * expected.height * RGB_CHANNELS),
    changedPixels,
  };
}

export function measureRegion(image: ImageData, bounds: PixelRegion) {
  const left = Math.max(0, Math.floor(bounds.x));
  const top = Math.max(0, Math.floor(bounds.y));
  const right = Math.min(image.width, bounds.x + bounds.width);
  const bottom = Math.min(image.height, bounds.y + bounds.height);
  let ink = 0;
  let energy = 0;
  let pixelCount = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * image.width + x) * RGBA_CHANNELS;
      const rgbSum = image.data[offset] + image.data[offset + 1] + image.data[offset + 2];
      energy += rgbSum;
      if (rgbSum > GLYPH_RGB_SUM) ink++;
      pixelCount++;
    }
  }
  return { ink, meanEnergy: energy / Math.max(1, pixelCount) };
}
