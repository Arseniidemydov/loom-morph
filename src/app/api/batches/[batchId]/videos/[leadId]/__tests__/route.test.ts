import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, deleteVideoResponse, getVideoResponse } from '../route';
import { createDbClient } from '@/db/client';
import { registerRunningBatch } from '@/lib/batch-registry';
import { createPaths, type PathHelpers } from '@/lib/storage';
import type { RunningBatch } from '@/lib/engine';
import type { BatchEvent, BatchInput, BatchRecord, LeadRecord } from '@/types';
import type { BatchSnapshot } from '@/lib/snapshot';

const createdOutputDirs: string[] = [];
const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdOutputDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(
    createdRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
  createdOutputDirs.length = 0;
  createdRoots.length = 0;
});

describe('batch video route', () => {
  it('streams a completed rendered MP4', async () => {
    const { batchId, leadId, videoPath, bytes } = await createRegisteredVideo();

    const response = await GET(new Request('http://localhost/video'), {
      params: { batchId, leadId },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(videoPath).toContain(path.join('output', batchId));
  });

  it('supports byte-range requests for browser video seeking', async () => {
    const { batchId, leadId, bytes } = await createRegisteredVideo();

    const response = await GET(
      new Request('http://localhost/video', {
        headers: { range: 'bytes=2-5' },
      }),
      { params: { batchId, leadId } },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toBe(
      `bytes 2-5/${bytes.byteLength}`,
    );
    expect(response.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(2, 6));
  });

  it('falls back to persisted snapshot output after the live registry is gone', async () => {
    const root = await tempRoot();
    const paths = createPaths({ root });
    const batchId = 'persisted-batch';
    const leadId = 'persisted-lead';
    const bytes = Buffer.from('persisted mp4 bytes');
    const videoPath = paths.output(batchId, 'persisted.mp4');
    await mkdir(paths.outputDir(batchId), { recursive: true });
    await writeFile(videoPath, bytes);

    const response = await getVideoResponse(
      new Request('http://localhost/video', {
        headers: { range: 'bytes=0-8' },
      }),
      { batchId, leadId },
      {
        paths,
        getBatch: () => undefined,
        getSnapshot: () => fakeSnapshot(batchId, leadId, videoPath),
      },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-8/${bytes.byteLength}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 9));
  });

  it('returns 409 when the lead has not completed yet', async () => {
    const batchId = uniqueId('pending');
    registerRunningBatch(fakeRunningBatch(batchId, []));
    await tick();

    const response = await GET(new Request('http://localhost/video'), {
      params: { batchId, leadId: 'lead-1' },
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toBe('Video not ready');
  });

  it('returns 404 for a completed event outside the batch output directory', async () => {
    const batchId = uniqueId('escape');
    registerRunningBatch(
      fakeRunningBatch(batchId, [
        {
          type: 'lead-completed',
          leadId: 'lead-1',
          outputPath: path.resolve('outside.mp4'),
        },
      ]),
    );
    await tick();

    const response = await GET(new Request('http://localhost/video'), {
      params: { batchId, leadId: 'lead-1' },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Video not found');
  });

  it('rejects malformed ranges', async () => {
    const { batchId, leadId, bytes } = await createRegisteredVideo();

    const response = await GET(
      new Request('http://localhost/video', {
        headers: { range: `bytes=${bytes.byteLength}-999` },
      }),
      { params: { batchId, leadId } },
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${bytes.byteLength}`);
  });

  it('deletes a rendered MP4 and clears the persisted lead output', async () => {
    const root = await tempRoot();
    const paths = createPaths({ root });
    const batchId = 'delete-video-batch';
    const leadId = 'delete-video-lead';
    const videoPath = paths.output(batchId, 'delete-me.mp4');
    await mkdir(paths.outputDir(batchId), { recursive: true });
    await mkdir(path.dirname(paths.db()), { recursive: true });
    await writeFile(videoPath, 'mp4 bytes');

    const db = createDbClient({ filename: paths.db(), clock: () => 1 });
    db.insertBatch(fakeBatchInput(batchId));
    db.insertLeads([fakeLeadRecord(batchId, leadId, videoPath)]);
    db.close();

    const response = await deleteVideoResponse(
      { batchId, leadId },
      { paths, getBatch: () => undefined },
    );
    const body = (await response.json()) as {
      deleted: boolean;
      lead: { status: string; outputPath?: string; error?: string };
    };

    expect(response.status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.lead).toMatchObject({ status: 'failed', error: 'Video deleted' });
    expect(body.lead.outputPath).toBeUndefined();
    expect(existsSync(videoPath)).toBe(false);
    expect(await readFile(paths.report(batchId), 'utf8')).toContain('failed');
  });
});

async function createRegisteredVideo() {
  const batchId = uniqueId('video');
  const leadId = 'lead-1';
  const paths = createPaths();
  await mkdir(paths.outputDir(batchId), { recursive: true });
  createdOutputDirs.push(paths.outputDir(batchId));

  const bytes = Buffer.from('fake mp4 bytes');
  const videoPath = paths.output(batchId, 'lead-1.mp4');
  await writeFile(videoPath, bytes);
  registerRunningBatch(
    fakeRunningBatch(batchId, [
      { type: 'lead-completed', leadId, outputPath: videoPath },
    ]),
  );
  await tick();

  return { batchId, leadId, videoPath, bytes };
}

function fakeRunningBatch(batchId: string, events: BatchEvent[]): RunningBatch {
  return {
    batchId,
    paths: {} as PathHelpers,
    events: eventSource(events),
    completion: Promise.resolve({
      batchId,
      total: 1,
      done: 1,
      failed: 0,
      reportPath: path.resolve('report.csv'),
    }),
  };
}

async function* eventSource(events: BatchEvent[]): AsyncIterable<BatchEvent> {
  for (const event of events) yield event;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-video-route-'));
  createdRoots.push(root);
  return root;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function fakeSnapshot(batchId: string, leadId: string, outputPath: string): BatchSnapshot {
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
    id: leadId,
    batchId,
    rowIndex: 0,
    website: 'https://example.com/',
    csvData: { company: 'Example' },
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
    reportPath: path.resolve('report.csv'),
    outputs: [{ leadId, path: outputPath }],
  };
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

function fakeLeadRecord(batchId: string, leadId: string, outputPath: string): LeadRecord {
  return {
    id: leadId,
    batchId,
    rowIndex: 0,
    website: 'https://example.com/',
    csvData: { company: 'Example' },
    status: 'done',
    outputPath,
    captureMs: 1,
    renderMs: 2,
  };
}
