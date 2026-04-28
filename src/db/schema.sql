-- Loom Morph SQLite schema. Source of truth for persistent batch/lead state.
-- Mirrors INTERFACES.md § "SQLite schema". Apply via migrations.ts (idempotent).

CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL,                -- pending | running | done | failed
  config_json TEXT NOT NULL,                -- BatchConfig serialized
  total       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  row_index     INTEGER NOT NULL,
  website       TEXT NOT NULL,
  csv_data_json TEXT NOT NULL,              -- Record<string,string>
  status        TEXT NOT NULL,
  error         TEXT,
  output_path   TEXT,
  capture_ms    INTEGER,
  render_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_leads_batch ON leads(batch_id);
