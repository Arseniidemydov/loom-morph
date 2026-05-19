import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getArchiveResponse } from '../route';
import { createPaths } from '@/lib/storage';
import type { BatchSnapshot } from '@/lib/snapshot';
import type { BatchRecord, LeadRecord } from '@/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('batch archive route', () => {
  it('streams the MP4 ZIP from persisted snapshot state after registry loss', async () => {
    const root = await tempRoot();
    const paths = createPaths({ root });
    const batchId = 'archive-batch';
    await mkdir(paths.outputDir(batchId), { recursive: true });
    await writeFile(paths.output(batchId, 'lead-1.mp4'), 'fake mp4');
    await writeFile(paths.report(batchId), 'row_index,website,status\n');

    const response = await getArchiveResponse(
      { batchId },
      {
        paths,
        getBatch: () => undefined,
        getSnapshot: () => fakeSnapshot(batchId, paths.output(batchId, 'lead-1.mp4')),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${batchId}-videos.zip"`,
    );
    expect(response.headers.get('x-mp4-count')).toBe('1');
    expect(response.headers.get('x-report-included')).toBe('true');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it('returns 409 when persisted batch exists but output directory is missing', async () => {
    const root = await tempRoot();
    const paths = createPaths({ root });
    const batchId = 'archive-missing-output';

    const response = await getArchiveResponse(
      { batchId },
      {
        paths,
        getBatch: () => undefined,
        getSnapshot: () => fakeSnapshot(batchId, paths.output(batchId, 'lead-1.mp4')),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe('Archive not ready');
  });

  it('returns 404 when neither live registry nor persisted snapshot has the batch', async () => {
    const response = await getArchiveResponse(
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-archive-route-'));
  roots.push(root);
  return root;
}

function fakeSnapshot(batchId: string, outputPath: string): BatchSnapshot {
  const batch: BatchRecord = {
    id: batchId,
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
  const lead: LeadRecord = {
    id: 'lead-1',
    batchId,
    rowIndex: 0,
    website: 'https://a.example/',
    csvData: {},
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
    reportPath: path.join(path.dirname(outputPath), 'report.csv'),
    outputs: [{ leadId: lead.id, path: outputPath }],
  };
}
