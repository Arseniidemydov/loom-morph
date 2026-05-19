import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runBatch, shutdownEngine } from '@/lib/engine';
import { getBatchSnapshot, listBatches } from '@/lib/snapshot';
import type { CaptureFn, RenderFn } from '@/types';

const baseConfig = {
  durationSec: 30,
  resolution: '1080p' as const,
  circlePosition: 'bottom-right' as const,
  circleSize: 'M' as const,
  circleMargin: 40,
  filenameTemplate: '{company}.mp4',
};

const successCapture: CaptureFn = async ({ outputPath }) => {
  await writeFile(outputPath, 'png');
  return { pngPath: outputPath, width: 1280, height: 4000, capturedAtMs: Date.now(), durationMs: 1 };
};
const successRender: RenderFn = async ({ outputPath }) => {
  await writeFile(outputPath, 'mp4');
  return { outputPath, durationMs: 1 };
};

afterEach(async () => {
  await shutdownEngine();
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('getBatchSnapshot', () => {
  it('returns null for an unknown batch id', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snap-'));
    try {
      // No DB exists yet — snapshot should return null cleanly, not throw.
      const snap = getBatchSnapshot('nope', { dataRoot: root });
      expect(snap).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns batch + leads + counts for a completed mock batch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snap-'));
    try {
      const running = await runBatch({
        batchId: 'snap-batch-1',
        dataRoot: root,
        config: baseConfig,
        leads: [
          { rowIndex: 0, website: 'https://a.example/', csvData: { company: 'Acme' } },
          { rowIndex: 1, website: 'https://b.example/', csvData: { company: 'Beta' } },
        ],
        assets: { circleSourcePath: path.join(root, 'circle.png') },
        capture: successCapture,
        render: successRender,
      });
      await collect(running.events);
      await running.completion;
      // Engine holds the DB open in its singleton; close so the snapshot can
      // open its own.
      await shutdownEngine();

      const snap = getBatchSnapshot('snap-batch-1', { dataRoot: root });
      expect(snap).not.toBeNull();
      expect(snap!.batch.id).toBe('snap-batch-1');
      expect(snap!.counts).toEqual({ total: 2, pending: 0, capturing: 0, rendering: 0, done: 2, failed: 0 });
      expect(snap!.outputs).toHaveLength(2);
      expect(snap!.outputs[0]!.path.endsWith('.mp4')).toBe(true);
      expect(snap!.hasOutputs).toBe(true);
      expect(snap!.reportPath.endsWith('report.csv')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts mixed statuses correctly when some leads fail', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snap-'));
    try {
      const capture: CaptureFn = async ({ url, outputPath }) => {
        if (url.includes('bad')) throw new Error('synthetic failure');
        await writeFile(outputPath, 'png');
        return { pngPath: outputPath, width: 1280, height: 4000, capturedAtMs: Date.now(), durationMs: 1 };
      };

      const running = await runBatch({
        batchId: 'snap-batch-2',
        dataRoot: root,
        config: baseConfig,
        leads: [
          { rowIndex: 0, website: 'https://good.example/', csvData: {} },
          { rowIndex: 1, website: 'https://bad.example/', csvData: {} },
          { rowIndex: 2, website: 'https://alsogood.example/', csvData: {} },
        ],
        assets: { circleSourcePath: path.join(root, 'circle.png') },
        capture,
        render: successRender,
      });
      await collect(running.events);
      await running.completion;
      await shutdownEngine();

      const snap = getBatchSnapshot('snap-batch-2', { dataRoot: root });
      expect(snap!.counts.done).toBe(2);
      expect(snap!.counts.failed).toBe(1);
      expect(snap!.outputs).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('listBatches', () => {
  it('returns empty list when DB does not exist', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snap-'));
    try {
      expect(listBatches({ dataRoot: root })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns empty list when the DB file exists but has no schema yet', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snap-'));
    try {
      const dbPath = path.join(root, 'data', 'loom-morph.sqlite');
      await mkdir(path.dirname(dbPath), { recursive: true });
      await writeFile(dbPath, '');
      expect(listBatches({ dataRoot: root })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists all batches most-recent-first', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'snap-'));
    try {
      // Run two batches sequentially so created_at differs.
      const r1 = await runBatch({
        batchId: 'list-a',
        dataRoot: root,
        config: baseConfig,
        leads: [{ rowIndex: 0, website: 'https://a.example/', csvData: {} }],
        assets: { circleSourcePath: path.join(root, 'circle.png') },
        capture: successCapture,
        render: successRender,
      });
      await collect(r1.events);
      await r1.completion;
      // Don't shutdown between — engine reuses the DB singleton, sequential
      // batches share it.
      await new Promise((r) => setTimeout(r, 10));
      const r2 = await runBatch({
        batchId: 'list-b',
        dataRoot: root,
        config: baseConfig,
        leads: [{ rowIndex: 0, website: 'https://b.example/', csvData: {} }],
        assets: { circleSourcePath: path.join(root, 'circle.png') },
        capture: successCapture,
        render: successRender,
      });
      await collect(r2.events);
      await r2.completion;
      await shutdownEngine();

      const list = listBatches({ dataRoot: root });
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe('list-b'); // most recent first
      expect(list[1]!.id).toBe('list-a');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
