// Phase 1 CLI spike (TASK-005). Wires captureWebsite + render into the
// smallest possible end-to-end harness — one URL, one circle, optional MP3
// → one MP4. No CSV, no orchestrator, no UI.
//
// Run via `npm run spike -- --url ... --circle ...`. The npm script invokes
// `tsx`, which handles TypeScript and the `@/*` path alias.

import { parseArgs } from 'node:util';
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { captureWebsite, shutdownCapturePool } from '@/pipeline/capture';
import { recordWebsite, shutdownRecordPool } from '@/pipeline/record';
import { render } from '@/pipeline/render';
import { CaptureError, RenderError } from '@/types';
import type { BatchConfig, CirclePosition, CircleSize, Resolution, RenderJob } from '@/types';
import { isCircleVideo } from '@/lib/circle-source';

type CaptureMode = 'screenshot' | 'recording';

interface CliArgs {
  url: string;
  circle: string;
  audio?: string;
  output: string;
  durationSec: number;
  resolution: Resolution;
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  circleMargin: number;
  circleHasAudio: boolean;
  mode: CaptureMode;
}

function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      circle: { type: 'string' },
      audio: { type: 'string' },
      output: { type: 'string' },
      duration: { type: 'string', short: 'd' },
      resolution: { type: 'string', short: 'r' },
      'circle-position': { type: 'string' },
      'circle-size': { type: 'string' },
      'circle-margin': { type: 'string' },
      'circle-has-audio': { type: 'boolean' },
      mode: { type: 'string', short: 'm' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const url = required(values.url, '--url');
  const circle = required(values.circle, '--circle');

  const audio = values.audio;
  const output = values.output ?? path.resolve(process.cwd(), 'output', `spike-${Date.now()}.mp4`);
  const durationSec = values.duration ? toInt(values.duration, '--duration') : 30;
  const resolution = (values.resolution ?? '1080p') as Resolution;
  if (resolution !== '720p' && resolution !== '1080p') {
    throw new Error(`--resolution must be 720p or 1080p (got ${String(resolution)})`);
  }
  const circlePosition = (values['circle-position'] ?? 'bottom-right') as CirclePosition;
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(circlePosition)) {
    throw new Error(`--circle-position must be one of top-left|top-right|bottom-left|bottom-right`);
  }
  const circleSize = (values['circle-size'] ?? 'M') as CircleSize;
  if (!['S', 'M', 'L'].includes(circleSize)) {
    throw new Error(`--circle-size must be one of S|M|L`);
  }
  const circleMargin = values['circle-margin'] ? toInt(values['circle-margin'], '--circle-margin') : 40;
  // If --circle-has-audio is unset, infer from the circle file extension:
  // a video container probably has audio, an image definitely doesn't.
  const circleHasAudio = values['circle-has-audio'] ?? isCircleVideo(circle);

  const mode = (values.mode ?? 'screenshot') as CaptureMode;
  if (mode !== 'screenshot' && mode !== 'recording') {
    throw new Error(`--mode must be 'screenshot' or 'recording' (got '${String(values.mode)}')`);
  }

  return {
    url,
    circle,
    audio,
    output,
    durationSec,
    resolution,
    circlePosition,
    circleSize,
    circleMargin,
    circleHasAudio,
    mode,
  };
}

function required<T>(value: T | undefined, flag: string): T {
  if (value === undefined || value === '') {
    throw new Error(`missing required flag ${flag} (use --help for usage)`);
  }
  return value;
}

function toInt(s: string, flag: string): number {
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`${flag} must be a positive integer (got "${s}")`);
  return n;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`loom-morph spike — Phase 1 single-URL renderer

Usage:
  npm run spike -- --url <url> --circle <path> [--audio <mp3>] [options]

Required:
  --url <url>                website URL to capture
  --circle <path>            circle source (png/jpg/mp4/mov/webm)

Optional:
  --audio <path>             background MP3 narration
  --output <path>            output mp4 path (default: ./output/spike-<ts>.mp4)
  --duration <seconds>       video length (default: 30)
  --resolution 720p|1080p    output resolution (default: 1080p)
  --mode, -m <mode>          'screenshot' (default; pans a static PNG) or
                             'recording' (records the live page — use this
                             for sites with hero videos / animations)
  --circle-position <pos>    top-left|top-right|bottom-left|bottom-right (default: bottom-right)
  --circle-size S|M|L        200/280/360 px (default: M)
  --circle-margin <px>       margin from corner (default: 40)
  --circle-has-audio         force-mark circle as having audio (default: inferred from extension)
  --help                     show this message
`);
}

