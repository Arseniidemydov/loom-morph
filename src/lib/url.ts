// URL normalization for CSV-imported lead websites.
//
// Inputs in the wild: "kargo.ch", "https://kargo.ch", "www.kargo.ch/team",
// "  Kargo.ch  ", "kargo.ch/?ref=..." — all should resolve to a clean
// absolute https URL. Obvious garbage ("not a url", "n/a", empty) → null.
//
// Heuristics:
//   - Lowercase the host, trim whitespace.
//   - Prepend `https://` if there's no scheme.
//   - Reject if the host has no dot (e.g. "localhost" without a port — leads
//     in B2B CSVs always have a TLD).
//   - Reject if URL parsing throws after the prepend.

const STRIP_LEADING = /^[\s"']+|[\s"']+$/g;

export function normalizeWebsite(input: string | undefined | null): string | null {
  if (!input) return null;
  const trimmed = input.replace(STRIP_LEADING, '');
  if (trimmed === '') return null;
  if (/^(n\/?a|none|null|undefined|-+)$/i.test(trimmed)) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  // Host must look like a real domain (contains a dot, has TLD-ish suffix).
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.')) return null;
  if (host.endsWith('.')) return null;

  // Lowercase the host but preserve the path/query as-is (case-sensitive).
  parsed.hostname = host;
  // Strip default ports for cleanliness.
  if ((parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }

  return parsed.toString();
}
