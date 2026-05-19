import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDbClient, type DbClient } from '@/db/client';
import { BatchOrchestrator, type OrchestratorPaths } from '@/orchestrator/orchestrator';
import {
  RESOLUTIONS,
  type BatchConfig,
  type BatchEvent,
  type BatchInput,
  type CaptureFn,
  type LeadInput,
  type RenderFn,
} from '@/types';
import { inferCircleHasAudio } from './circle-source';
import { probeMediaDurationSec } from './media-probe';
import { formatReportCsv } from './report';
import { createPaths, ensureBatchDirs, type PathHelpers } from './storage';

// High-level "run a batch end-to-end" facade. Designed for two consumers:
//   1. The CLI (`src/cli/run.ts`) — synchronous-feeling API.
//   2. Phase 3 API routes — calls `runBatch()` to get an SSE-streamable
//      AsyncIterable<BatchEvent>, plus access to the produced files via
//      paths.output() / paths.report().
//
// The facade owns: lazy DB init, OrchestratorPaths construction, render
// creation, ID generation, status persistence, and report.csv writing on
// completion. Callers stay focused on inputs and the event stream.

export interface BatchAssets {
  // Absolute path. Already on disk (e.g. uploaded into uploads/{batchId}/).
  circleSourcePath: string;
  // Inferred from the file extension if undefined: .mp4/.mov/.webm/.mkv → true.
  circleHasAudio?: boolean;
  // Optional MP3 narration.
  audioPath?: string;
}

export interface RunBatchOptions {
  // Caller-supplied; the engine never invents IDs for callers that need
  // stable URLs (Phase 3 API routes).
  batchId?: string;
  // User-facing label; persisted on the batch row, editable post-creation.
  // Defaults to a date-stamped placeholder if omitted.
  name?: string;
  leads: LeadInput[];
  config: BatchConfig;
  assets: BatchAssets;
  // Override the storage root (default: process.cwd()).
  dataRoot?: string;
  // Inject for tests; production paths use real Playwright + ffmpeg.
  capture?: CaptureFn;
  render?: RenderFn;
  capturePoolSize?: number;
  renderPoolSize?: number;
}

export interface RunningBatch {
  batchId: string;
  paths: PathHelpers;
  events: AsyncIterable<BatchEvent>;
  // Resolves when the batch fully terminates and the report.csv is written.
  completion: Promise<BatchSummary>;
}

export interface BatchSummary {
  batchId: string;
  total: number;
  done: number;
  failed: number;
  reportPath: string;
}

let sharedDb: DbClient | null = null;
let sharedDbPath: string | null = null;

