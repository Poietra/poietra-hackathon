import { createContext, useContext } from 'react';
import type { ObjectKind, Scene, Selection } from '../../shared/model';
import type { MotionKernel } from '../engine/kernel';
import type { RendererContract } from '../engine/render-contract';
import type { PainterContract } from '../engine/painter-contract';
import type { EditorStore, Peer } from './store';

export type Tool = 'select' | ObjectKind;
export interface EditorContextValue {
  store: EditorStore;
  scene: Scene;
  selection: Selection;
  select: (selection: Selection) => void;
  compositionId: string;
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  tool: Tool;
  setTool: (tool: Tool) => void;
  kernel: MotionKernel;
  renderer: RendererContract;
  createFramePainter?: PainterContract['createFramePainter'];
  playhead: number;
  seek: (time: number, scope?: 'scene' | 'transition') => void;
  viewingPlayback?: boolean;
  playing: boolean;
  play: (scope?: 'scene' | 'transition') => void;
  previewScope: 'scene' | 'transition';
  pathEditing: boolean;
  setPathEditing: (editing: boolean) => void;
  peers: Peer[];
  notify: (message: string) => void;
}
export const EditorContext = createContext<EditorContextValue | null>(null);
export function useEditor() { const editor = useContext(EditorContext); if (!editor) throw new Error('Editor context is missing'); return editor; }
