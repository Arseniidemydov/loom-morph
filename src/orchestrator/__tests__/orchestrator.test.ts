import { describe, expect, it, vi } from 'vitest';
import { CaptureError, type BatchEvent, type BatchInput, type CaptureFn, type CaptureResult, type RenderFn, type RenderResult } from '@/types';
import { createDbClient } from '@/db/client';
import { BatchOrchestrator, type OrchestratorPaths } from '@/orchestrator/orchestrator';

// Test helpers ────────────────────────────────────────────────────────

const baseConfig = {
  durationSec: 30,
  resolution: '1080p' as const,
  circlePosition: 'bottom-right' as const,
  circleSize: 'M' as const,
  circleMargin: 40,
  filenameTemplate: '',
};

function makeBatch(leadCount: number, overrides: Partial<BatchInput> = {}): BatchInput {
  const leads = Array.from({ length: leadCount }, (_, i) => ({
    rowIndex: i,
    website: `https://lead${i}.example`,
    csvData: { i: String(i) },
  }));
  return {
    id: 'batch-1',
    config: baseConfig,
    leads,
    circleSourcePath: '/tmp/circle.png',
    circleHasAudio: false,
    ...overrides,
  };
}

const fakePaths: OrchestratorPaths = {
  screenshotFor: (batchId, leadId) => `/tmp/${batchId}/${leadId}.png`,
  outputFor: (batchId, leadId, _lead, filename) => `/output/${batchId}/${filename || leadId + '.mp4'}`,
};

// Auto-incrementing ids so test assertions are stable.
function uuidGen() {
  let n = 0;
  return () => `lead-${++n}`;
}

const successCapture: CaptureFn = async ({ outputPath }): Promise<CaptureResult> => ({
  pngPath: outputPath,
  width: 1280,
  height: 4000,
  capturedAtMs: 0,
  durationMs: 1,
});