async function ensureFile(p: string, label: string): Promise<void> {
  if (!existsSync(p)) throw new Error(`${label} not found at ${p}`);
  await stat(p);
}

async function run(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  await ensureFile(args.circle, '--circle');
  if (args.audio) await ensureFile(args.audio, '--audio');

  const tmpRoot = path.join(tmpdir(), `loom-morph-spike-${randomUUID()}`);
  await mkdir(tmpRoot, { recursive: true });
  await mkdir(path.dirname(args.output), { recursive: true });

  const config: BatchConfig = {
    durationSec: args.durationSec,
    resolution: args.resolution,
    circlePosition: args.circlePosition,
    circleSize: args.circleSize,
    circleMargin: args.circleMargin,
    filenameTemplate: '',
  };

  let backgroundPath: string;
  let backgroundHeight: number;
  let backgroundKind: 'image' | 'video';

  if (args.mode === 'recording') {
    backgroundPath = path.join(tmpRoot, 'page.webm');
    backgroundKind = 'video';
    // eslint-disable-next-line no-console
    console.log(`[spike] recording (mode=recording) ${args.url} for ${args.durationSec}s → ${backgroundPath}`);
    const rec = await recordWebsite({
      url: args.url,
      outputPath: backgroundPath,
      durationSec: args.durationSec,
    });
    backgroundHeight = rec.height;
    // eslint-disable-next-line no-console
    console.log(`[spike] recorded: ${rec.width}×${rec.height}, ${rec.durationSec}s, in ${rec.durationMs} ms wall`);
  } else {
    backgroundPath = path.join(tmpRoot, 'shot.png');
    backgroundKind = 'image';
    // eslint-disable-next-line no-console
    console.log(`[spike] capturing (mode=screenshot) ${args.url} → ${backgroundPath}`);
    const capture = await captureWebsite({ url: args.url, outputPath: backgroundPath });
    backgroundHeight = capture.height;
    // eslint-disable-next-line no-console
    console.log(`[spike] captured: ${capture.width}×${capture.height} in ${capture.durationMs} ms`);
  }

  const job: RenderJob = {
    screenshotPath: backgroundPath,
    screenshotHeight: backgroundHeight,
    circleSourcePath: args.circle,
    circleHasAudio: args.circleHasAudio,
    audioPath: args.audio,
    outputPath: args.output,
    config,
    backgroundKind,
  };

  // eslint-disable-next-line no-console
  console.log(`[spike] rendering → ${args.output}`);
  const result = await render(job);
  // eslint-disable-next-line no-console
  console.log(`[spike] done: ${result.outputPath} (render ${result.durationMs} ms)`);
}

run()
  .catch((err: unknown) => {
    if (err instanceof CaptureError) {
      // eslint-disable-next-line no-console
      console.error(`[spike] capture failed: ${err.reason}: ${err.message}`);
    } else if (err instanceof RenderError) {
      // eslint-disable-next-line no-console
      console.error(`[spike] render failed: ${err.reason}: ${err.message}`);
      if (err.stderrTail) {
        // eslint-disable-next-line no-console
        console.error('[spike] ffmpeg stderr (last 50 lines):');
        // eslint-disable-next-line no-console
        console.error(err.stderrTail);
      }
    } else if (err instanceof Error) {
      // eslint-disable-next-line no-console
      console.error(`[spike] error: ${err.message}`);
    } else {
      // eslint-disable-next-line no-console
      console.error('[spike] unknown error', err);
    }
    process.exit(1);
  })
  .finally(async () => {
    await shutdownCapturePool();
    await shutdownRecordPool();
  });
