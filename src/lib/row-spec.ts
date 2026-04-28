// Parse a CLI-style row selector into a predicate over 0-based row indexes.
// Spec syntax — comma-separated tokens, each is one of:
//   - a single 1-based integer: "5"  → matches row index 4
//   - a range "N-M":             "1-3" → matches indexes 0,1,2
//   - mixed:                     "1,3-5,8"
//
// Whitespace is tolerated; reversed ranges (5-1) are normalized.
//
// Returns a predicate: rowIndex (0-based) → boolean. Designed to be applied
// after CSV parsing so it works against `LeadInput.rowIndex`.

export interface RowSpec {
  matches(rowIndex0: number): boolean;
  // For diagnostics / logging.
  description: string;
}

const TOKEN = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/;

export function parseRowSpec(spec: string): RowSpec {
  if (!spec || spec.trim() === '') {
    throw new Error('row spec cannot be empty');
  }
  const tokens = spec.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) throw new Error(`row spec produced no tokens: "${spec}"`);

  const ranges: Array<{ lo: number; hi: number }> = [];
  for (const token of tokens) {
    const m = TOKEN.exec(token);
    if (!m) throw new Error(`bad row token "${token}" (expected N or N-M, 1-based)`);
    const a = Number.parseInt(m[1]!, 10);
    const b = m[2] !== undefined ? Number.parseInt(m[2]!, 10) : a;
    if (a < 1 || b < 1) throw new Error(`row tokens are 1-based; got "${token}"`);
    const lo = Math.min(a, b) - 1; // → 0-based
    const hi = Math.max(a, b) - 1;
    ranges.push({ lo, hi });
  }

  return {
    matches(rowIndex0) {
      for (const r of ranges) {
        if (rowIndex0 >= r.lo && rowIndex0 <= r.hi) return true;
      }
      return false;
    },
    description: tokens.join(','),
  };
}
