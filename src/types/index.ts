// Shared type surface for the Loom Morph pipeline.
//
// This file is the contract between capture, render, and orchestrator workers.
// Source of truth: /ai/INTERFACES.md § "Shared types".
// Lead Agent owns changes here — implementation tasks must NOT modify this file
// without an explicit interface change recorded in /ai/DECISIONS.md.

// ────────────────────── batch/lead config ──────────────────────

export type Resolution = '720p' | '1080p';

export interface VideoDimensions {
  width: number;
  height: number;
}

export const RESOLUTIONS: Record<Resolution, VideoDimensions> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

export type CirclePosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type CircleSize = 'S' | 'M' | 'L'; // → 200 | 280 | 360 px

export const CIRCLE_PIXELS: Record<CircleSize, number> = {
  S: 200,
  M: 280,
  L: 360,
};

export type CaptureMode = 'screenshot' | 'recording'; // D-019

// Recording-mode scroll behavior:
//   'auto'   — probe the page; pan if scrolling works, hold static if the
//              page is scroll-locked / scroll-jacked / fits in viewport.
//              Default.
//   'pan'    — driveScroll pans the page over the duration, regardless of
//              whether the page actually responds to scroll.
//   'static' — hold the page at scrollY=0 for the duration. Useful for
//              sites with scroll-pinned hero animations where the page
//              expands content beyond viewport during scroll (e.g.
//              jvm.ch, ogilvy.ch) — we can't auto-detect that case
//              (scroll moves, just produces a weird timeline), so user
//              still has to pick this explicitly.
export type RecordingScrollMode = 'auto' | 'pan' | 'static';

export interface BatchConfig {
  durationSec: number; // default 30
  resolution: Resolution; // default '1080p'
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  circleMargin: number; // px from edge, default 40
  circleCropScale?: number; // 1-2.5, zooms the source inside the circle mask
  circleCropX?: number; // -100..100, shifts the crop horizontally
  circleCropY?: number; // -100..100, shifts the crop vertically
  // D-019 — 'screenshot' (default; pans a static PNG, parallel-friendly) or
  // 'recording' (records the live page; preserves hero videos / parallax /
  // animations at the cost of real-time-bound capture).
  captureMode?: CaptureMode;
  // Recording-mode only. Default 'pan'.
  recordingScrollMode?: RecordingScrollMode;
  // Recording-mode only. When true, the render filter graph applies
  // motion-interpolation (ffmpeg `minterpolate=mi_mode=blend`) to the
  // captured WebM so the on-page hero video reads as smoother motion
  // instead of "stitched screenshots". Costs ~50% extra render time.
  smoothMotion?: boolean;
  filenameTemplate: string; // e.g. "{company}.mp4", fallback "lead-{i}.mp4"
}

// ────────────────────── capture worker ──────────────────────

export interface CaptureInput {
  url: string; // pre-normalized to https://...
  outputPath: string; // absolute path to write PNG
  contextPoolSize?: number; // default 6
}

export interface CaptureResult {
  pngPath: string;
  width: number; // px
  height: number; // px (capped at 16000)
  capturedAtMs: number; // Date.now()
  durationMs: number;
  // Recording-mode only: seconds of leading footage that should be skipped
  // by the renderer (navigation + cookie-accept + settle). Undefined or 0
  // means "use the whole video from t=0" — the screenshot path always
  // leaves this unset.
  videoStartOffsetSec?: number;
}

export type CaptureFailureReason =
  | 'timeout'
  | 'network'
  | 'bot-blocked'
  | 'page-crashed'
  | 'invalid-url'
  | 'unknown';

export class CaptureError extends Error {
  constructor(
    public reason: CaptureFailureReason,
    message: string,
    public override cause?: unknown,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

export type CaptureFn = (input: CaptureInput) => Promise<CaptureResult>;

// ────────────────────── render worker ──────────────────────

export type BackgroundKind = 'image' | 'video'; // D-019

export interface RenderJob {
  screenshotPath: string;
  screenshotHeight: number; // for pan distance calculation (image kind)
  circleSourcePath: string; // image or video
  circleHasAudio: boolean; // determines amix path
  audioPath?: string; // optional MP3
  outputPath: string;
  config: BatchConfig;
  // D-019 — when 'video', screenshotPath points at a recorded WebM/MP4 of
  // the live page; the filter graph centers + scales without a time-based
  // pan. Default 'image'.
  backgroundKind?: BackgroundKind;
  // Recording-mode only: seconds to skip at the start of the background
  // video (via ffmpeg `-ss`). Useful for hiding page load + cookie-accept
  // settle from the final output.
  backgroundStartOffsetSec?: number;
}

export interface RenderConfig {
  // Subset of RenderJob used by the pure filter-graph builder.
  screenshotHeight: number;
  durationSec: number;
  resolution: Resolution;
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  circleMargin: number;
  circleCropScale?: number;
  circleCropX?: number;
  circleCropY?: number;
  circleHasAudio: boolean;
  audioMp3Present: boolean; // D-015 — separate flag so the four audio paths are decidable
  backgroundKind?: BackgroundKind; // D-019; default 'image'
  // Mirrors BatchConfig.smoothMotion — passed through so the filter
  // builder can append motion-interpolation when video-bg.
  smoothMotion?: boolean;
}

export interface RenderResult {
  outputPath: string;
  durationMs: number;
}

export type RenderFailureReason =
  | 'ffmpeg-error'
  | 'missing-input'
  | 'timeout'
  | 'unknown';

export class RenderError extends Error {
  constructor(
    public reason: RenderFailureReason,
    message: string,
    public stderrTail?: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export type RenderFn = (job: RenderJob) => Promise<RenderResult>;

// ────────────────────── orchestrator ──────────────────────

export type LeadStatus =
  | 'pending'
  | 'capturing'
  | 'rendering'
  | 'done'
  | 'failed';

export interface LeadInput {
  rowIndex: number;
  website: string; // pre-normalized
  csvData: Record<string, string>;
}

export interface LeadRecord extends LeadInput {
  id: string;
  batchId: string;
  status: LeadStatus;
  error?: string;
  outputPath?: string;
  captureMs?: number;
  renderMs?: number;
}

export interface BatchInput {
  id: string;
  name?: string; // user-facing label; defaults set by the engine if omitted
  config: BatchConfig;
  leads: LeadInput[];
  circleSourcePath: string;
  circleHasAudio: boolean;
  audioPath?: string;
}

export type BatchEvent =
  | { type: 'batch-started'; batchId: string; total: number }
  | { type: 'lead-status'; leadId: string; status: LeadStatus; error?: string }
  | { type: 'lead-completed'; leadId: string; outputPath: string }
  | {
      type: 'batch-completed';
      batchId: string;
      summary: { done: number; failed: number; totalMs: number };
    };

// Persisted batch row (referenced by DbClient.getBatch in INTERFACES.md).
export interface BatchRecord {
  id: string;
  name?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  config: BatchConfig;
  total: number;
  createdAt: number;
  finishedAt?: number;
}
