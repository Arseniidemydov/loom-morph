import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  CaptureError,
  type BatchEvent,
  type BatchInput,
  type CaptureFn,
  type CaptureResult,
  type LeadInput,
  type LeadRecord,
  type RenderFn,
  type RenderJob,
} from '@/types';
import type { DbClient } from '@/db/client';
import { createEventChannel } from './events';
import { createPool, type Pool } from './pool';

// Path resolver injected by the caller. Keeps the orchestrator free of any
// filesystem-layout assumptions; the CLI spike (TASK-005) and the Phase 3 API
// will pass implementations backed by `src/lib/storage.ts`.
export interface OrchestratorPaths {
  screenshotFor(batchId: string, leadId: string): string;
  outputFor(batchId: string, leadId: string, lead: LeadInput, filename: string): string;
}

export interface OrchestratorDeps {
  capture: CaptureFn;
  render: RenderFn;
  db: DbClient;
  paths: OrchestratorPaths;
  clock?: () => number;
  capturePoolSize?: number;       // default 6
  renderPoolSize?: number;        // default min(cpus, 8)
  retries?: { capture: number };  // default { capture: 1 }
  uuid?: () => string;            // override for deterministic tests
}

export class BatchOrchestrator {
  private readonly capture: CaptureFn;
  private readonly render: RenderFn;
  private readonly db: DbClient;
  private readonly paths: OrchestratorPaths;
  private readonly clock: () => number;
  private readonly uuid: () => string;
  private readonly capturePool: Pool;
  private readonly renderPool: Pool;
  private readonly captureRetries: number;

  constructor(deps: OrchestratorDeps) {
    this.capture = deps.capture;
    this.render = deps.render;
    this.db = deps.db;
    this.paths = deps.paths;
    this.clock = deps.clock ?? (() => Date.now());
    this.uuid = deps.uuid ?? (() => randomUUID());
    this.capturePool = createPool(deps.capturePoolSize ?? 6);
    this.renderPool = createPool(deps.renderPoolSize ?? Math.min(os.cpus().length, 8));
    this.captureRetries = deps.retries?.capture ?? 1;
  }

  get capturePoolStats() {
    return { concurrency: this.capturePool.concurrency, active: this.capturePool.activeCount, pending: this.capturePool.pendingCount };
  }

  get renderPoolStats() {
    return { concurrency: this.renderPool.concurrency, active: this.renderPool.activeCount, pending: this.renderPool.pendingCount };
  }

  runBatch(batch: BatchInput): AsyncIterable<BatchEvent> {
    const channel = createEventChannel<BatchEvent>();

    // Drive the batch in the background; the consumer sees events via the channel.
    void this.driveBatch(batch, channel).catch((err) => {
      // Defensive: any escape from driveBatch is a bug. Surface it loudly.
      // eslint-disable-next-line no-console
      console.error('[orchestrator] internal error', err);
      channel.close();
    });

    return channel;
  }

  private async driveBatch(
    batch: BatchInput,
    channel: ReturnType<typeof createEventChannel<BatchEvent>>,
  ): Promise<void> {
    const startedAt = this.clock();

    // Create lead records up-front so the DB has the full picture before any
    // worker runs. Lead IDs are stable for downstream lookups.
    const leadRecords: LeadRecord[] = batch.leads.map((lead) => ({
      ...lead,
      id: this.uuid(),
      batchId: batch.id,
      status: 'pending',
    }));

    this.db.insertBatch(batch);
    this.db.insertLeads(leadRecords);

    channel.emit({ type: 'batch-started', batchId: batch.id, total: leadRecords.length });

    let done = 0;
    let failed = 0;

    const tasks = leadRecords.map((lead) =>
      this.processLead(batch, lead, channel)
        .then((ok) => {
          if (ok) done += 1;
          else failed += 1;
        }),
    );

    await Promise.all(tasks);

    const summary = { done, failed, totalMs: this.clock() - startedAt };
    this.db.finishBatch(batch.id, failed === leadRecords.length && leadRecords.length > 0 ? 'failed' : 'done');
    channel.emit({ type: 'batch-completed', batchId: batch.id, summary });
    channel.close();
  }

