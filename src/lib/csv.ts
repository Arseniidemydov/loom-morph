import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import type { LeadInput } from '@/types';
import { normalizeWebsite } from './url';

// Parse a CSV of leads into LeadInput[]. The contract:
//
//   - `header: true`, BOM-stripped, header keys preserved as-is (so callers
//     can reference original column names in filename templates).
//   - `websiteColumn` selects which column carries the URL/domain. If
//     omitted, infer by exact match on common names.
//   - Rows where the website cannot be normalized are dropped from the
//     output AND reported in `skipped` so the caller can surface a count.
//   - Hard cap at `maxLeads` (default 100, per PLAN.md "100 leads/batch").
//   - All other CSV columns ride along on `csvData` for filename templating.

export interface ParseLeadsOptions {
  websiteColumn?: string;
  maxLeads?: number;
}

export interface ParseLeadsResult {
  leads: LeadInput[];
  skipped: Array<{ rowIndex: number; reason: string; raw: string }>;
  websiteColumn: string;
  columns: string[];
  totalRows: number;
}

const WEBSITE_HEADER_CANDIDATES = [
  'website',
  'url',
  'website url',
  'site',
  'domain',
  'company website',
  'company domain',
];

const DEFAULT_MAX_LEADS = 100;

export async function parseLeadsCsvFile(
  filePath: string,
  opts: ParseLeadsOptions = {},
): Promise<ParseLeadsResult> {
  const text = await readFile(filePath, 'utf8');
  return parseLeadsCsv(text, opts);
}

export function parseLeadsCsv(text: string, opts: ParseLeadsOptions = {}): ParseLeadsResult {
  const max = opts.maxLeads ?? DEFAULT_MAX_LEADS;

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
    transform: (v) => (typeof v === 'string' ? v.trim() : v),
  });

  const columns = (parsed.meta.fields ?? []).filter((c): c is string => typeof c === 'string' && c.length > 0);
  const websiteColumn = opts.websiteColumn ?? inferWebsiteColumn(columns);
  if (!websiteColumn) {
    throw new Error(
      `CSV has no website-like column. Saw columns: [${columns.join(', ')}]. ` +
        `Pass websiteColumn explicitly or rename one of yours to "website" / "url" / "Company domain".`,
    );
  }
  if (!columns.includes(websiteColumn)) {
    throw new Error(`websiteColumn "${websiteColumn}" not present in CSV. Saw: [${columns.join(', ')}]`);
  }

  const leads: LeadInput[] = [];
  const skipped: ParseLeadsResult['skipped'] = [];
  const rows = parsed.data;

  for (let i = 0; i < rows.length; i++) {
    if (leads.length >= max) break;
    const row = rows[i] ?? {};
    const raw = row[websiteColumn] ?? '';
    const normalized = normalizeWebsite(raw);
    if (!normalized) {
      skipped.push({ rowIndex: i, reason: 'invalid-url', raw });
      continue;
    }
    // Pass through every non-empty column as csvData. Empty strings dropped
    // so filename templates fall back rather than producing "{key}".
    const csvData: Record<string, string> = {};
    for (const col of columns) {
      const v = row[col];
      if (v && typeof v === 'string') csvData[col] = v;
    }
    leads.push({ rowIndex: i, website: normalized, csvData });
  }

  return {
    leads,
    skipped,
    websiteColumn,
    columns,
    totalRows: rows.length,
  };
}

function inferWebsiteColumn(columns: string[]): string | undefined {
  // Try exact match first (case-insensitive, alnum-collapsed).
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const compactCols = columns.map((c) => ({ original: c, key: compact(c) }));
  for (const candidate of WEBSITE_HEADER_CANDIDATES) {
    const target = compact(candidate);
    const hit = compactCols.find((c) => c.key === target);
    if (hit) return hit.original;
  }
  // Fallback: any column whose compact form contains "website" or "domain".
  const fuzzy = compactCols.find((c) => c.key.includes('website') || c.key.includes('domain') || c.key.includes('url'));
  return fuzzy?.original;
}
