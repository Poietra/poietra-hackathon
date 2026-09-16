import { StrictMode } from 'react';
import type { Root } from 'react-dom/client';
import { App } from '../App';
import { Boundary } from '../ui/Boundary';
import { EditorStore, currentRoom } from './store';
import { loadKernel } from '../engine/kernel';
import * as renderer from '../engine/renderer';
import * as exporter from '../engine/export';
import { createFramePainter } from '../engine/painter';
import '../styles.css';

export async function openEditor(root: Root) {
  const kernel = await loadKernel();
  const store = new EditorStore(currentRoom());
  root.render(<StrictMode><Boundary><App store={store} kernel={kernel} renderer={renderer} exporter={exporter} createFramePainter={createFramePainter}/></Boundary></StrictMode>);
}
