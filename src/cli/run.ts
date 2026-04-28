// Phase 2 batch CLI. Parses a leads CSV, wires the high-level engine facade,
// streams batch events to stdout, and leaves MP4s + report.csv under output/.
//
// Run via:
//   npm run batch -- leads.csv --circle face.mp4 [--audio narration.mp3]

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runBatch, shutdownEngine } from '@/lib/engine';
import { parseLeadsCsvFile } from '@/lib/csv';
import type { BatchConfig, BatchEvent, CirclePosition, CircleSize, Resolution } from '@/types';

interface CliArgs {
  csvPath: string;
  circle: string;
  audio?: string;
  websiteColumn?: string;
  maxLeads: number;
  batchId?: string;
  dataRoot?: string;
  durationSec: number;
  resolution: Resolution;
  circlePosition: CirclePosition;
  circleSize: CircleSize;
  circleMargin: number;
  filenameTemplate: string;
  circleHasAudio?: boolean;
}

function parseCli(argv: string[]): CliArgs {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      circle: { type: 'string' },
      audio: { type: 'string' },
      'website-column': { type: 'string' },
      'max-leads': { type: 'string' },
      'batch-id': { type: 'string' },
      'data-root': { type: 'string' },
      duration: { type: 'string', short: 'd' },
      resolution: { type: 'string', short: 'r' },
      'circle-position': { type: 'string' },
      'circle-size': { type: 'string' },
      'circle-margin': { type: 'string' },
      'circle-has-audio': { type: 'boolean' },
      'filename-template': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const csvPath = positionals[0];
  if (!csvPath) throw new Error('missing leads CSV path (use --help for usage)');

  const circle = required(values.circle, '--circle');
  const durationSec = values.duration ? toPositiveInt(values.duration, '--duration') : 30;
  const maxLeads = values['max-leads'] ? toPositiveInt(values['max-leads'], '--max-leads') : 100;
  const circleMargin = values['circle-margin']
    ? toPositiveInt(values['circle-margin'], '--circle-margin')
    : 40;

  const resolution = (values.resolution ?? '1080p') as Resolution;
  if (resolution !== '720p' && resolution !== '1080p') {
    throw new Error(`--resolution must be 720p or 1080p (got ${String(resolution)})`);
  }

  const circlePosition = (values['circle-position'] ?? 'bottom-right') as CirclePosition;
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(circlePosition)) {
    throw new Error('--circle-position must be one of top-left|top-right|bottom-left|bottom-right');
  }

  const circleSize = (values['circle-size'] ?? 'M') as CircleSize;
  if (!['S', 'M', 'L'].includes(circleSize)) {
    throw new Error('--circle-size must be one of S|M|L');
  }

  return {
    csvPath: path.resolve(csvPath),
    circle: path.resolve(circle),
    audio: values.audio ? path.resolve(values.audio) : undefined,
    websiteColumn: values['website-column'],
    maxLeads,
    batchId: values['batch-id'],
    dataRoot: values['data-root'] ? path.resolve(values['data-root']) : undefined,
    durationSec,
    resolution,
    circlePosition,
    circleSize,
    circleMargin,
    filenameTemplate: values['filename-template'] ?? '{company}.mp4',
    circleHasAudio: values['circle-has-audio'],
  };
}

function required<T>(value: T | undefined, flag: string): T {
  if (value === undefined || value === '') {
    throw new Error(`missing required flag ${flag} (use --help for usage)`);
  }
  return value;
}

function toPositiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${value}")`);
  }
  return n;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`loom-morph batch — CSV batch renderer

Usage:
  npm run batch -- <leads.csv> --circle <path> [--audio <mp3>] [options]

Required:
  <leads.csv>                    CSV with a website/url/domain column
  --circle <path>                circle source (png/jpg/mp4/mov/webm)

Options:
  --audio <path>                 background MP3 narration
  --website-column <name>        explicit CSV column to use as the website
  --filename-template <template> output filename template (default: {company}.mp4)
  --batch-id <id>                stable batch id (default: random UUID)
  --data-root <dir>              storage root (default: current directory)
  --max-leads <n>                cap rows processed (default: 100)
  --duration <seconds>           video length (default: 30)
  --resolution 720p|1080p        output resolution (default: 1080p)
  --circle-position <pos>        top-left|top-right|bottom-left|bottom-right
  --circle-size S|M|L            200/280/360 px (default: M)
  --circle-margin <px>           margin from corner (default: 40)
  --circle-has-audio             force-mark circle as having audio
  --help                         show this message
`);
}

async function ensureFile(filePath: string, label: string): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`${label} not found at ${filePath}`);
  const s = await stat(filePath);
  if (!s.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  await ensureFile(args.csvPath, 'leads CSV');
  await ensureFile(args.circle, '--circle');
  if (args.audio) await ensureFile(args.audio, '--audio');

  const parsed = await parseLeadsCsvFile(args.csvPath, {
    websiteColumn: args.websiteColumn,
    maxLeads: args.maxLeads,
  });

  if (parsed.leads.length === 0) {
    throw new Error(`CSV parsed, but no usable leads were found in column "${parsed.websiteColumn}"`);
  }

  const config: BatchConfig = {
    durationSec: args.durationSec,
    resolution: args.resolution,
    circlePosition: args.circlePosition,
    circleSize: args.circleSize,
    circleMargin: args.circleMargin,
    filenameTemplate: args.filenameTemplate,
  };

  // eslint-disable-next-line no-console
  console.log(
    `[batch] ${parsed.leads.length}/${parsed.totalRows} leads from ${path.basename(args.csvPath)} ` +
      `(website column: ${parsed.websiteColumn})`,
  );
  if (parsed.skipped.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[batch] skipped ${parsed.skipped.length} row(s) with invalid websites`);
  }

  const running = await runBatch({
    batchId: args.batchId,
    dataRoot: args.dataRoot,
    config,
    leads: parsed.leads,
    assets: {
      circleSourcePath: args.circle,
      circleHasAudio: args.circleHasAudio,
      audioPath: args.audio,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`[batch] started ${running.batchId}`);
  for await (const ev of running.events) printEvent(ev);

  const summary = await running.completion;
  // eslint-disable-next-line no-console
  console.log(
    `[batch] complete: ${summary.done} done, ${summary.failed} failed, report ${summary.reportPath}`,
  );
}

function printEvent(ev: BatchEvent): void {
  switch (ev.type) {
    case 'batch-started':
      // eslint-disable-next-line no-console
      console.log(`[batch] queue: ${ev.total} leads`);
      break;
    case 'lead-status':
      // eslint-disable-next-line no-console
      console.log(`[lead ${ev.leadId}] ${ev.status}${ev.error ? ` — ${ev.error}` : ''}`);
      break;
    case 'lead-completed':
      // eslint-disable-next-line no-console
      console.log(`[lead ${ev.leadId}] output ${ev.outputPath}`);
      break;
    case 'batch-completed':
      break;
  }
}

main()
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[batch] error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownEngine();
  });
