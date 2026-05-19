import Database from 'better-sqlite3';
import type {
  BatchConfig,
  BatchInput,
  BatchRecord,
  LeadRecord,
  LeadStatus,
} from '@/types';
import { ensureSchema } from './migrations';

// Thin synchronous wrapper around better-sqlite3 implementing the DbClient
// contract from INTERFACES.md. better-sqlite3 is single-threaded and
// synchronous, so callers from concurrent worker pools are serialized at the
// driver level — no extra locking needed for v1.
export interface DbClient {
  insertBatch(batch: BatchInput): void;
  insertLeads(leads: LeadRecord[]): void;
  updateLeadStatus(leadId: string, status: LeadStatus, error?: string): void;
  updateLeadResult(
    leadId: string,
    output: string,
    captureMs: number,
    renderMs: number,
  ): void;
  finishBatch(batchId: string, status: 'done' | 'failed'): void;
  getBatch(batchId: string): BatchRecord | null;
  getLeads(batchId: string): LeadRecord[];
  /** Newest first. */
  listBatches(): BatchRecord[];
  setBatchName(batchId: string, name: string): boolean;
  clearLeadOutput(batchId: string, leadId: string, error?: string): LeadRecord | null;
  deleteBatch(batchId: string): boolean;
  close(): void;
}

interface BatchRow {
  id: string;
  status: BatchRecord['status'];
  config_json: string;
  total: number;
  created_at: number;
  finished_at: number | null;
  name: string | null;
}

interface LeadRow {
  id: string;
  batch_id: string;
  row_index: number;
  website: string;
  csv_data_json: string;
  status: LeadStatus;
  error: string | null;
  output_path: string | null;
  capture_ms: number | null;
  render_ms: number | null;
}

export interface CreateDbClientOptions {
  filename: string; // ':memory:' for tests
  clock?: () => number;
}

export function createDbClient(opts: CreateDbClientOptions): DbClient {
  const db = new Database(opts.filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);

  const clock = opts.clock ?? (() => Date.now());

  const stmts = {
    insertBatch: db.prepare(
      `INSERT INTO batches (id, status, config_json, total, created_at, finished_at, name)
       VALUES (@id, @status, @config_json, @total, @created_at, NULL, @name)`,
    ),
    insertLead: db.prepare(
      `INSERT INTO leads (id, batch_id, row_index, website, csv_data_json, status,
                          error, output_path, capture_ms, render_ms)
       VALUES (@id, @batch_id, @row_index, @website, @csv_data_json, @status,
               @error, @output_path, @capture_ms, @render_ms)`,
    ),
    updateLeadStatus: db.prepare(
      `UPDATE leads SET status = @status, error = @error WHERE id = @id`,
    ),
    updateLeadResult: db.prepare(
      `UPDATE leads
       SET status = 'done', output_path = @output_path,
           capture_ms = @capture_ms, render_ms = @render_ms, error = NULL
       WHERE id = @id`,
    ),
    finishBatch: db.prepare(
      `UPDATE batches SET status = @status, finished_at = @finished_at WHERE id = @id`,
    ),
    selectBatch: db.prepare(`SELECT * FROM batches WHERE id = ?`),
    selectAllBatches: db.prepare(
      `SELECT * FROM batches ORDER BY created_at DESC`,
    ),
    setBatchName: db.prepare(`UPDATE batches SET name = @name WHERE id = @id`),
    selectLeads: db.prepare(
      `SELECT * FROM leads WHERE batch_id = ? ORDER BY row_index ASC`,
    ),
    selectLead: db.prepare(
      `SELECT * FROM leads WHERE batch_id = ? AND id = ?`,
    ),
    clearLeadOutput: db.prepare(
      `UPDATE leads
       SET status = 'failed', error = @error, output_path = NULL
       WHERE batch_id = @batch_id AND id = @id`,
    ),
    deleteLeadsForBatch: db.prepare(`DELETE FROM leads WHERE batch_id = ?`),
    deleteBatch: db.prepare(`DELETE FROM batches WHERE id = ?`),
  };

  const insertLeadsTx = db.transaction((leads: LeadRecord[]) => {
    for (const lead of leads) stmts.insertLead.run(toLeadRow(lead));
  });
  const deleteBatchTx = db.transaction((batchId: string) => {
    stmts.deleteLeadsForBatch.run(batchId);
    return stmts.deleteBatch.run(batchId).changes > 0;
  });

  return {
    insertBatch(batch) {
      stmts.insertBatch.run({
        id: batch.id,
        status: 'pending',
        config_json: JSON.stringify(batch.config),
        total: batch.leads.length,
        created_at: clock(),
        name: batch.name ?? null,
      });
    },
    insertLeads(leads) {
      if (leads.length === 0) return;
      insertLeadsTx(leads);
    },
    updateLeadStatus(leadId, status, error) {
      stmts.updateLeadStatus.run({ id: leadId, status, error: error ?? null });
    },
    updateLeadResult(leadId, output, captureMs, renderMs) {
      stmts.updateLeadResult.run({
        id: leadId,
        output_path: output,
        capture_ms: captureMs,
        render_ms: renderMs,
      });
    },
    finishBatch(batchId, status) {
      stmts.finishBatch.run({ id: batchId, status, finished_at: clock() });
    },
    getBatch(batchId) {
      const row = stmts.selectBatch.get(batchId) as BatchRow | undefined;
      if (!row) return null;
      return fromBatchRow(row);
    },
    getLeads(batchId) {
      const rows = stmts.selectLeads.all(batchId) as LeadRow[];
      return rows.map(fromLeadRow);
    },
    listBatches() {
      const rows = stmts.selectAllBatches.all() as BatchRow[];
      return rows.map(fromBatchRow);
    },
    setBatchName(batchId, name) {
      const trimmed = name.trim();
      if (trimmed.length === 0) return false;
      const result = stmts.setBatchName.run({ id: batchId, name: trimmed });
      return result.changes > 0;
    },
    clearLeadOutput(batchId, leadId, error) {
      stmts.clearLeadOutput.run({
        batch_id: batchId,
        id: leadId,
        error: error ?? 'Video deleted',
      });
      const row = stmts.selectLead.get(batchId, leadId) as LeadRow | undefined;
      return row ? fromLeadRow(row) : null;
    },
    deleteBatch(batchId) {
      return deleteBatchTx(batchId);
    },
    close() {
      db.close();
    },
  };
}

function fromBatchRow(row: BatchRow): BatchRecord {
  const config = JSON.parse(row.config_json) as BatchConfig;
  return {
    id: row.id,
    name: row.name ?? undefined,
    status: row.status,
    config,
    total: row.total,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function toLeadRow(lead: LeadRecord): Record<string, unknown> {
  return {
    id: lead.id,
    batch_id: lead.batchId,
    row_index: lead.rowIndex,
    website: lead.website,
    csv_data_json: JSON.stringify(lead.csvData),
    status: lead.status,
    error: lead.error ?? null,
    output_path: lead.outputPath ?? null,
    capture_ms: lead.captureMs ?? null,
    render_ms: lead.renderMs ?? null,
  };
}

function fromLeadRow(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    rowIndex: row.row_index,
    website: row.website,
    csvData: JSON.parse(row.csv_data_json) as Record<string, string>,
    status: row.status,
    error: row.error ?? undefined,
    outputPath: row.output_path ?? undefined,
    captureMs: row.capture_ms ?? undefined,
    renderMs: row.render_ms ?? undefined,
  };
}
