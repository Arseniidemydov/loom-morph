// Shared helpers for pulling well-known "fields" out of a lead's csvData
// regardless of how the source spreadsheet capitalized / spaced / underscored
// its column headers. Used by:
//   - The orchestrator's filenameTemplate resolver, so `{company}` works on
//     `Company`, `Company Name`, `Account`, etc.
//   - The batch GET API, so the workbench shows a real company name in the
//     leads list even when the CSV header doesn't match `company` exactly.

const COMPANY_HEADER_ALIASES: ReadonlySet<string> = new Set([
  'company',
  'companyname',
  'account',
  'accountname',
  'organization',
  'organisation',
  'name',
]);

function compactHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function resolveCompanyName(csvData: Record<string, string>): string | undefined {
  // Fast-path the two common spellings before scanning every column.
  const direct = csvData.company ?? csvData.Company;
  if (direct && direct.trim()) return direct.trim();

  for (const [key, raw] of Object.entries(csvData)) {
    const value = raw?.trim();
    if (!value) continue;
    if (COMPANY_HEADER_ALIASES.has(compactHeader(key))) return value;
  }
  return undefined;
}

const FIRST_NAME_HEADER_ALIASES: ReadonlySet<string> = new Set([
  'firstname',
  'first',
  'givenname',
  'forename',
  'fname',
  // "name" by itself is ambiguous (could mean full name or company name)
  // but in CSVs without an explicit `firstname` column it's usually the
  // person's name; resolveCompanyName already claims this alias first,
  // so falling through to first-name here is the safe order.
]);

export function resolveFirstName(csvData: Record<string, string>): string | undefined {
  const direct = csvData.firstName ?? csvData.FirstName ?? csvData.first_name;
  if (direct && direct.trim()) return splitFirstName(direct.trim());

  for (const [key, raw] of Object.entries(csvData)) {
    const value = raw?.trim();
    if (!value) continue;
    if (FIRST_NAME_HEADER_ALIASES.has(compactHeader(key))) return splitFirstName(value);
  }
  return undefined;
}

// "Anna Schmidt" → "Anna". For CSVs that store a single "name" column
// rather than separate first/last.
function splitFirstName(value: string): string {
  const parts = value.split(/\s+/).filter(Boolean);
  return parts[0] ?? value;
}
