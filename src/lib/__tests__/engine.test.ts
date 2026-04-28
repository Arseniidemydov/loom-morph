import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBatch, shutdownEngine } from '@/lib/engine';
import { getBatchSnapshot } from '@/lib/snapshot';
import type {
  BatchConfig,
  BatchEvent,
  CaptureFn,
  CaptureResult,
  RenderFn,
  RenderResult,
} from '@/types';

const baseConfig: BatchConfig = {
  durationSec: 30,
  resolution: '1080p',
  circlePosition: 'bottom-right',
  circleSize: 'M',
  circleMargin: 40,
  filenameTemplate: '{company}.mp4',
};

afterEach(async () => {
  await shutdownEngine();
});

describe('runBatch engine facade', () => {
  it('runs a mocked batch, forwards events, and writes report.csv', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-engine-'));
    const capture: CaptureFn = vi.fn(async ({ outputPath }): Promise<CaptureResult> => {
      await writeFile(outputPath, 'png');
      return {
        pngPath: outputPath,
        width: 1280,
        height: 2400,
        capturedAtMs: Date.now(),
        durationMs: 11,
      };
    });
    const render: RenderFn = vi.fn(async ({ outputPath }): Promise<RenderResult> => {
      await writeFile(outputPath, 'mp4');
      return { outputPath, durationMs: 22 };
    });

    const running = await runBatch({
      batchId: 'batch-engine',
      dataRoot: root,
      config: baseConfig,
      leads: [
        {
          rowIndex: 0,
          website: 'https://alpha.example/',
          csvData: { company: 'Alpha' },
        },
        {
          rowIndex: 1,
          website: 'https://beta.example/',
          csvData: { company: 'Beta' },
        },
      ],
      assets: { circleSourcePath: path.join(root, 'circle.png') },
      capture,
      render,
      capturePoolSize: 1,
      renderPoolSize: 1,
    });

    const events = await collect(running.events);
    const summary = await running.completion;

    expect(running.batchId).toBe('batch-engine');
    expect(events[0]).toEqual({
      type: 'batch-started',
      batchId: 'batch-engine',
      total: 2,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'batch-completed',
      batchId: 'batch-engine',
      summary: { done: 2, failed: 0 },
    });
    expect(summary).toMatchObject({
      batchId: 'batch-engine',
      total: 2,
      done: 2,
      failed: 0,
      reportPath: running.paths.report('batch-engine'),
    });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        circleHasAudio: false,
        outputPath: running.paths.output('batch-engine', 'Alpha.mp4'),
      }),
    );

    const report = await readFile(summary.reportPath, 'utf8');
    expect(report).toContain('row_index,website,status,output_path,capture_ms,render_ms,error');
    expect(report).toContain('0,https://alpha.example/,done,');
    expect(report).toContain('1,https://beta.example/,done,');
  });

  it('infers circle audio from video extensions and allows explicit override', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-engine-audio-'));
    const capture = successCapture();
    const render = vi.fn(successRender());

    const inferred = await runBatch({
      batchId: 'audio-inferred',
      dataRoot: root,
      config: baseConfig,
      leads: [lead('https://video.example/', 'Video')],
      assets: { circleSourcePath: path.join(root, 'face.webm') },
      capture,
      render,
    });
    await collect(inferred.events);
    await inferred.completion;

    await shutdownEngine();

    const overrideRoot = await mkdtemp(path.join(tmpdir(), 'loom-engine-audio-'));
    const explicit = await runBatch({
      batchId: 'audio-explicit',
      dataRoot: overrideRoot,
      config: baseConfig,
      leads: [lead('https://still.example/', 'Still')],
      assets: {
        circleSourcePath: path.join(overrideRoot, 'face.mp4'),
        circleHasAudio: false,
      },
      capture,
      render,
    });
    await collect(explicit.events);
    await explicit.completion;

    expect(render).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ circleHasAudio: true }),
    );
    expect(render).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ circleHasAudio: false }),
    );
  });

  it('keeps failed leads in the final report', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-engine-fail-'));
    const capture: CaptureFn = async ({ url, outputPath }) => {
      if (url.includes('bad')) throw new Error('site unreachable, "blocked"');
      await writeFile(outputPath, 'png');
      return {
        pngPath: outputPath,
        width: 1280,
        height: 2400,
        capturedAtMs: Date.now(),
        durationMs: 3,
      };
    };

    const running = await runBatch({
      batchId: 'batch-failure',
      dataRoot: root,
      config: baseConfig,
      leads: [
        lead('https://good.example/', 'Good'),
        lead('https://bad.example/', 'Bad'),
      ],
      assets: { circleSourcePath: path.join(root, 'circle.png') },
      capture,
      render: successRender(),
    });

    await collect(running.events);
    const summary = await running.completion;
    const report = await readFile(summary.reportPath, 'utf8');

    expect(summary).toMatchObject({ done: 1, failed: 1 });
    expect(report).toContain('https://good.example/,done,');
    expect(report).toContain('https://bad.example/,failed,,,,"site unreachable, ""blocked"""');
  });

  it('switches the shared DB when dataRoot changes without shutdown', async () => {
    const rootA = await mkdtemp(path.join(tmpdir(), 'loom-engine-root-a-'));
    const rootB = await mkdtemp(path.join(tmpdir(), 'loom-engine-root-b-'));
    try {
      const first = await runBatch({
        batchId: 'root-a-batch',
        dataRoot: rootA,
        config: baseConfig,
        leads: [lead('https://a.example/', 'A')],
        assets: { circleSourcePath: path.join(rootA, 'circle.png') },
        capture: successCapture(),
        render: successRender(),
      });
      await collect(first.events);
      await first.completion;

      const second = await runBatch({
        batchId: 'root-b-batch',
        dataRoot: rootB,
        config: baseConfig,
        leads: [lead('https://b.example/', 'B')],
        assets: { circleSourcePath: path.join(rootB, 'circle.png') },
        capture: successCapture(),
        render: successRender(),
      });
      await collect(second.events);
      await second.completion;
      await shutdownEngine();

      expect(getBatchSnapshot('root-a-batch', { dataRoot: rootA })).not.toBeNull();
      expect(getBatchSnapshot('root-b-batch', { dataRoot: rootB })).not.toBeNull();
      expect(getBatchSnapshot('root-b-batch', { dataRoot: rootA })).toBeNull();
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function lead(website: string, company: string) {
  return {
    rowIndex: 0,
    website,
    csvData: { company },
  };
}

function successCapture(): CaptureFn {
  return async ({ outputPath }) => {
    await writeFile(outputPath, 'png');
    return {
      pngPath: outputPath,
      width: 1280,
      height: 2400,
      capturedAtMs: Date.now(),
      durationMs: 1,
    };
  };
}

function successRender(): RenderFn {
  return async ({ outputPath }) => {
    await writeFile(outputPath, 'mp4');
    return { outputPath, durationMs: 1 };
  };
}
