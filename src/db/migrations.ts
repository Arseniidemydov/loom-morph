import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Single-step "ensure schema" runner. v1 has no real migrations — every
// statement in schema.sql is `IF NOT EXISTS`, so calling this on every
// startup is safe and cheap. If we ever need versioned migrations, add a
// `meta(version)` table and bump from here.
export function ensureSchema(db: Database.Database): void {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
}
