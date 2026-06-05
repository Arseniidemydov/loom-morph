import { resolveCompanyName, resolveFirstName } from '@/lib/lead-fields';

// Minimal shape needed to resolve a filename — just the row position and the
// raw CSV columns. Both the in-process orchestrator (LeadRecord) and the
// distributed producer (a freshly-parsed LeadInput) satisfy this.
export interface FilenameLead {
  rowIndex: number;
  csvData: Record<string, string>;
}

// Render an output filename from BatchConfig.filenameTemplate, falling back to
// lead-{i}.mp4. Tokens are CSV column keys; if any required token is missing in
// csvData, fall back rather than emit a literal "{key}" filename.
//
// The `{company}` token is special: it resolves through resolveCompanyName,
// which is case-insensitive and matches common aliases (Company, Account,
// Organization, "Company Name", …). Without that, `{company}.mp4` only
// works on CSVs whose header is literally "company" — which almost no
// real sales CSV uses — and every file silently becomes `lead-1.mp4`.
//
// Lives here (not on the orchestrator) so the distributed producer can compute
// the output filename once, at enqueue time, and freeze it into each LeadJob —
// keeping filename logic in a single place across the in-process and
// queue-backed paths.
export function renderFilename(template: string, lead: FilenameLead): string {
  const fallback = `lead-${lead.rowIndex + 1}.mp4`;
  if (!template) return fallback;
  let resolved = template;
  let missing = false;
  // `[^}]+` (vs `\w+`) so tokens can include spaces — real-world CSV headers
  // like "Company Name" need this.
  resolved = resolved.replace(/\{([^}]+)\}/g, (_match, raw: string) => {
    const key = raw.trim();
    if (key === 'i') return String(lead.rowIndex + 1);
    // Special tokens with smart resolution:
    //   {company}   — company aliases first; falls back to first-name
    //                 aliases. This is the most-used token and the
    //                 fallback chain matches the user's default-template
    //                 intent ("{company} and vibeflow.mp4" should still
    //                 produce a usable name when there's no company).
    //   {firstName} — strictly first-name aliases, no company fallback.
    //                 Lets power users write a template that fails open
    //                 when the CSV has no name columns.
    const lower = key.toLowerCase();
    let value: string | undefined;
    if (lower === 'company') {
      value = resolveCompanyName(lead.csvData) ?? resolveFirstName(lead.csvData);
    } else if (lower === 'firstname' || lower === 'first') {
      value = resolveFirstName(lead.csvData);
    } else {
      value = lead.csvData[key];
    }
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    return safeFilenameSegment(value);
  });
  if (missing) return fallback;
  // Ensure an .mp4 extension.
  if (!/\.mp4$/i.test(resolved)) resolved += '.mp4';
  return resolved;
}

export function safeFilenameSegment(s: string): string {
  // Strip path separators and characters that misbehave on common filesystems.
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'unnamed';
}