const successRender: RenderFn = async ({ outputPath }): Promise<RenderResult> => ({
  outputPath,
  durationMs: 1,
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// Tests ───────────────────────────────────────────────────────────────

describe('BatchOrchestrator', () => {
  it('happy path: emits batch-started first, batch-completed last, all done', async () => {
    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture: successCapture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const events = await collect(orch.runBatch(makeBatch(3)));

    expect(events[0]).toEqual({ type: 'batch-started', batchId: 'batch-1', total: 3 });
    expect(events.at(-1)).toMatchObject({ type: 'batch-completed', batchId: 'batch-1', summary: { done: 3, failed: 0 } });

    const completedCount = events.filter((e) => e.type === 'lead-completed').length;
    expect(completedCount).toBe(3);

    // DB reflects done state
    const leads = db.getLeads('batch-1');
    expect(leads.every((l) => l.status === 'done')).toBe(true);
    expect(leads.every((l) => l.outputPath?.startsWith('/output/'))).toBe(true);
    db.close();
  });

  it('per-lead status transitions: pending → capturing → rendering → done', async () => {
    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture: successCapture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const events = await collect(orch.runBatch(makeBatch(1)));
    const statuses = events
      .filter((e): e is Extract<BatchEvent, { type: 'lead-status' }> => e.type === 'lead-status')
      .map((e) => e.status);
    expect(statuses).toEqual(['capturing', 'rendering', 'done']);
    db.close();
  });

  it('isolates per-lead failure: one bot-blocked lead does not abort the batch', async () => {
    const capture: CaptureFn = vi.fn(async ({ url, outputPath }) => {
      if (url.includes('lead1.')) {
        throw new CaptureError('bot-blocked', 'cloudflare interstitial');
      }
      return { pngPath: outputPath, width: 1280, height: 4000, capturedAtMs: 0, durationMs: 1 };
    });

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const events = await collect(orch.runBatch(makeBatch(3)));
    const completed = events.find((e) => e.type === 'batch-completed');
    expect(completed).toMatchObject({ type: 'batch-completed', summary: { done: 2, failed: 1 } });

    const failedStatus = events.find(
      (e): e is Extract<BatchEvent, { type: 'lead-status' }> => e.type === 'lead-status' && e.status === 'failed',
    );
    expect(failedStatus?.error).toMatch(/bot-blocked/);
    db.close();
  });

  it('retries capture once on timeout, succeeds on second attempt', async () => {
    let attempts = 0;
    const capture: CaptureFn = async ({ outputPath }) => {
      attempts += 1;
      if (attempts === 1) throw new CaptureError('timeout', 'first attempt timed out');
      return { pngPath: outputPath, width: 1280, height: 4000, capturedAtMs: 0, durationMs: 1 };
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const events = await collect(orch.runBatch(makeBatch(1)));
    expect(attempts).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'batch-completed', summary: { done: 1, failed: 0 } });
    db.close();
  });

  it('does NOT retry on bot-blocked even with capture retries available', async () => {
    let attempts = 0;
    const capture: CaptureFn = async () => {
      attempts += 1;
      throw new CaptureError('bot-blocked', 'cloudflare');
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
      retries: { capture: 3 }, // even with extra retries, bot-blocked is one-shot
    });

    const events = await collect(orch.runBatch(makeBatch(1)));
    expect(attempts).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'batch-completed', summary: { done: 0, failed: 1 } });
    db.close();
  });

  it('respects capture pool concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const capture: CaptureFn = async ({ outputPath }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { pngPath: outputPath, width: 1280, height: 4000, capturedAtMs: 0, durationMs: 1 };
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
      capturePoolSize: 2,
      renderPoolSize: 8,
    });

    await collect(orch.runBatch(makeBatch(8)));
    expect(peak).toBeLessThanOrEqual(2);
    db.close();
  });

  it('all-fail batch still emits batch-completed and marks batch failed in DB', async () => {
    const capture: CaptureFn = async () => {
      throw new CaptureError('bot-blocked', 'blocked');
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture,
      render: successRender,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const events = await collect(orch.runBatch(makeBatch(2)));
    expect(events.at(-1)).toMatchObject({ type: 'batch-completed', summary: { done: 0, failed: 2 } });
    expect(db.getBatch('batch-1')!.status).toBe('failed');
    db.close();
  });

  it('resolves {company} against common header aliases (Company, Account, Company Name)', async () => {
    const seenOutputs: string[] = [];
    const render: RenderFn = async ({ outputPath }) => {
      seenOutputs.push(outputPath);
      return { outputPath, durationMs: 1 };
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture: successCapture,
      render,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const batch: BatchInput = {
      id: 'batch-1',
      config: { ...baseConfig, filenameTemplate: '{company}.mp4' },
      leads: [
        // Spreadsheet-style "Company" header (capitalized).
        { rowIndex: 0, website: 'https://a.example', csvData: { Company: 'Acme' } },
        // HubSpot-style "Company Name" header (space).
        { rowIndex: 1, website: 'https://b.example', csvData: { 'Company Name': 'Northwind' } },
        // Salesforce-style "Account" header.
        { rowIndex: 2, website: 'https://c.example', csvData: { Account: 'Globex' } },
      ],
      circleSourcePath: '/tmp/circle.png',
      circleHasAudio: false,
    };
    await collect(orch.runBatch(batch));

    const filenames = seenOutputs.map((p) => p.split('/').at(-1));
    expect(filenames).toContain('Acme.mp4');
    expect(filenames).toContain('Northwind.mp4');
    expect(filenames).toContain('Globex.mp4');
    db.close();
  });

  it('{company} falls back to first name when no company column is present', async () => {
    const seenOutputs: string[] = [];
    const render: RenderFn = async ({ outputPath }) => {
      seenOutputs.push(outputPath);
      return { outputPath, durationMs: 1 };
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture: successCapture,
      render,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const batch: BatchInput = {
      id: 'batch-1',
      config: { ...baseConfig, filenameTemplate: '{company} and vibeflow.mp4' },
      leads: [
        // No company column — should resolve to first name.
        { rowIndex: 0, website: 'https://a.example', csvData: { firstName: 'Anna' } },
        // Has company column — uses it.
        { rowIndex: 1, website: 'https://b.example', csvData: { Company: 'Northwind' } },
        // Full-name column "Name" — split to first word.
        { rowIndex: 2, website: 'https://c.example', csvData: { 'First Name': 'Bjorn Eriksson' } },
      ],
      circleSourcePath: '/tmp/circle.png',
      circleHasAudio: false,
    };
    await collect(orch.runBatch(batch));

    const filenames = seenOutputs.map((p) => p.split('/').at(-1));
    expect(filenames).toContain('Anna and vibeflow.mp4');
    expect(filenames).toContain('Northwind and vibeflow.mp4');
    expect(filenames).toContain('Bjorn and vibeflow.mp4');
    db.close();
  });

  it('renders filename template with csvData; falls back when token missing', async () => {
    const seenOutputs: string[] = [];
    const render: RenderFn = async ({ outputPath }) => {
      seenOutputs.push(outputPath);
      return { outputPath, durationMs: 1 };
    };

    const db = createDbClient({ filename: ':memory:' });
    const orch = new BatchOrchestrator({
      capture: successCapture,
      render,
      db,
      paths: fakePaths,
      uuid: uuidGen(),
    });

    const batch: BatchInput = {
      id: 'batch-1',
      config: { ...baseConfig, filenameTemplate: '{company}.mp4' },
      leads: [
        { rowIndex: 0, website: 'https://a.example', csvData: { company: 'Acme' } },
        { rowIndex: 1, website: 'https://b.example', csvData: { other: 'no-company' } },
      ],
      circleSourcePath: '/tmp/circle.png',
      circleHasAudio: false,
    };
    await collect(orch.runBatch(batch));

    const filenames = seenOutputs.map((p) => p.split('/').at(-1));
    expect(filenames).toContain('Acme.mp4');
    expect(filenames).toContain('lead-2.mp4'); // fallback when {company} missing
    db.close();
  });
});