  private async processLead(
    batch: BatchInput,
    lead: LeadRecord,
    channel: ReturnType<typeof createEventChannel<BatchEvent>>,
  ): Promise<boolean> {
    // Capture stage
    this.transition(lead, 'capturing', channel);
    let captureResult: CaptureResult;
    const captureStart = this.clock();
    try {
      captureResult = await this.capturePool.run(() =>
        this.captureWithRetries(batch, lead),
      );
    } catch (err) {
      const reason = formatErrorReason(err);
      this.fail(lead, reason, channel);
      return false;
    }
    const captureMs = this.clock() - captureStart;

    // Render stage
    this.transition(lead, 'rendering', channel);
    const filename = renderFilename(batch, lead);
    const outputPath = this.paths.outputFor(batch.id, lead.id, lead, filename);
    const renderStart = this.clock();
    try {
      const renderJob: RenderJob = {
        screenshotPath: captureResult.pngPath,
        screenshotHeight: captureResult.height,
        circleSourcePath: batch.circleSourcePath,
        circleHasAudio: batch.circleHasAudio,
        audioPath: batch.audioPath,
        outputPath,
        config: batch.config,
      };
      await this.renderPool.run(() => this.render(renderJob));
    } catch (err) {
      const reason = formatErrorReason(err);
      this.fail(lead, reason, channel);
      return false;
    }
    const renderMs = this.clock() - renderStart;

    this.db.updateLeadResult(lead.id, outputPath, captureMs, renderMs);
    channel.emit({ type: 'lead-status', leadId: lead.id, status: 'done' });
    channel.emit({ type: 'lead-completed', leadId: lead.id, outputPath });
    return true;
  }

  private async captureWithRetries(batch: BatchInput, lead: LeadRecord): Promise<CaptureResult> {
    const outputPath = this.paths.screenshotFor(batch.id, lead.id);
    let attempt = 0;
    // Total attempts = 1 + this.captureRetries (one initial try, plus N retries).
    // Retries only happen on transient reasons; bot-blocked / invalid-url short-circuit.
    while (true) {
      try {
        return await this.capture({ url: lead.website, outputPath });
      } catch (err) {
        const isRetryable = err instanceof CaptureError && (err.reason === 'timeout' || err.reason === 'network');
        if (!isRetryable || attempt >= this.captureRetries) throw err;
        attempt += 1;
      }
    }
  }

  private transition(
    lead: LeadRecord,
    status: LeadRecord['status'],
    channel: ReturnType<typeof createEventChannel<BatchEvent>>,
  ): void {
    lead.status = status;
    this.db.updateLeadStatus(lead.id, status);
    channel.emit({ type: 'lead-status', leadId: lead.id, status });
  }

  private fail(
    lead: LeadRecord,
    reason: string,
    channel: ReturnType<typeof createEventChannel<BatchEvent>>,
  ): void {
    lead.status = 'failed';
    lead.error = reason;
    this.db.updateLeadStatus(lead.id, 'failed', reason);
    channel.emit({ type: 'lead-status', leadId: lead.id, status: 'failed', error: reason });
  }
}

// Render filename from BatchConfig.filenameTemplate, falling back to lead-{i}.
// Tokens are CSV column keys; if any required token is missing in csvData,
// fall back rather than emit a literal "{key}" filename.
function renderFilename(batch: BatchInput, lead: LeadRecord): string {
  const template = batch.config.filenameTemplate || '';
  const fallback = `lead-${lead.rowIndex + 1}.mp4`;
  if (!template) return fallback;
  let resolved = template;
  let missing = false;
  // `[^}]+` (vs `\w+`) so tokens can include spaces — real-world CSV headers
  // like "Company Name" need this.
  resolved = resolved.replace(/\{([^}]+)\}/g, (_match, raw: string) => {
    const key = raw.trim();
    if (key === 'i') return String(lead.rowIndex + 1);
    const value = lead.csvData[key];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return safeFilenameSegment(value);
  });
  if (missing) return fallback;
  // Ensure an .mp4 extension.
  if (!/\.mp4$/i.test(resolved)) resolved += '.mp4';
  return resolved;
}

function safeFilenameSegment(s: string): string {
  // Strip path separators and characters that misbehave on common filesystems.
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'unnamed';
}

function formatErrorReason(err: unknown): string {
  if (err instanceof CaptureError) return `capture:${err.reason}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
