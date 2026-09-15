import { canEncodeVideo } from 'mediabunny';
import type { ExportCapabilities } from '../render-contract';
import { abortable } from './abort';

type ExportCodec = 'avc' | 'vp9' | 'vp8';
const NO_CODEC = 'このブラウザでは MP4 / WebM を書き出せません。WebCodecs 対応の Chrome または Edge をお試しください。';

export function environmentReason(): string | undefined {
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
    return '動画の書き出しには安全な接続が必要です。HTTPS または localhost で開いてください。';
  }
  if (typeof document === 'undefined' || typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return 'このブラウザは WebCodecs に対応していません。Chrome または Edge で開いてください。';
  }
}

export function bitrateFor(width: number, height: number, fps: number): number {
  return Math.round(Math.max(1_000_000, Math.min(40_000_000, width * height * fps * 0.16)));
}

async function supports(codec: ExportCodec, width: number, height: number, bitrate: number): Promise<boolean> {
  try { return await canEncodeVideo(codec, { width, height, bitrate, latencyMode: 'quality', alpha: 'discard' }); }
  catch { return false; }
}

/** General availability at the default Scene resolution; export rechecks the requested size. */
export async function getExportCapabilities(): Promise<ExportCapabilities> {
  const reason = environmentReason();
  if (reason) return { mp4: false, webm: false, reason };
  const bitrate = bitrateFor(1280, 720, 30);
  const [mp4, vp9, vp8] = await Promise.all([
    supports('avc', 1280, 720, bitrate), supports('vp9', 1280, 720, bitrate), supports('vp8', 1280, 720, bitrate),
  ]);
  const webm = vp9 || vp8;
  return mp4 || webm ? { mp4, webm } : { mp4, webm, reason: NO_CODEC };
}

export async function findExportCodec(format: 'mp4' | 'webm', width: number, height: number, bitrate: number, signal?: AbortSignal): Promise<ExportCodec | undefined> {
  const candidates: ExportCodec[] = format === 'mp4' ? ['avc'] : ['vp9', 'vp8'];
  for (const candidate of candidates) {
    if (await abortable(supports(candidate, width, height, bitrate), signal)) return candidate;
  }
}
