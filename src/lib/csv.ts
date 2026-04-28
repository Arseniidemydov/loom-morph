// CSV parsing & lead normalization. Implementation lands with Phase 2.
// Contract: parse with papaparse, validate `website`/`url` column,
// normalize to a `website` field, prepend https:// when missing scheme,
// reject obviously invalid rows. See PLAN.md § "CSV ingestion".

export {};
