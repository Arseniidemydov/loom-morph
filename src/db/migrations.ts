import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Single-step "ensure schema" runner. schema.sql uses `IF NOT EXISTS` for
// fresh databases; for existing ones we run a small set of additive
// `ALTER TABLE ADD COLUMN` patches whose target column may already exist.
// Each patch is idempotent — checked against PRAGMA table_info — so calling
// ensureSchema on every startup stays safe and cheap.
export function ensureSchema(db: Database.Database): void {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  ensureColumn(db, 'batches', 'name', 'TEXT');
}

function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
