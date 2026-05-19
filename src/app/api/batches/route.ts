import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import {
  IMAGE_CIRCLE_EXTENSIONS,
  VIDEO_CIRCLE_EXTENSIONS,
} from '@/lib/circle-source';
import { MAX_BATCH_LEADS, parseLeadsCsv } from '@/lib/csv';
import { runBatch } from '@/lib/engine';
import { listBatches } from '@/lib/snapshot';
import { registerRunningBatch } from '@/lib/batch-registry';
import { createPaths, ensureBatchDirs } from '@/lib/storage';
import type {
  BatchConfig,
  CaptureMode,
  CirclePosition,
  CircleSize,
  RecordingScrollMode,
  Resolution,
} from '@/types';

export const runtime = 'nodejs';

// Allowed circle upload extensions = canonical image ∪ video sets. Single
// source of truth lives in src/lib/circle-source.ts.
const IMAGE_OR_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  ...IMAGE_CIRCLE_EXTENSIONS,
  ...VIDEO_CIRCLE_EXTENSIONS,
]);

// History view feed — newest first, with per-batch lead aggregates so the
// UI can show "8/10 done" without an extra round-trip per row.
export function GET() {
  const items = listBatches();
  return NextResponse.json({
    batches: items.map((b) => ({
      batchId: b.id,
      name: b.name,
      status: b.status,
      total: b.total,
      done: b.done,
      failed: b.failed,
      createdAt: b.createdAt,
      finishedAt: b.finishedAt,
      reportUrl: `/api/batches/${b.id}/report`,
      archiveUrl: `/api/batches/${b.id}/archive`,
      eventsUrl: `/api/batches/${b.id}/events`,
    })),
  });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const csvFile = requireFile(form, 'csv');
    const circleFile = requireFile(form, 'circle');
    const audioFile = optionalFile(form, 'audio');
    const batchId = randomUUID();
    const paths = createPaths();
    await ensureBatchDirs(paths, batchId);

    const csvText = await csvFile.text();
    const csvPath = paths.upload(batchId, 'leads.csv');
    await writeFile(csvPath, csvText, 'utf8');

    const circlePath = paths.upload(
      batchId,
      `circle${extensionFor(circleFile.name, IMAGE_OR_VIDEO_EXTENSIONS, '.bin')}`,
    );
    await writeFile(circlePath, Buffer.from(await circleFile.arrayBuffer()));

    let audioPath: string | undefined;
    if (audioFile) {
      audioPath = paths.upload(batchId, 'audio.mp3');
      await writeFile(audioPath, Buffer.from(await audioFile.arrayBuffer()));
    }

    const parsed = parseLeadsCsv(csvText, {
      websiteColumn: stringField(form, 'websiteColumn') || undefined,
      maxLeads: clampNumber(numberField(form, 'maxLeads', MAX_BATCH_LEADS), 1, MAX_BATCH_LEADS),
    });
    if (parsed.leads.length === 0) {
      return NextResponse.json(
        { error: `No usable leads found in "${parsed.websiteColumn}"` },
        { status: 400 },
      );
    }

    const config: BatchConfig = {
      durationSec: clampNumber(numberField(form, 'durationSec', 30), 1, 300),
      resolution: enumField<Resolution>(form, 'resolution', ['720p', '1080p'], '1080p'),
      circlePosition: enumField<CirclePosition>(
        form,
        'circlePosition',
        ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        'bottom-left',
      ),
      circleSize: enumField<CircleSize>(form, 'circleSize', ['S', 'M', 'L'], 'M'),
      circleMargin: clampNumber(numberField(form, 'circleMargin', 40), 0, 400),
      circleCropScale: clampNumber(numberField(form, 'circleCropScale', 1), 1, 2.5),
      circleCropX: clampNumber(numberField(form, 'circleCropX', 0), -100, 100),
      circleCropY: clampNumber(numberField(form, 'circleCropY', 0), -100, 100),
      captureMode: enumField<CaptureMode>(form, 'captureMode', ['screenshot', 'recording'], 'recording'),
      recordingScrollMode: enumField<RecordingScrollMode>(
        form,
        'recordingScrollMode',
        ['auto', 'pan', 'static'],
        'auto',
      ),
      smoothMotion: booleanField(form, 'smoothMotion') ?? false,
      filenameTemplate: stringField(form, 'filenameTemplate') || '{company} and vibeflow.mp4',
    };

    const running = await runBatch({
      batchId,
      name: stringField(form, 'name') || undefined,
      config,
      leads: parsed.leads,
      assets: {
        circleSourcePath: circlePath,
        circleHasAudio: booleanField(form, 'circleHasAudio'),
        audioPath,
      },
    });
    registerRunningBatch(running);

    return NextResponse.json({
      batchId,
      total: parsed.leads.length,
      skipped: parsed.skipped.length,
      websiteColumn: parsed.websiteColumn,
      eventsUrl: `/api/batches/${batchId}/events`,
      reportUrl: `/api/batches/${batchId}/report`,
      archiveUrl: `/api/batches/${batchId}/archive`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

function requireFile(form: FormData, name: string): File {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`missing ${name} file`);
  }
  return value;
}

function optionalFile(form: FormData, name: string): File | undefined {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) return undefined;
  return value;
}

function stringField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function numberField(form: FormData, name: string, fallback: number): number {
  const raw = stringField(form, name);
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function booleanField(form: FormData, name: string): boolean | undefined {
  const value = stringField(form, name).toLowerCase();
  if (value === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return undefined;
}

function enumField<T extends string>(
  form: FormData,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = stringField(form, name);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function extensionFor(name: string, allowed: ReadonlySet<string>, fallback: string): string {
  const ext = path.extname(name).toLowerCase();
  return allowed.has(ext) ? ext : fallback;
}
