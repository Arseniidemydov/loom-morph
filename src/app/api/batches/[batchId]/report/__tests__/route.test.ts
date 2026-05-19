import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getReportResponse } from '../route';
import type { BatchSnapshot } from '@/lib/snapshot';
import type { BatchRecord, LeadRecord } from '@/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('batch report route', () => {
  it('serves report.csv from persisted snapshot state after registry loss', async () => {
    const { batchId, reportPath } = await createReportFixture();

    const response = await getReportResponse(
      { batchId },
      {
        getBatch: () => undefined,
        getSnapshot: () => fakeSnapshot(batchId, reportPath, true),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${batchId}-report.csv"`,
    );
    expect(await response.text()).toBe('row_index,website,status\n0,https://a.example/,done\n');
  });

  it('returns 409 when persisted batch exists but report file is missing', async () => {
    const root = await tempRoot();
    const batchId = 'missing-report';
    const reportPath = path.join(root, 'output', batchId, 'report.csv');

    const response = await getReportResponse(
      { batchId },
      {
        getBatch: () => undefined,
        getSnapshot: () => fakeSnapshot(batchId, reportPath, true),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe('Report not ready');
  });

  it('returns 404 when neither live registry nor persisted snapshot has the batch', async () => {
    const response = await getReportResponse(
      { batchId: 'missing' },
      {
        getBatch: () => undefined,
        getSnapshot: () => null,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Batch not found');
  });
});

async function createReportFixture() {
  const root = await tempRoot();
  const batchId = 'report-batch';
  const outputDir = path.join(root, 'output', batchId);
  await mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, 'report.csv');
  await writeFile(reportPath, 'row_index,website,status\n0,https://a.example/,done\n');
  return { batchId, reportPath };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-report-route-'));
  roots.push(root);
  return root;
}

function fakeSnapshot(batchId: string, reportPath: string, finished: boolean): BatchSnapshot {
  const batch: BatchRecord = {
    id: batchId,
    status: finished ? 'done' : 'running',
    config: {
      durationSec: 30,
      resolution: '720p',
      circlePosition: 'bottom-right',
      circleSize: 'M',
      circleMargin: 40,
      filenameTemplate: '{company}.mp4',
    },
    total: 1,
    createdAt: 1,
    finishedAt: finished ? 2 : undefined,
  };
  const lead: LeadRecord = {
    id: 'lead-1',
    batchId,
    rowIndex: 0,
    website: 'https://a.example/',
    csvData: {},
    status: 'done',
    outputPath: path.join(path.dirname(reportPath), 'lead-1.mp4'),
  };

  return {
    batch,
    leads: [lead],
    counts: {
      total: 1,
      pending: 0,
      capturing: 0,
      rendering: 0,
      done: 1,
      failed: 0,
    },
    hasOutputs: true,
    reportPath,
    outputs: [{ leadId: lead.id, path: lead.outputPath! }],
  };
}
