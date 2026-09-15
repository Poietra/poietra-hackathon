import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import { ExportDialog } from '../../../src/ui/ExportDialog';
import { makeDemoProject } from '../../../shared/demo';
import type { Scene } from '../../../shared/model';
import type { ExportCapabilities, ExporterContract, ExportOptions, ExportResult } from '../../../src/engine/render-contract';
import type { MotionKernel } from '../../../src/engine/kernel';

const capabilities: { resolve(value: ExportCapabilities): void; reject(error: Error): void }[] = [];
const exports: { scene: Scene; options: ExportOptions; resolve(value: ExportResult): void; reject(error: Error): void }[] = [];
const exporter: ExporterContract = {
  getExportCapabilities: () => new Promise((resolve, reject) => capabilities.push({ resolve, reject })),
  exportScene: (scene, _kernel, options) => new Promise((resolve, reject) => exports.push({ scene, options, resolve, reject })),
};
const kernel = {} as MotionKernel; // The explicit exporter stub never evaluates frames.
const probe = {
  open() {}, close() {}, unmount() {},
  changeSource(_width: number, _height: number, _sceneName: string, _projectName: string) {},
  capabilities(index: number, value: ExportCapabilities) { capabilities[index].resolve(value); },
  capabilityError(index: number) { capabilities[index].reject(new Error('Capability check failed')); },
  progress(index: number, value: number) { exports[index].options.onProgress?.(value); },
  finish(index: number) { const { options } = exports[index]; exports[index].resolve({ blob: new Blob(['explicit-exporter-stub'], { type: 'video/mp4' }), mimeType: 'video/mp4', extension: options.format, codec: 'stub', width: options.width!, height: options.height!, durationMs: 3400 }); },
  fail(index: number) { exports[index].reject(new Error('Encoder interrupted')); },
  state() { return { capabilities: capabilities.length, exports: exports.map(({ scene, options }) => ({ scene, format: options.format, width: options.width, height: options.height, fps: options.fps, aborted: options.signal?.aborted })) }; },
};
declare global { interface Window { exportDialogProbe: typeof probe } }
window.exportDialogProbe = probe;
function Fixture() {
  const [open, setOpen] = useState(false); const [mounted, setMounted] = useState(true);
  const [scene, setScene] = useState(makeDemoProject().scenes['scene-1']); const [name, setName] = useState('Original project');
  probe.open = () => setOpen(true); probe.close = () => setOpen(false); probe.unmount = () => setMounted(false);
  probe.changeSource = (width, height, sceneName, projectName) => { setScene(previous => ({ ...previous, width, height, name: sceneName })); setName(projectName); };
  return <>{mounted && <ExportDialog open={open} onOpenChange={setOpen} exporter={exporter} scene={scene} kernel={kernel} name={name}/>}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
