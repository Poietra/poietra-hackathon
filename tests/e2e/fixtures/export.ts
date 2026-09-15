import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny';
import { makeDemoProject } from '../../../shared/demo';
import { defaultState, type Scene } from '../../../shared/model';
import { evaluateScene } from '../../../src/engine/evaluate';
import { exportScene, getExportCapabilities } from '../../../src/engine/export';
import { loadKernel } from '../../../src/engine/kernel';
import { frameToSvg, objectBounds, prepareScene } from '../../../src/engine/renderer';

function makeScene(): Scene {
  const scene = makeDemoProject().scenes['scene-1'];
  scene.objects.japanese = { id: 'japanese', name: 'Japanese text', kind: 'text', order: 3, groupId: null, locked: false };
  for (const composition of Object.values(scene.compositions)) {
    composition.states.japanese = defaultState('text', {
      text: 'みんなで、アイデアを動かそう。', x: 640, y: 95,
      width: 850, height: 70, fontSize: 40, fill: '#ffffff',
    });
  }
  return scene;
}

const kernel = await loadKernel();
const initialScene = makeScene();
await prepareScene(initialScene);
await document.fonts.ready;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function showPreview(scene: Scene, time = 2000) {
  element('preview').innerHTML = frameToSvg(evaluateScene(scene, time, kernel));
}

async function rasterize(scene: Scene, time: number): Promise<HTMLCanvasElement> {
  const svg = frameToSvg(evaluateScene(scene, time, kernel));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = scene.width;
    canvas.height = scene.height;
    canvas.getContext('2d')!.drawImage(image, 0, 0, scene.width, scene.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function compareRegion(expected: HTMLCanvasElement, actual: HTMLCanvasElement, scene: Scene, objectId: string) {
  const frame = evaluateScene(scene, 2000, kernel);
  const item = frame.objects.find(candidate => candidate.object.id === objectId)!;
  const bounds = objectBounds(item);
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  const width = Math.min(scene.width - x, Math.max(1, Math.ceil(bounds.width)));
  const height = Math.min(scene.height - y, Math.max(1, Math.ceil(bounds.height)));
  const a = expected.getContext('2d')!.getImageData(x, y, width, height).data;
  const b = actual.getContext('2d')!.getImageData(x, y, width, height).data;
  let difference = 0;
  let expectedInk = 0;
  let actualInk = 0;
  for (let i = 0; i < a.length; i += 4) {
    difference += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (a[i] + a[i + 1] + a[i + 2] > 180) expectedInk++;
    if (b[i] + b[i + 1] + b[i + 2] > 180) actualInk++;
  }
  return { bounds, meanAbsoluteError: difference / (width * height * 3), expectedInk, actualInk };
}

async function inspect(blob: Blob, expectedScene: Scene) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The browser export contains no video track.');
    const packets = [];
    for await (const packet of new EncodedPacketSink(track).packets()) {
      packets.push({ timestamp: packet.timestamp, duration: packet.duration });
    }
    const canvas = element<HTMLCanvasElement>('decoded');
    const sample = await new VideoSampleSink(track).getSample(2);
    if (!sample) throw new Error('The exported video cannot be decoded at 2 seconds.');
    try { sample.draw(canvas.getContext('2d')!, 0, 0); } finally { sample.close(); }
    const expected = await rasterize(expectedScene, 2000);
    return {
      width: track.displayWidth, height: track.displayHeight,
      duration: await input.computeDuration(), packetCount: packets.length,
      timestamps: packets.map(packet => packet.timestamp),
      japanese: compareRegion(expected, canvas, expectedScene, 'japanese'),
      equation: compareRegion(expected, canvas, expectedScene, 'equation'),
      // Changes to the source scene during export must never reach this background pixel.
      background: Array.from(canvas.getContext('2d')!.getImageData(20, 650, 1, 1).data),
    };
  } finally {
    input.dispose();
  }
}

showPreview(initialScene);

const fixture = {
  capabilities: getExportCapabilities,
  async export(format: 'mp4' | 'webm', mutateSource = false) {
    const scene = makeScene();
    const original = structuredClone(scene);
    const progress: number[] = [];
    let mutationApplied = false;
    const result = await exportScene(scene, kernel, {
      format, fps: 30, width: 1280, height: 720,
      onProgress(value) {
        progress.push(value);
        element('status').textContent = `Encoding ${format.toUpperCase()}: ${Math.round(value * 100)}%`;
        if (mutateSource && !mutationApplied && value > 0 && value < 1) {
          scene.background = '#ff0000';
          for (const composition of Object.values(scene.compositions)) {
            composition.states.japanese.text = 'MUTATED DURING EXPORT';
            composition.states.equation.text = 'x = 0';
          }
          mutationApplied = true;
        }
      },
    });
    const metadata = await inspect(result.blob, original);
    showPreview(original);
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `poietra-demo.${result.extension}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const report = {
      ...metadata, progress, mutationApplied,
      mimeType: result.mimeType, extension: result.extension, codec: result.codec,
      durationMs: result.durationMs, bytes: result.blob.size,
    };
    element('status').textContent = `${format.toUpperCase()} verified: ${report.width} × ${report.height}, ${report.packetCount} frames, ${report.duration.toFixed(3)} s.\nJapanese preview / decoded error: ${report.japanese.meanAbsoluteError.toFixed(2)}. Math error: ${report.equation.meanAbsoluteError.toFixed(2)}.\nSource edited during export: ${mutationApplied}.`;
    return report;
  },
  async cancel(format: 'mp4' | 'webm', preAborted = false) {
    const controller = new AbortController();
    let lastProgress = -1;
    if (preAborted) controller.abort();
    try {
      await exportScene(makeScene(), kernel, {
        format, fps: 30, signal: controller.signal,
        onProgress(value) {
          lastProgress = value;
          if (value > 0 && value < 1) controller.abort();
        },
      });
      return { rejected: false, name: '', message: '', lastProgress };
    } catch (error) {
      const failure = error as Error;
      return { rejected: true, name: failure.name, message: failure.message, lastProgress };
    }
  },
  async unsupportedExport() {
    try {
      await exportScene(makeScene(), kernel, { format: 'mp4', fps: 30 });
      return { rejected: false, message: '' };
    } catch (error) {
      return { rejected: true, message: (error as Error).message };
    }
  },
  duplicateIds() {
    const frame = evaluateScene(initialScene, 1600, kernel);
    frame.objects.find(item => item.object.id === 'circle')!.state.effect = 'glow';
    frame.objects.find(item => item.object.id === 'japanese')!.writeProgress = 0.5;
    element('duplicates').innerHTML = frameToSvg(frame) + frameToSvg(frame)
      + frameToSvg(frame, { idPrefix: 'composition-one' })
      + frameToSvg(frame, { idPrefix: 'composition-two' });
    const ids = Array.from(document.querySelectorAll('[id]'), node => node.id);
    return {
      generatedIdCount: element('duplicates').querySelectorAll('[id]').length,
      duplicates: ids.filter((id, index) => ids.indexOf(id) !== index),
    };
  },
};

declare global { interface Window { exportFixture: typeof fixture; } }
window.exportFixture = fixture;
element('status').textContent = 'Ready';