export async function runBatch(opts: RunBatchOptions): Promise<RunningBatch> {
  const batchId = opts.batchId ?? randomUUID();
  const paths = createPaths({ root: opts.dataRoot });
  await ensureBatchDirs(paths, batchId);

  const db = getSharedDb(paths.db());

  const captureMode = opts.config.captureMode ?? 'screenshot';
  const baseCapture = opts.capture ?? (await defaultCaptureFn());
  const baseRender = opts.render ?? (await defaultRenderFn());

  const circleHasAudio = opts.assets.circleHasAudio ?? inferCircleHasAudio(opts.assets.circleSourcePath);

  // Audio source rule (user-defined): if the circle is a video with audio,
  // it provides both the audio AND the duration; any uploaded MP3 is
  // ignored. Image/silent circles fall back to the MP3 for both. With no
  // audio source at all, we keep the configured duration as a silent
  // fallback. ffprobe failures (missing binary, unreadable file) also fall
  // back rather than aborting the whole batch.
  const effectiveAudioPath = circleHasAudio ? undefined : opts.assets.audioPath;
  const audioSourcePath = circleHasAudio ? opts.assets.circleSourcePath : effectiveAudioPath;
  const probedDuration = audioSourcePath ? await probeMediaDurationSec(audioSourcePath) : null;
  const derivedDurationSec = probedDuration
    ? clampDurationSec(probedDuration)
    : opts.config.durationSec;
  const config: BatchConfig =
    derivedDurationSec === opts.config.durationSec
      ? opts.config
      : { ...opts.config, durationSec: derivedDurationSec };

  // For 'recording' mode the capture function records a WebM and the render
  // function tags every job with backgroundKind='video'. The orchestrator
  // doesn't need to know about modes at all — the engine handles routing
  // at the boundary.
  const captureFn =
    captureMode === 'recording'
      ? createRecordingCapture(
          config.durationSec,
          config.resolution,
          config.recordingScrollMode,
          baseCapture,
        )
      : baseCapture;
  const renderFn =
    captureMode === 'recording' ? wrapRenderWithVideoBackground(baseRender) : baseRender;

  const orchestratorPaths: OrchestratorPaths = {
    screenshotFor: (b, leadId) => paths.tmp(b, leadId),
    outputFor: (b, _leadId, _lead, filename) => paths.output(b, filename),
  };

  const orchestrator = new BatchOrchestrator({
    capture: captureFn,
    render: renderFn,
    db,
    paths: orchestratorPaths,
    capturePoolSize: opts.capturePoolSize,
    renderPoolSize: opts.renderPoolSize,
  });

  const batchInput: BatchInput = {
    id: batchId,
    name: opts.name?.trim() || defaultBatchName(),
    config,
    leads: opts.leads,
    circleSourcePath: opts.assets.circleSourcePath,
    circleHasAudio,
    audioPath: effectiveAudioPath,
  };

  // The proxy generator is the sole iterator over the orchestrator's stream.
  // It forwards every event to the consumer and resolves `completion` when
  // it sees `batch-completed`. Consumers MUST iterate `events` for
  // `completion` to settle — same shape as for-await on the raw
  // orchestrator.
  const source = orchestrator.runBatch(batchInput);
  const completionDeferred = createDeferred<BatchSummary>();

  async function* proxy(): AsyncIterable<BatchEvent> {
    try {
      for await (const ev of source) {
        if (ev.type === 'batch-completed') {
          const summary = await finalize(db, paths, batchId, ev.summary, opts.leads.length);
          completionDeferred.resolve(summary);
        }
        yield ev;
      }
    } catch (err) {
      completionDeferred.reject(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  return { batchId, paths, events: proxy(), completion: completionDeferred.promise };
}

async function finalize(
  db: DbClient,
  paths: PathHelpers,
  batchId: string,
  summary: { done: number; failed: number; totalMs: number },
  total: number,
): Promise<BatchSummary> {
  const leads = db.getLeads(batchId);
  const reportPath = paths.report(batchId);
  await writeFile(reportPath, formatReportCsv(leads), 'utf8');
  return {
    batchId,
    total,
    done: summary.done,
    failed: summary.failed,
    reportPath,
  };
}

// Match the API's [1, 300] bound on durationSec, plus a 1-decimal round
// (ffmpeg `-t` accepts decimals; this just keeps the value tidy in logs).
function clampDurationSec(seconds: number): number {
  const bounded = Math.max(1, Math.min(300, seconds));
  return Math.round(bounded * 10) / 10;
}

// Used when the caller doesn't supply a `name`. The result is just a
// placeholder — every API surface lets the user rename later — but it has
// to be informative enough that a list of "Batch 2026-05-02" entries is
// distinguishable at a glance.
function defaultBatchName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `Batch ${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Process-shutdown helper for long-lived hosts (Next dev server, prod node).
// Idempotent. Tests should call this in afterAll to release Chromium.
export async function shutdownEngine(): Promise<void> {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
    sharedDbPath = null;
  }
  const { shutdownCapturePool } = await import('@/pipeline/capture');
  const { shutdownRecordPool } = await import('@/pipeline/record');
  await shutdownCapturePool();
  await shutdownRecordPool();
}

// ────────────────────── recording-mode adapters ──────────────────────

// Wraps recordWebsite in the CaptureFn shape so the orchestrator doesn't
// need to know the difference. The output path arrives as ".png" (the
// orchestrator's screenshotFor convention) but we rewrite to .webm — the
// downstream render step reads it as a video input.
function createRecordingCapture(
  durationSec: number,
  resolution: BatchConfig['resolution'],
  scrollMode: BatchConfig['recordingScrollMode'],
  fallbackCapture: CaptureFn,
): CaptureFn {
  // Match the recorder's viewport to the final output resolution so the
  // downstream filter graph's scale-cover stage is a no-op instead of a
  // bilinear upscale (which softens text on every recording).
  const dims = RESOLUTIONS[resolution];
  return async (input) => {
    if (input.url === '') return fallbackCapture(input);
    const { recordWebsite } = await import('@/pipeline/record');
    const webmPath = input.outputPath.replace(/\.png$/i, '.webm');
    const result = await recordWebsite({
      url: input.url,
      outputPath: webmPath,
      durationSec,
      viewportWidth: dims.width,
      viewportHeight: dims.height,
      scrollMode,
    });
    return {
      pngPath: result.videoPath, // CaptureResult.pngPath is reused as a generic background-source path here
      width: result.width,
      height: result.height,
      capturedAtMs: result.capturedAtMs,
      durationMs: result.durationMs,
      videoStartOffsetSec: result.videoStartOffsetSec,
    };
  };
}

// Wraps a RenderFn so every job is tagged backgroundKind='video'. The job's
// own value (if any) takes precedence so a per-lead override still wins.
function wrapRenderWithVideoBackground(base: RenderFn): RenderFn {
  return (job) => base({ ...job, backgroundKind: job.backgroundKind ?? 'video' });
}

function getSharedDb(filename: string): DbClient {
  if (sharedDb && sharedDbPath !== filename) {
    sharedDb.close();
    sharedDb = null;
    sharedDbPath = null;
  }
  if (!sharedDb) {
    sharedDb = createDbClient({ filename });
    sharedDbPath = filename;
  }
  return sharedDb;
}

async function defaultCaptureFn(): Promise<CaptureFn> {
  const { captureWebsite } = await import('@/pipeline/capture');
  return captureWebsite;
}

async function defaultRenderFn(): Promise<RenderFn> {
  const { createRender } = await import('@/pipeline/render');
  return createRender({ maskDir: path.join(process.cwd(), 'public') });
}
