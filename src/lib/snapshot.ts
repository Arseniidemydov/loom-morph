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
  status: BatchRecord['status'];
  total: number;
  createdAt: number;
  finishedAt?: number;
}

export function listBatches(opts: SnapshotOptions = {}): BatchListItem[] {
  const paths = opts.paths ?? createPaths({ root: opts.dataRoot });
  if (!existsSync(paths.db())) return [];
  const ownDb = opts.db === undefined;
  const db = opts.db ?? createDbClient({ filename: paths.db() });
  try {
    // We don't have a direct list-all method on DbClient (intentionally —
    // the orchestrator only writes/reads single batches). Reach into the
    // raw better-sqlite3 instance via the same client by exposing its
    // .getBatch loop is wasteful. Instead, use the underlying file directly
    // for the list query.
    //
    // Pragmatic: re-read the DB through a minimal raw query. Until DbClient
    // grows a listBatches method, this is fine.
    return rawListBatches(paths.db());
  } finally {
    // ownDb is unused above (we never opened db here), but keep the symmetry
    // so future implementations can swap to db-method without changing
    // calling code.
    if (ownDb && opts.db) opts.db.close();
  }
}

function rawListBatches(dbPath: string): BatchListItem[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, status, total, created_at, finished_at
         FROM batches
         ORDER BY created_at DESC`,
      )
      .all() as Array<{ id: string; status: BatchRecord['status']; total: number; created_at: number; finished_at: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      total: r.total,
      createdAt: r.created_at,
      finishedAt: r.finished_at ?? undefined,
    }));
  } finally {
    db.close();
  }
}
