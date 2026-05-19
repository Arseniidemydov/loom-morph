import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createDbClient } from '@/db/client';
import { getRegisteredBatch, removeRegisteredBatch } from '@/lib/batch-registry';
import { resolveCompanyName } from '@/lib/lead-fields';
import { getBatchSnapshot } from '@/lib/snapshot';
import type { BatchSnapshot } from '@/lib/snapshot';
import { createPaths } from '@/lib/storage';
import type { PathHelpers } from '@/lib/storage';
import type { LeadRecord } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  return getBatchResponse(params);
}

// Rename a batch. Body: { name: string }. Empty/whitespace names are
// rejected so the history list never shows a blank row.
export async function PATCH(
  request: Request,
  { params }: { params: { batchId: string } },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const name = typeof (body as { name?: unknown })?.name === 'string'
    ? ((body as { name: string }).name as string)
    : '';
  if (name.trim().length === 0) {
    return Response.json({ error: 'name must be a non-empty string' }, { status: 400 });
  }

  const paths = createPaths();
  if (!existsSync(paths.db())) {
    return Response.json({ error: 'Batch not found' }, { status: 404 });
  }
  const db = createDbClient({ filename: paths.db() });
  try {
    const ok = db.setBatchName(params.batchId, name);
    if (!ok) return Response.json({ error: 'Batch not found' }, { status: 404 });
    const updated = db.getBatch(params.batchId);
    return Response.json({ batchId: params.batchId, name: updated?.name });
  } finally {
    db.close();
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  return deleteBatchResponse(params);
}

interface BatchResponseDeps {
  getSnapshot?: (batchId: string) => BatchSnapshot | null;
}

export function getBatchResponse(
  params: { batchId: string },
  deps: BatchResponseDeps = {},
) {
  const snapshot = (deps.getSnapshot ?? getBatchSnapshot)(params.batchId);
  if (!snapshot) return Response.json({ error: 'Batch not found' }, { status: 404 });

  return Response.json({
    batchId: snapshot.batch.id,
    name: snapshot.batch.name,
    status: snapshot.batch.status,
    total: snapshot.batch.total,
    counts: snapshot.counts,
    createdAt: snapshot.batch.createdAt,
    finishedAt: snapshot.batch.finishedAt,
    reportUrl: `/api/batches/${snapshot.batch.id}/report`,
    archiveUrl: `/api/batches/${snapshot.batch.id}/archive`,
    eventsUrl: `/api/batches/${snapshot.batch.id}/events`,
    leads: snapshot.leads.map(toLeadPreview),
  });
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
  return resolveCompanyName(lead.csvData) ?? `Lead ${lead.rowIndex + 1}`;
}

interface DeleteBatchResponseDeps {
  paths?: PathHelpers;
  getSnapshot?: (batchId: string) => BatchSnapshot | null;
  getRegistered?: typeof getRegisteredBatch;
  removeRegistered?: typeof removeRegisteredBatch;
}

export async function deleteBatchResponse(
  params: { batchId: string },
  deps: DeleteBatchResponseDeps = {},
): Promise<Response> {
  const paths = deps.paths ?? createPaths();
  const registered = (deps.getRegistered ?? getRegisteredBatch)(params.batchId);
  if (registered && !registered.completed) {
    return Response.json(
      { error: 'Batch is still running. Wait for it to finish before deleting.' },
      { status: 409 },
    );
  }

  const snapshot = (deps.getSnapshot ?? ((batchId) => getBatchSnapshot(batchId, { paths })))(
    params.batchId,
  );
  if (!snapshot) return Response.json({ error: 'Batch not found' }, { status: 404 });

  const db = createDbClient({ filename: paths.db() });
  try {
    const deleted = db.deleteBatch(params.batchId);
    if (!deleted) return Response.json({ error: 'Batch not found' }, { status: 404 });
  } finally {
    db.close();
  }

  await Promise.all([
    rm(paths.uploads(params.batchId), { recursive: true, force: true }),
    rm(paths.tmpDir(params.batchId), { recursive: true, force: true }),
    rm(paths.outputDir(params.batchId), { recursive: true, force: true }),
  ]);
  (deps.removeRegistered ?? removeRegisteredBatch)(params.batchId);
  return Response.json({ batchId: params.batchId, deleted: true });
}
