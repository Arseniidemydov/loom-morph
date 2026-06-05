import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  type BatchEvent,
  type BatchInput,
  type CaptureFn,
  type LeadInput,
  type LeadRecord,
  type RenderFn,
} from '@/types';
import type { DbClient } from '@/db/client';
import { renderFilename } from '@/lib/render-filename';
import { processLead as runLeadPipeline } from '@/worker/process-lead';
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
  capturePoolSize?: number;       // default 5 — keeps the local machine usable
  renderPoolSize?: number;        // default min(cpus - 1, 5) — same constraint
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
    this.capturePool = createPool(deps.capturePoolSize ?? 5);
    this.renderPool = createPool(
      deps.renderPoolSize ?? Math.min(Math.max(1, os.cpus().length - 1), 5),
    );
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
    const filename = renderFilename(batch.config.filenameTemplate || '', lead);
    const outputPath = this.paths.outputFor(batch.id, lead.id, lead, filename);

    const result = await runLeadPipeline(
      {
        url: lead.website,
        screenshotPath: this.paths.screenshotFor(batch.id, lead.id),
        outputPath,
        circleSourcePath: batch.circleSourcePath,
        circleHasAudio: batch.circleHasAudio,
        audioPath: batch.audioPath,
        config: batch.config,
      },
      {
        capture: this.capture,
        render: this.render,
        runCapture: (fn) => this.capturePool.run(fn),
        runRender: (fn) => this.renderPool.run(fn),
        clock: this.clock,
        captureRetries: this.captureRetries,
      },
      {
        onCapturing: () => this.transition(lead, 'capturing', channel),
        onRendering: () => this.transition(lead, 'rendering', channel),
      },
    );

    if (!result.ok) {
      this.fail(lead, result.error, channel);
      return false;
    }

    this.db.updateLeadResult(lead.id, result.outputPath, result.captureMs, result.renderMs);
    channel.emit({ type: 'lead-status', leadId: lead.id, status: 'done' });
    channel.emit({ type: 'lead-completed', leadId: lead.id, outputPath: result.outputPath });
    return true;
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

