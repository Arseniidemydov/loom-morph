import path from 'node:path';
import { mkdir } from 'node:fs/promises';

// On-disk layout per INTERFACES.md "Storage layout":
//
//   {root}/uploads/{batchId}/leads.csv | circle.{ext} | audio.mp3
//   {root}/tmp/{batchId}/{leadId}.png         (cleared after batch)
//   {root}/output/{batchId}/{filename}.mp4    (retained)
//   {root}/output/{batchId}/report.csv
//   {root}/data/loom-morph.sqlite
//
// `root` defaults to process.cwd(); override via createPaths({ root }) for
// tests or deployments that pin a different data directory.

export interface PathHelpers {
  root: string;
  upload(batchId: string, name: string): string;
  uploads(batchId: string): string;
  tmp(batchId: string, leadId: string): string;
  tmpDir(batchId: string): string;
  output(batchId: string, filename: string): string;
  outputDir(batchId: string): string;
  report(batchId: string): string;
  db(): string;
}

export function createPaths(opts: { root?: string } = {}): PathHelpers {
  const root = opts.root ?? process.cwd();
  return {
    root,
    upload: (batchId, name) => path.join(root, 'uploads', batchId, name),
    uploads: (batchId) => path.join(root, 'uploads', batchId),
    tmp: (batchId, leadId) => path.join(root, 'tmp', batchId, `${leadId}.png`),
    tmpDir: (batchId) => path.join(root, 'tmp', batchId),
    output: (batchId, filename) => path.join(root, 'output', batchId, filename),
    outputDir: (batchId) => path.join(root, 'output', batchId),
    report: (batchId) => path.join(root, 'output', batchId, 'report.csv'),
    db: () => path.join(root, 'data', 'loom-morph.sqlite'),
  };
}

// Convenience: ensure all per-batch directories exist before any worker writes.
export async function ensureBatchDirs(paths: PathHelpers, batchId: string): Promise<void> {
  await Promise.all([
    mkdir(paths.uploads(batchId), { recursive: true }),
    mkdir(paths.tmpDir(batchId), { recursive: true }),
    mkdir(paths.outputDir(batchId), { recursive: true }),
    mkdir(path.dirname(paths.db()), { recursive: true }),
  ]);
}

// Default singleton — most callers use this. Tests should call createPaths()
// with a tmpdir-rooted instance.
export const pathFor: PathHelpers = createPaths();
