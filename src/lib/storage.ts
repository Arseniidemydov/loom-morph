// Filesystem path helpers for batches. Workers MUST use these instead of
// hard-coding paths. See INTERFACES.md § "Storage layout".
//
// Planned surface (filled in by Phase 2):
//   pathFor.upload(batchId, name)   → uploads/{batchId}/{name}
//   pathFor.tmp(batchId, leadId)    → tmp/{batchId}/{leadId}.png
//   pathFor.output(batchId, file)   → output/{batchId}/{file}
//   pathFor.report(batchId)         → output/{batchId}/report.csv
//   pathFor.db()                    → data/loom-morph.sqlite

export {};
