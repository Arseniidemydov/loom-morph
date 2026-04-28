import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RenderError, type RenderFn, type RenderJob, type RenderResult } from '@/types';
import { buildFfmpegArgs } from './filter-graph';

// Render worker. Spawns one ffmpeg process per job; resolves with the output
// path and elapsed milliseconds. Rejects with RenderError on non-zero exit,
// preserving the last 50 lines of stderr for the failure report (PLAN.md).
//
// No fluent-ffmpeg / no intermediate files. The single -filter_complex from
// buildFilterGraph does the whole job (D-006). Concurrency is owned by the
// caller (the orchestrator's render pool).

export interface RenderOptions {
  ffmpegPath?: string;          // override binary, default 'ffmpeg' on PATH
  maskDir?: string;             // override mask root, default <repo>/public
  killOnTimeoutMs?: number;     // optional hard timeout per render
  onStderrLine?: (line: string) => void; // for live progress logging
}

const STDERR_TAIL = 50;

export function createRender(options: RenderOptions = {}): RenderFn {
  const ffmpegBin = options.ffmpegPath ?? 'ffmpeg';

  return async function render(job: RenderJob): Promise<RenderResult> {
    await mkdir(path.dirname(job.outputPath), { recursive: true });

    const args = buildFfmpegArgs(job, { maskDir: options.maskDir });
    const start = Date.now();

    return await new Promise<RenderResult>((resolve, reject) => {
      const child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

      const tail: string[] = [];
      let stderrBuf = '';
      let timer: NodeJS.Timeout | undefined;

      if (options.killOnTimeoutMs && options.killOnTimeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new RenderError('timeout', `ffmpeg exceeded ${options.killOnTimeoutMs} ms`, tail.join('\n')));
        }, options.killOnTimeoutMs);
      }

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          tail.push(line);
          if (tail.length > STDERR_TAIL) tail.shift();
          options.onStderrLine?.(line);
        }
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new RenderError('ffmpeg-error', `failed to spawn ffmpeg: ${err.message}`, tail.join('\n')));
      });

      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        if (signal === 'SIGKILL') return; // already rejected by timeout path
        if (stderrBuf.length > 0) {
          tail.push(stderrBuf);
          if (tail.length > STDERR_TAIL) tail.shift();
        }
        if (code === 0) {
          resolve({ outputPath: job.outputPath, durationMs: Date.now() - start });
        } else {
          reject(new RenderError('ffmpeg-error', `ffmpeg exited with code ${code}`, tail.join('\n')));
        }
      });
    });
  };
}

// Default render fn using ffmpeg from PATH and the bundled mask directory.
// The orchestrator typically wires this up itself; tests may use createRender()
// to inject a custom maskDir.
export const render: RenderFn = createRender();
