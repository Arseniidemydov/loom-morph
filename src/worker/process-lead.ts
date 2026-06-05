import {
  CaptureError,
  RenderError,
  type BatchConfig,
  type CaptureFn,
  type CaptureResult,
  type RenderFn,
  type RenderJob,
} from '@/types';

// The per-lead capture → render pipeline, lifted verbatim out of
// BatchOrchestrator.processLead so it can run in two places without
// duplication:
//   - the in-process orchestrator (CLI / local dev), which wraps capture and
//     render in p-limit pools and emits events through an in-memory channel;
//   - the distributed worker (Phase 3), which runs one lead per BullMQ job,
//     has no pools, and publishes events to Redis + Postgres.
//
// The function owns ONLY the capture/render mechanics and the in-process
// retry logic (cheap retries on the same warm browser / under peak ffmpeg
// load). Everything environment-specific — concurrency, persistence, event
// transport, path resolution — is injected. The caller maps the returned
// outcome to its own side effects (DB writes, done/failed events).

export interface ProcessLeadJob {
  url: string; // pre-normalized website
  screenshotPath: string; // where capture writes (png, or webm in recording mode)
  outputPath: string; // where render writes the final mp4
  circleSourcePath: string;
  circleHasAudio: boolean;
  audioPath?: string;
  config: BatchConfig;
}

export interface ProcessLeadDeps {
  capture: CaptureFn;
  render: RenderFn;
  // Concurrency wrappers. The orchestrator passes its p-limit pools; the
  // distributed worker passes identity (BullMQ controls concurrency). The
  // capture wrapper holds one slot for the whole retry loop (matching the
  // original behavior); each render attempt re-acquires a slot so a transient
  // retry re-queues rather than hogging.
  runCapture: <T>(fn: () => Promise<T>) => Promise<T>;
  runRender: <T>(fn: () => Promise<T>) => Promise<T>;
  clock: () => number;
  captureRetries: number;
}

// Side-effect hooks fired at each stage boundary, before the work starts —
// exactly where the orchestrator emitted its 'capturing' / 'rendering'
// transitions. Kept separate from the terminal outcome so the caller decides
// how to persist and broadcast.
export interface ProcessLeadHooks {
  onCapturing(): void;
  onRendering(): void;
}

export type ProcessLeadResult =
  | { ok: true; outputPath: string; captureMs: number; renderMs: number }
  | { ok: false; error: string };

export async function processLead(
  job: ProcessLeadJob,
  deps: ProcessLeadDeps,
  hooks: ProcessLeadHooks,
): Promise<ProcessLeadResult> {
  // Capture stage
  hooks.onCapturing();
  let captureResult: CaptureResult;
  const captureStart = deps.clock();
  try {
    captureResult = await deps.runCapture(() => captureWithRetries(job, deps));
  } catch (err) {
    return { ok: false, error: formatErrorReason(err) };
  }
  const captureMs = deps.clock() - captureStart;

  // Render stage
  hooks.onRendering();
  const renderStart = deps.clock();
  try {
    const renderJob: RenderJob = {
      screenshotPath: captureResult.pngPath,
      screenshotHeight: captureResult.height,
      circleSourcePath: job.circleSourcePath,
      circleHasAudio: job.circleHasAudio,
      audioPath: job.audioPath,
      outputPath: job.outputPath,
      config: job.config,
      backgroundStartOffsetSec: captureResult.videoStartOffsetSec,
    };
    // ffmpeg sometimes exits with EINVAL (visible as code 234) under peak
    // concurrent load — fd exhaustion or transient libx264 buffer allocation
    // failures that aren't deterministic from the input. One render retry
    // catches these cleanly; persistent failures (bad input, missing codec)
    // fail through on the second attempt.
    try {
      await deps.runRender(() => deps.render(renderJob));
    } catch (firstErr) {
      if (!isLikelyTransientRenderError(firstErr)) throw firstErr;
      await deps.runRender(() => deps.render(renderJob));
    }
  } catch (err) {
    return { ok: false, error: formatErrorReason(err) };
  }
  const renderMs = deps.clock() - renderStart;

  return { ok: true, outputPath: job.outputPath, captureMs, renderMs };
}

async function captureWithRetries(
  job: ProcessLeadJob,
  deps: ProcessLeadDeps,
): Promise<CaptureResult> {
  let attempt = 0;
  // Total attempts = 1 + captureRetries (one initial try, plus N retries).
  // Retries only happen on transient reasons; bot-blocked / invalid-url
  // short-circuit.
  while (true) {
    try {
      return await deps.capture({ url: job.url, outputPath: job.screenshotPath });
    } catch (err) {
      const isRetryable =
        err instanceof CaptureError && (err.reason === 'timeout' || err.reason === 'network');
      if (!isRetryable || attempt >= deps.captureRetries) throw err;
      attempt += 1;
    }
  }
}

export function isLikelyTransientRenderError(err: unknown): boolean {
  // The two failure modes we see at peak concurrency:
  //   - ffmpeg exits with code 234 (= unsigned wrap of -22 / EINVAL),
  //     usually fd exhaustion or libx264 buffer alloc.
  //   - timeout (the orchestrator-side kill).
  // Codec / missing-input style failures will repeat on retry; those
  // we leave to surface as real errors.
  if (err instanceof RenderError) {
    if (err.reason === 'timeout') return true;
    if (err.reason === 'ffmpeg-error' && /code\s+(234|1)\b/.test(err.message)) return true;
  }
  return false;
}

export function formatErrorReason(err: unknown): string {
  if (err instanceof CaptureError) return `capture:${err.reason}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
