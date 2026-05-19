import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createDbClient, type DbClient } from '@/db/client';
import type { BatchRecord, LeadRecord } from '@/types';
import { createPaths, type PathHelpers } from './storage';

// Read-only batch state, loaded from SQLite. Useful for:
//   - "Hey I closed the tab, what was the result?" UX (the SSE stream is
//     gone, but the DB is the source of truth).
//   - GET /api/batches and GET /api/batches/[id] handlers that don't need
//     the live event stream.
//   - Tests that want to inspect persisted state without holding a DbClient.
//
// Opens a fresh DB client per call, then closes it. Cheap with SQLite
// (just a file open). Don't use this in tight loops; for high-traffic
// queries reuse a long-lived DbClient via the engine's facade.

export interface BatchSnapshot {
  batch: BatchRecord;
  leads: LeadRecord[];
  // Convenience aggregates so the UI doesn't have to recount.
  counts: {
    total: number;
    pending: number;
    capturing: number;
    rendering: number;
    done: number;
    failed: number;
  };
  // Whether the batch has produced anything downloadable.
  hasOutputs: boolean;
  reportPath: string;
  // Absolute paths for completed leads (useful for the UI's per-lead
  // download buttons).
  outputs: Array<{ leadId: string; path: string }>;
}

export interface SnapshotOptions {
  dataRoot?: string;
  // Inject a pre-built DbClient — tests use this to share an in-memory DB.
  db?: DbClient;
  paths?: PathHelpers;
}

export function getBatchSnapshot(batchId: string, opts: SnapshotOptions = {}): BatchSnapshot | null {
  const paths = opts.paths ?? createPaths({ root: opts.dataRoot });
  // No DB file yet → no batches exist, no snapshot to return.
  if (!opts.db && !existsSync(paths.db())) return null;

  const ownDb = opts.db === undefined;
  const db = opts.db ?? createDbClient({ filename: paths.db() });

  try {
    const batch = db.getBatch(batchId);
    if (!batch) return null;
    const leads = db.getLeads(batchId);

    const counts = {
      total: leads.length,
      pending: 0,
      capturing: 0,
      rendering: 0,
      done: 0,
      failed: 0,
    };
    const outputs: BatchSnapshot['outputs'] = [];

    for (const lead of leads) {
      counts[lead.status] += 1;
      if (lead.status === 'done' && lead.outputPath) {
        outputs.push({ leadId: lead.id, path: lead.outputPath });
      }
    }

    const reportPath = paths.report(batchId);
    return {
      batch,
      leads,
      counts,
      hasOutputs: outputs.length > 0,
      reportPath,
      outputs,
    };
  } finally {
    if (ownDb) db.close();
  }
}

// List the batches we know about (most recent first by created_at).
// Convenience for a "recent batches" UI panel; the implementation is
// trivial (one query) but keeping it on the lib side means the API
// route doesn't have to know SQLite.
export interface BatchListItem {
  id: string;
  name?: string;
  status: BatchRecord['status'];
  total: number;
  done: number;
  failed: number;
  createdAt: number;
  finishedAt?: number;
}

export function listBatches(opts: SnapshotOptions = {}): BatchListItem[] {
  const paths = opts.paths ?? createPaths({ root: opts.dataRoot });
  if (!existsSync(paths.db())) return [];
  // We don't have a direct list-all method on DbClient (intentionally — the
  // orchestrator only writes/reads single batches). Use a short-lived read-only
  // connection for this query so callers do not need to manage another handle.
  try {
    return rawListBatches(paths.db());
  } catch (err) {
    if (isMissingHistorySchemaError(err)) return [];
    throw err;
  }
}

function rawListBatches(dbPath: string): BatchListItem[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        // Aggregate per-status lead counts so the history UI shows
        // "8 of 10 done" without a follow-up query per batch.
        `SELECT b.id, b.name, b.status, b.total, b.created_at, b.finished_at,
                SUM(CASE WHEN l.status = 'done'   THEN 1 ELSE 0 END) AS done_count,
                SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM batches b
         LEFT JOIN leads l ON l.batch_id = b.id
         GROUP BY b.id
         ORDER BY b.created_at DESC`,
      )
      .all() as Array<{
        id: string;
        name: string | null;
        status: BatchRecord['status'];
        total: number;
        created_at: number;
        finished_at: number | null;
        done_count: number | null;
        failed_count: number | null;
      }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? undefined,
      status: r.status,
      total: r.total,
      done: r.done_count ?? 0,
      failed: r.failed_count ?? 0,
      createdAt: r.created_at,
      finishedAt: r.finished_at ?? undefined,
    }));
  } finally {
    db.close();
  }
}

function isMissingHistorySchemaError(err: unknown): boolean {
  return err instanceof Error && /no such table: (batches|leads)/i.test(err.message);
}
