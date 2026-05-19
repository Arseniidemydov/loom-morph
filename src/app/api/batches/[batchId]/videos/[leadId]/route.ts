import { createReadStream } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createDbClient } from '@/db/client';
import { getRegisteredBatch } from '@/lib/batch-registry';
import { formatReportCsv } from '@/lib/report';
import { createPaths } from '@/lib/storage';
import { getBatchSnapshot, type BatchSnapshot } from '@/lib/snapshot';
import type { RegisteredBatch } from '@/lib/batch-registry';
import type { PathHelpers } from '@/lib/storage';
import type { BatchEvent, LeadRecord } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { batchId: string; leadId: string } },
) {
  return getVideoResponse(request, params);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { batchId: string; leadId: string } },
) {
  return deleteVideoResponse(params);
}

interface VideoResponseDeps {
  paths?: PathHelpers;
  getBatch?: (batchId: string) => RegisteredBatch | undefined;
  getSnapshot?: (batchId: string) => BatchSnapshot | null;
}

export async function getVideoResponse(
  request: Request,
  params: { batchId: string; leadId: string },
  deps: VideoResponseDeps = {},
): Promise<Response> {
  const paths = deps.paths ?? createPaths();
  const resolution = resolveVideoPath(params.batchId, params.leadId, {
    getBatch: deps.getBatch ?? getRegisteredBatch,
    getSnapshot: deps.getSnapshot ?? ((batchId) => getBatchSnapshot(batchId, { paths })),
  });
  if (resolution.status === 'batch-not-found') {
    return new Response('Batch not found', { status: 404 });
  }
  if (resolution.status === 'video-not-ready') {
    return new Response('Video not ready', { status: 409 });
  }
  if (resolution.status === 'video-not-found') {
    return new Response('Video not found', { status: 404 });
  }
  if (resolution.status !== 'ready') {
    return new Response('Video not found', { status: 404 });
  }

  const outputDir = path.resolve(paths.outputDir(params.batchId));
  const videoPath = path.resolve(resolution.path);
  if (!isInsideDir(videoPath, outputDir) || path.extname(videoPath).toLowerCase() !== '.mp4') {
    return new Response('Video not found', { status: 404 });
  }

  try {
    const file = await stat(videoPath);
    if (!file.isFile()) return new Response('Video not found', { status: 404 });

    const range = request.headers.get('range');
    if (range) return rangedResponse(videoPath, file.size, range);

    const body = Readable.toWeb(createReadStream(videoPath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(file.size),
        'Content-Type': 'video/mp4',
      },
    });
  } catch (err) {
    if (isNotFoundError(err)) return new Response('Video not found', { status: 404 });
    return new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
    });
  }
}

interface DeleteVideoResponseDeps {
  paths?: PathHelpers;
  getBatch?: (batchId: string) => RegisteredBatch | undefined;
  getSnapshot?: (batchId: string) => BatchSnapshot | null;
}

export async function deleteVideoResponse(
  params: { batchId: string; leadId: string },
  deps: DeleteVideoResponseDeps = {},
): Promise<Response> {
  const paths = deps.paths ?? createPaths();
  const batch = (deps.getBatch ?? getRegisteredBatch)(params.batchId);
  if (batch && !batch.completed) {
    return Response.json(
      { error: 'Batch is still running. Wait for it to finish before deleting videos.' },
      { status: 409 },
    );
  }

  const snapshot = (deps.getSnapshot ?? ((batchId) => getBatchSnapshot(batchId, { paths })))(
    params.batchId,
  );
  if (!snapshot) return Response.json({ error: 'Batch not found' }, { status: 404 });

  const lead = snapshot.leads.find((candidate) => candidate.id === params.leadId);
  if (!lead) return Response.json({ error: 'Lead not found' }, { status: 404 });
  if (!lead.outputPath) {
    return Response.json({ error: 'Lead has no rendered video' }, { status: 409 });
  }

  const outputDir = path.resolve(paths.outputDir(params.batchId));
  const videoPath = path.resolve(lead.outputPath);
  if (!isInsideDir(videoPath, outputDir) || path.extname(videoPath).toLowerCase() !== '.mp4') {
    return Response.json({ error: 'Video not found' }, { status: 404 });
  }

  await rm(videoPath, { force: true });

  const db = createDbClient({ filename: paths.db() });
  try {
    const updated = db.clearLeadOutput(params.batchId, params.leadId);
    if (!updated) return Response.json({ error: 'Lead not found' }, { status: 404 });
    await writeFile(paths.report(params.batchId), formatReportCsv(db.getLeads(params.batchId)), 'utf8');
    return Response.json({
      batchId: params.batchId,
      leadId: params.leadId,
      deleted: true,
      lead: toLeadPreview(updated),
    });
  } finally {
    db.close();
  }
}

type VideoPathResolution =
  | { status: 'ready'; path: string }
  | { status: 'batch-not-found' | 'video-not-ready' | 'video-not-found' };

function resolveVideoPath(
  batchId: string,
  leadId: string,
  deps: Required<Pick<VideoResponseDeps, 'getBatch' | 'getSnapshot'>>,
): VideoPathResolution {
  const batch = deps.getBatch(batchId);
  const event = batch?.events.find(
    (candidate): candidate is Extract<BatchEvent, { type: 'lead-completed' }> =>
      candidate.type === 'lead-completed' && candidate.leadId === leadId,
  );
  if (event) return { status: 'ready', path: event.outputPath };

  const snapshot = deps.getSnapshot(batchId);
  if (!snapshot) {
    return batch ? { status: 'video-not-ready' } : { status: 'batch-not-found' };
  }

  const lead = snapshot.leads.find((candidate) => candidate.id === leadId);
  if (!lead) return { status: 'video-not-found' };
  if (lead.status === 'done' && lead.outputPath) {
    return { status: 'ready', path: lead.outputPath };
  }
  return { status: 'video-not-ready' };
}

function rangedResponse(videoPath: string, fileSize: number, range: string): Response {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return new Response('Invalid range', {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }

  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  let start = startText === '' ? 0 : Number.parseInt(startText, 10);
  let end = endText === '' ? fileSize - 1 : Number.parseInt(endText, 10);

  if (startText === '' && endText !== '') {
    const suffixLength = Number.parseInt(endText, 10);
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    });
  }

  end = Math.min(end, fileSize - 1);
  const body = Readable.toWeb(createReadStream(videoPath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Type': 'video/mp4',
    },
  });
}

function isInsideDir(filePath: string, dirPath: string): boolean {
  const relative = path.relative(dirPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function toLeadPreview(lead: LeadRecord) {
  return {
    id: lead.id,
    rowIndex: lead.rowIndex,
    website: lead.website,
    company: leadCompany(lead),
    status: lead.status,
    progress: lead.status === 'done' || lead.status === 'failed' ? 100 : 0,
    outputPath: lead.outputPath,
    error: lead.error,
  };
}

function leadCompany(lead: LeadRecord): string {
  const exact = lead.csvData.company ?? lead.csvData.Company;
  if (exact) return exact;

  const hit = Object.entries(lead.csvData).find(([key, value]) => {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return value && ['company', 'companyname', 'account', 'organization', 'name'].includes(compact);
  });
  return hit?.[1] || `Lead ${lead.rowIndex + 1}`;
}
