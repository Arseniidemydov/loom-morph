import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDbClient, type DbClient } from '@/db/client';
import { BatchOrchestrator, type OrchestratorPaths } from '@/orchestrator/orchestrator';
import type {
  BatchConfig,
  BatchEvent,
  BatchInput,
  CaptureFn,
  LeadInput,
  RenderFn,
} from '@/types';
import { inferCircleHasAudio } from './circle-source';
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

  // For 'recording' mode the capture function records a WebM and the render
  // function tags every job with backgroundKind='video'. The orchestrator
  // doesn't need to know about modes at all — the engine handles routing
  // at the boundary.
  const captureFn =
    captureMode === 'recording'
      ? createRecordingCapture(opts.config.durationSec, baseCapture)
      : baseCapture;
  const renderFn =
    captureMode === 'recording' ? wrapRenderWithVideoBackground(baseRender) : baseRender;

  const circleHasAudio = opts.assets.circleHasAudio ?? inferCircleHasAudio(opts.assets.circleSourcePath);

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
    config: opts.config,
    leads: opts.leads,
    circleSourcePath: opts.assets.circleSourcePath,
    circleHasAudio,
    audioPath: opts.assets.audioPath,
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

// Final report — one row per lead. Columns chosen to be useful for "manually
// retry these failed leads" workflows.
function formatReportCsv(leads: ReturnType<DbClient['getLeads']>): string {
  const header = ['row_index', 'website', 'status', 'output_path', 'capture_ms', 'render_ms', 'error'];
  const lines = [header.join(',')];
  for (const lead of leads) {
    lines.push(
      [
        String(lead.rowIndex),
        csvEscape(lead.website),
        lead.status,
        csvEscape(lead.outputPath ?? ''),
        lead.captureMs?.toString() ?? '',
        lead.renderMs?.toString() ?? '',
        csvEscape(lead.error ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
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
function createRecordingCapture(durationSec: number, fallbackCapture: CaptureFn): CaptureFn {
  return async (input) => {
    if (input.url === '') return fallbackCapture(input);
    const { recordWebsite } = await import('@/pipeline/record');
    const webmPath = input.outputPath.replace(/\.png$/i, '.webm');
    const result = await recordWebsite({
      url: input.url,
      outputPath: webmPath,
      durationSec,
    });
    return {
      pngPath: result.videoPath, // CaptureResult.pngPath is reused as a generic background-source path here
      width: result.width,
      height: result.height,
      capturedAtMs: result.capturedAtMs,
      durationMs: result.durationMs,
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
