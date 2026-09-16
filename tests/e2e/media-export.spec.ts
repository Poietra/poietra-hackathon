import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const easing of ['linear', 'custom'] as const) test(`independent 2-second position and 300-ms opacity with ${easing} easing survive encoded WebM frames`, async ({ page }, info) => {
  await page.goto('/');
  const report = await page.evaluate(async easing => {
    // @ts-expect-error Vite serves source modules in this local integration harness.
    const { exportScene } = await import('/src/engine/export.ts');
    // @ts-expect-error Vite source module.
    const { evaluateScene } = await import('/src/engine/evaluate.ts');
    // @ts-expect-error Vite source module.
    const { createFramePainter } = await import('/src/engine/painter.ts');
    // @ts-expect-error Vite source module.
    const { loadKernel } = await import('/src/engine/kernel.ts');
    // @ts-expect-error Vite source module.
    const { defaultState, defaultTrack } = await import('/shared/model.ts');
    // @ts-expect-error Vite resolves the same decoder dependency as the application.
    const { BlobSource, Input, ALL_FORMATS, CanvasSink } = await import('/tests/e2e/fixtures/media-dependencies.ts');
    const from = defaultState('rectangle', { x: 50, y: 90, width: 24, height: 24, fill: '#ffffff', strokeWidth: 0, cornerRadius: 0, opacity: 0 });
    const to = { ...structuredClone(from), x: 250, opacity: 1 };
    const curve = easing === 'custom' ? { type: 'cubicBezier', x1: 0, y1: 0, x2: 0, y2: 1 } : 'linear';
    const scene = {
      id: 'property-export', name: 'Independent clocks', width: 320, height: 180, background: '#000000',
      objects: { square: { id: 'square', name: 'Square', kind: 'rectangle', order: 0, locked: false, groupId: null } },
      compositions: { first: { id: 'first', name: 'From', duration: 0, accent: '#ffffff', states: { square: from } }, last: { id: 'last', name: 'To', duration: 100, accent: '#ffffff', states: { square: to } } },
      compositionOrder: ['first', 'last'], audioTracks: {},
      transitions: { motion: { id: 'motion', fromId: 'first', toId: 'last', duration: 2000, tracks: { square: defaultTrack('square', { duration: 2000, easing: 'linear', positionTiming: { start: 0, duration: 2000, easing: curve }, opacityTiming: { start: 0, duration: 300, easing: curve } }) } } },
    };
    const kernel = await loadKernel(), canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    function measure() {
      const pixels = context.getImageData(0, 0, 320, 180).data;
      let mass = 0, moment = 0;
      for (let y = 70; y < 110; y++) for (let x = 0; x < 320; x++) {
        const brightness = pixels[(y * 320 + x) * 4];
        if (brightness > 15) { mass += brightness; moment += (x + .5) * brightness; }
      }
      const x = moment / mass;
      const interior = context.getImageData(Math.round(x) - 2, 88, 5, 5).data;
      let brightness = 0; for (let index = 0; index < interior.length; index += 4) brightness += interior[index];
      return { x, brightness: brightness / 25 };
    }
    const times = [100, 300, 1000], preview = [];
    const painter = await createFramePainter(canvas);
    try { for (const time of times) { await painter.render(evaluateScene(scene, time, kernel)); preview.push(measure()); } }
    finally { painter.dispose(); }
    const result = await exportScene(scene, kernel, { format: 'webm', fps: 30 });
    const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack(); if (!track) throw new Error('Missing encoded video track');
      const sink = new CanvasSink(track), decoded = [];
      for (const time of times) {
        const sample = await sink.getCanvas(time / 1000); if (!sample) throw new Error(`Missing encoded frame at ${time} ms`);
        context.drawImage(sample.canvas, 0, 0);
        decoded.push({ ...measure(), time, timestamp: sample.timestamp, png: canvas.toDataURL('image/png') });
      }
      return { preview, decoded, duration: await input.computeDuration(), bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
    } finally { input.dispose(); }
  }, easing);
  // These positions/brightnesses are independent numerical expectations, not another evaluator call.
  const progress = (time: number) => { const t = Math.cbrt(time); return easing === 'custom' ? 3 * t * t - 2 * t * t * t : time; };
  for (const [index, x] of [100, 300, 1000].map(time => 50 + 200 * progress(time / 2000)).entries()) {
    const frame = report.decoded[index];
    expect(Math.abs(frame.timestamp * 1000 - frame.time)).toBeLessThan(34);
    expect(Math.abs(frame.x - x)).toBeLessThan(4);
    expect(Math.abs(frame.x - report.preview[index].x)).toBeLessThan(4);
    expect(Math.abs(frame.brightness - report.preview[index].brightness)).toBeLessThan(15);
    await writeFile(info.outputPath(`property-${frame.time}ms.png`), Buffer.from(frame.png.split(',')[1], 'base64'));
  }
  expect(Math.abs(report.decoded[0].brightness - 255 * progress(1 / 3))).toBeLessThan(25);
  expect(report.decoded[1].brightness).toBeGreaterThan(235); expect(report.decoded[2].brightness).toBeGreaterThan(235);
  expect(report.decoded[2].x - report.decoded[1].x).toBeGreaterThan(60);
  expect(report.duration).toBeCloseTo(2.1, 1);
  await writeFile(info.outputPath('independent-property-timing.webm'), Buffer.from(report.bytes));
  await writeFile(info.outputPath('property-measurements.json'), JSON.stringify({ duration: report.duration, preview: report.preview, decoded: report.decoded.map(({ png: _png, ...frame }) => frame) }, null, 2));
});

