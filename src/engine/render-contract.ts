import type { Frame, RenderObject } from './evaluate';
import type { MotionKernel } from './kernel';
import type { Project, Scene } from '../../shared/model';

/** Bounds in Scene coordinates, before state.rotation is applied around the object anchor. */
export interface ObjectBounds { x: number; y: number; width: number; height: number }

export interface SvgOptions {
  /** Defaults to true. The background must be included for video export. */
  background?: boolean;
  /** Unique across SVGs simultaneously placed in one document. */
  idPrefix?: string;
}

export interface ExportOptions {
  format: 'mp4' | 'webm';
  fps: 24 | 30 | 60;
  width?: number;
  height?: number;
  /** Between 0 and 1. */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  codec: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface ExportCapabilities {
  mp4: boolean;
  webm: boolean;
  /** A user-facing explanation if neither format is supported. */
  reason?: string;
}

/**
 * Implement these exports in src/engine/renderer.ts.
 * The UI calls prepareScene whenever content changes, then frameToSvg for each frame.
 * SVG object groups carry data-object-id="<SceneObject.id>" for pointer hit testing.
 * Implementations must escape authored text and IDs and use local bundled assets.
 */
export interface RendererContract {
  prepareScene(scene: Scene): Promise<void>;
  frameToSvg(frame: Frame, options?: SvgOptions): string;
  objectBounds(item: RenderObject): ObjectBounds;
}

/** Implement these exports in src/engine/export.ts; the UI owns the download dialog. */
export interface ExporterContract {
  getExportCapabilities(): Promise<ExportCapabilities>;
  exportScene(scene: Scene, kernel: MotionKernel, options: ExportOptions): Promise<ExportResult>;
  /** Optional for older hosts. Scenes play in project order with their original aspect ratios. */
  exportProject?(project: Project, kernel: MotionKernel, options: ExportOptions): Promise<ExportResult>;
}
