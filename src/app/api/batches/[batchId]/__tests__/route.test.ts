import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteBatchResponse, getBatchResponse } from '../route';
import { createDbClient } from '@/db/client';
import type { RegisteredBatch } from '@/lib/batch-registry';
import { createPaths } from '@/lib/storage';
import type { BatchSnapshot } from '@/lib/snapshot';
import type { BatchInput, BatchRecord, LeadRecord } from '@/types';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.map((root) => rm(root, { recursive: true, force: true })));
  createdRoots.length = 0;
});

describe('batch snapshot route', () => {
  it('returns persisted batch state in the shape the workbench can restore', async () => {
    const response = getBatchResponse(
      { batchId: 'batch-1' },
      { getSnapshot: () => fakeSnapshot() },
    );
    const body = (await response.json()) as {
      batchId: string;
      status: string;
      reportUrl: string;
      archiveUrl: string;
      eventsUrl: string;
      leads: Array<{
        id: string;
        company: string;
        status: string;
        progress: number;
        outputPath?: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      batchId: 'batch-1',
      status: 'done',
      reportUrl: '/api/batches/batch-1/report',
      archiveUrl: '/api/batches/batch-1/archive',
      eventsUrl: '/api/batches/batch-1/events',
    });
    expect(body.leads).toEqual([
      expect.objectContaining({
        id: 'lead-1',
        company: 'Acme',
        status: 'done',
        progress: 100,
        outputPath: path.resolve('output/batch-1/acme.mp4'),
      }),
    ]);
  });

  it('returns 404 for an unknown batch', async () => {
    const response = getBatchResponse(
      { batchId: 'missing' },
      { getSnapshot: () => null },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Batch not found' });
  });

  it('deletes a persisted batch and its storage directories', async () => {
    const root = await tempRoot();
    const paths = createPaths({ root });
    const batchId = 'delete-batch';
    await Promise.all([
      mkdir(paths.uploads(batchId), { recursive: true }),
      mkdir(paths.tmpDir(batchId), { recursive: true }),
      mkdir(paths.outputDir(batchId), { recursive: true }),
      mkdir(path.dirname(paths.db()), { recursive: true }),
    ]);
    await writeFile(paths.upload(batchId, 'leads.csv'), 'website\nhttps://example.com\n');
    await writeFile(paths.output(batchId, 'lead.mp4'), 'mp4');

    const db = createDbClient({ filename: paths.db(), clock: () => 1 });
    db.insertBatch(fakeBatchInput(batchId));
    db.insertLeads([fakeLeadRecord(batchId, paths.output(batchId, 'lead.mp4'))]);
    db.finishBatch(batchId, 'done');
    db.close();

    const response = await deleteBatchResponse(
      { batchId },
      { paths, getRegistered: () => undefined, removeRegistered: () => true },
    );
    const body = (await response.json()) as { deleted: boolean };

    expect(response.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(existsSync(paths.uploads(batchId))).toBe(false);
    expect(existsSync(paths.outputDir(batchId))).toBe(false);

    const after = createDbClient({ filename: paths.db() });
    expect(after.getBatch(batchId)).toBeNull();
    expect(after.getLeads(batchId)).toEqual([]);
    after.close();
  });

  it('refuses to delete a still-running registered batch', async () => {
    const response = await deleteBatchResponse(
      { batchId: 'running' },
      {
        getRegistered: () =>
          ({
            batchId: 'running',
            events: [],
            completed: false,
            subscribe: () => () => undefined,
          }) as RegisteredBatch,
      },
    );

    expect(response.status).toBe(409);
  });
});

function fakeSnapshot(): BatchSnapshot {
  const batch: BatchRecord = {
    id: 'batch-1',
    status: 'done',
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
    finishedAt: 2,
  };
  const outputPath = path.resolve('output/batch-1/acme.mp4');
  const lead: LeadRecord = {
    id: 'lead-1',
    batchId: 'batch-1',
    rowIndex: 0,
    website: 'https://acme.example/',
    csvData: { Company: 'Acme' },
    status: 'done',
    outputPath,
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
    reportPath: path.resolve('output/batch-1/report.csv'),
    outputs: [{ leadId: lead.id, path: outputPath }],
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-batch-route-'));
  createdRoots.push(root);
  return root;
}

function fakeBatchInput(batchId: string): BatchInput {
  return {
    id: batchId,
    config: {
      durationSec: 30,
      resolution: '720p',
      circlePosition: 'bottom-right',
      circleSize: 'M',
      circleMargin: 40,
      filenameTemplate: '{company}.mp4',
    },
    leads: [{ rowIndex: 0, website: 'https://example.com/', csvData: { company: 'Example' } }],
    circleSourcePath: path.resolve('circle.png'),
    circleHasAudio: false,
  };
}

function fakeLeadRecord(batchId: string, outputPath: string): LeadRecord {
  return {
    id: 'lead-1',
    batchId,
    rowIndex: 0,
    website: 'https://example.com/',
    csvData: { company: 'Example' },
    status: 'done',
    outputPath,
  };
}