for (const format of ['webm', 'mp4'] as const) test(`video frames and independent trimmed/mixed audio survive ${format} export`, async ({ page }, info) => {
  await page.goto('/');
  const report = await page.evaluate(async format => {
    // @ts-expect-error Vite serves source modules in this local integration harness.
    const { exportScene } = await import('/src/engine/export.ts');
    // @ts-expect-error Vite source module.
    const { evaluateScene } = await import('/src/engine/evaluate.ts');
    // @ts-expect-error Vite source module.
    const { createFramePainter } = await import('/src/engine/painter.ts');
    // @ts-expect-error Vite source module.
    const renderer = await import('/src/engine/renderer.ts');
    // @ts-expect-error Vite source module.
    const { loadKernel } = await import('/src/engine/kernel.ts');
    // @ts-expect-error Vite source module.
    const { defaultState } = await import('/shared/model.ts');
    // @ts-expect-error Vite source module exposes Mediabunny through its dependency graph.
    const bunny = await import('/tests/e2e/fixtures/media-dependencies.ts');
    const { Output, BufferTarget, CanvasSource, WebMOutputFormat, BlobSource, Input, ALL_FORMATS, AudioBufferSink, CanvasSink, canEncodeAudio } = bunny;
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const ctx = canvas.getContext('2d')!;
    const target = new BufferTarget(), output = new Output({ format: new WebMOutputFormat(), target });
    const source = new CanvasSource(canvas, { codec: 'vp9', bitrate: 200000 }); output.addVideoTrack(source, { frameRate: 10 }); await output.start();
    for (let i = 0; i < 20; i++) { ctx.fillStyle = i < 10 ? '#ff0000' : '#0000ff'; ctx.fillRect(0, 0, 160, 90); await source.add(i / 10, 0.1); }
    await output.finalize(); source.close();
    const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
    const video = { src: await dataUrl(new Blob([target.buffer], { type: 'video/webm' })), mime: 'video/webm', duration: 2000, width: 160, height: 90, hasAudio: false };
    const rate = 48000, wave = new ArrayBuffer(44 + rate * 2 * 2), view = new DataView(wave);
    const str = (at: number, value: string) => [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, wave.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, wave.byteLength - 44, true);
    // The trim skips silence and starts on an audible sine wave.
    for (let i = 0; i < rate * 2; i++) view.setInt16(44 + i * 2, i < rate / 2 ? 0 : Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 16000), true);
    const audio = { src: await dataUrl(new Blob([wave], { type: 'audio/wav' })), mime: 'audio/wav', duration: 2000, hasAudio: true };
    const state = defaultState('video', { x: 80, y: 45, width: 160, height: 90, strokeWidth: 0 });
    const scene = { id: 'media', name: 'Media', width: 160, height: 90, background: '#000000', objects: { clip: { id: 'clip', name: 'Clip', kind: 'video', order: 0, locked: false, groupId: null, media: video, playback: { start: 0, offset: 0, duration: 2000 } } }, compositions: { first: { id: 'first', name: 'First', duration: 2000, states: { clip: state } } }, compositionOrder: ['first'], transitions: {}, audioTracks: { tone: { id: 'tone', name: 'Tone', asset: audio, start: 500, offset: 500, duration: 1000, volume: 0.5, muted: false }, harmony: { id: 'harmony', name: 'Harmony', asset: audio, start: 1000, offset: 500, duration: 500, volume: 0.25, muted: false }, muted: { id: 'muted', name: 'Muted', asset: audio, start: 0, offset: 500, duration: 1500, volume: 1, muted: true } } };
    const kernel = await loadKernel(); await renderer.prepareScene(scene);
    const painter = await createFramePainter(canvas);
    const preview = [];
    for (const time of [200, 1200, 2500, 200]) { await painter.render(evaluateScene(scene, time, kernel)); preview.push(Array.from(ctx.getImageData(80, 45, 1, 1).data)); }
    painter.dispose();
    const svgFrame = evaluateScene(scene, 1200, kernel); await renderer.prepareFrame(svgFrame);
    const svg = renderer.frameToSvg(svgFrame);
    if (!await canEncodeAudio(format === 'mp4' ? 'aac' : 'opus', { numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 })) {
      let error = ''; try { await exportScene(scene, kernel, { format, fps: 30 }); } catch (failure) { error = String(failure); }
      return { unsupported: true, error, preview, svg: svg.includes('data:image/png;base64,') };
    }
    const abort = new AbortController(); let canceled = false;
    try { await exportScene(scene, kernel, { format, fps: 30, signal: abort.signal, onProgress: (value: number) => { if (value > 0.1) abort.abort(); } }); }
    catch (failure) { canceled = failure instanceof Error && failure.name === 'AbortError'; }
    if (!canceled) throw new Error('Audio/video export ignored cancellation');
    const broken = structuredClone(scene); broken.audioTracks.tone.asset.src = 'data:audio/wav;base64,AAAA';
    let rejectedBroken = false;
    try { await exportScene(broken, kernel, { format, fps: 30 }); } catch { rejectedBroken = true; }
    if (!rejectedBroken) throw new Error('Broken audio was exported silently');
    const result = await exportScene(scene, kernel, { format, fps: 30 });
    const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
    try {
      const at = await input.getPrimaryAudioTrack(), vt = await input.getPrimaryVideoTrack();
      if (!at || !vt) throw new Error('Missing encoded audio/video track');
      const bins = [0, 0, 0, 0, 0], counts = [0, 0, 0, 0, 0];
      for await (const part of new AudioBufferSink(at).buffers()) { const samples = part.buffer.getChannelData(0); for (let i = 0; i < samples.length; i++) { const t = part.timestamp + i / part.buffer.sampleRate; const bin = t < 0.35 ? 0 : t > 0.65 && t < 0.9 ? 1 : t > 1.7 && t < 1.95 ? 2 : t > 1.1 && t < 1.3 ? 3 : 4; bins[bin] += samples[i] * samples[i]; counts[bin]++; } }
      const decoded = [];
      for (const t of [0.2, 1.2]) { const sample = await new CanvasSink(vt).getCanvas(t); ctx.drawImage(sample.canvas, 0, 0); decoded.push(Array.from(ctx.getImageData(80, 45, 1, 1).data)); }
      return { unsupported: false, preview, svg: svg.includes('data:image/png;base64,'), decoded, rms: bins.map((value, i) => Math.sqrt(value / counts[i])), duration: await input.computeDuration(), bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
    } finally { input.dispose(); }
  }, format);
  expect(report.preview[0][0]).toBeGreaterThan(230); expect(report.preview[0][2]).toBeLessThan(20);
  expect(report.preview[1][2]).toBeGreaterThan(230); expect(report.preview[2][2]).toBeLessThan(20); expect(report.preview[3][0]).toBeGreaterThan(230); expect(report.svg).toBe(true);
  if (report.unsupported) { expect(report.error).toContain('音声をエンコードできません'); info.annotations.push({ type: 'browser limitation', description: report.error! }); return; }
  expect(report.rms![0]).toBeLessThan(0.003); expect(report.rms![1]).toBeGreaterThan(0.15); expect(report.rms![1]).toBeLessThan(0.2); expect(report.rms![2]).toBeLessThan(0.003); expect(report.rms![3]).toBeGreaterThan(0.24); expect(report.rms![3]).toBeLessThan(0.28);
  expect(report.decoded![0][0]).toBeGreaterThan(220); expect(report.decoded![1][2]).toBeGreaterThan(220); expect(report.duration).toBeCloseTo(2, 1);
  await writeFile(info.outputPath(`media.${format}`), Buffer.from(report.bytes!));
});

test('real AudioContext playback honors trim, pause, seek, replay and unmount cleanup', async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/media-playback.html');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).mediaPlaybackFixture.calls.filter((call: any) => call.type === 'start').length)).toBeGreaterThan(0);
  const first = await page.evaluate(() => (window as any).mediaPlaybackFixture.calls.find((call: any) => call.type === 'start'));
  expect(first.rms).toBeGreaterThan(0.15); expect(first.rms).toBeLessThan(0.2);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const count = await page.evaluate(() => (window as any).mediaPlaybackFixture.calls.length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).mediaPlaybackFixture.calls.length)).toBe(count);
  await page.getByRole('button', { name: 'Seek', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).mediaPlaybackFixture.calls.length)).toBeGreaterThan(count);
  await page.evaluate(() => (window as any).mediaPlaybackFixture.unmount());
  await expect.poll(() => page.evaluate(() => (window as any).mediaPlaybackFixture.contexts.every((context: AudioContext) => context.state === 'closed'))).toBe(true);
  const after = await page.evaluate(() => (window as any).mediaPlaybackFixture.calls.length);
  await page.waitForTimeout(300); expect(await page.evaluate(() => (window as any).mediaPlaybackFixture.calls.length)).toBe(after);
});
