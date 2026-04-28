import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import type { PathHelpers } from './storage';

// Stream a ZIP of a batch's deliverables. The Phase 3 download endpoint
// can pipe the returned Readable straight to a Next.js Response body.
//
// Layout inside the ZIP:
//   <batchId>/<filename>.mp4    (one entry per produced MP4)
//   <batchId>/report.csv        (always — even if no MP4s exist)
//
// Returns the archiver instance directly. Callers should:
//   1. Pipe it to their Response.body (or any Writable).
//   2. `await archive.finalize()` to start the stream.
//   3. Listen to 'error' on the archive to surface failures.
//
// We don't load any MP4 fully into memory; archiver streams each file
// as it's added.

export interface ZipBatchOptions {
  // Whether to include report.csv. Default true.
  includeReport?: boolean;
  // ZIP compression level 0-9. Default 0 — MP4s are already compressed,
  // a CRC-only "store" is faster and the size delta is negligible.
  compressionLevel?: number;
}

export interface BatchZipResult {
  archive: archiver.Archiver;
  fileCount: number;
  reportIncluded: boolean;
}

export async function createBatchZipStream(
  batchId: string,
  paths: PathHelpers,
  opts: ZipBatchOptions = {},
): Promise<BatchZipResult> {
  const outputDir = paths.outputDir(batchId);
  if (!existsSync(outputDir)) {
    throw new Error(`output directory does not exist for batch ${batchId}: ${outputDir}`);
  }

  const archive = archiver('zip', { zlib: { level: opts.compressionLevel ?? 0 } });

  // Discover MP4s. The output dir also contains report.csv; we treat it
  // separately so it always lands at a predictable path inside the zip.
  const entries = await readdir(outputDir);
  const mp4s: string[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    const full = path.join(outputDir, name);
    const s = await stat(full);
    if (s.isFile()) mp4s.push(name);
  }

  for (const name of mp4s) {
    archive.append(createReadStream(path.join(outputDir, name)), {
      name: `${batchId}/${name}`,
    });
  }

  let reportIncluded = false;
  const includeReport = opts.includeReport ?? true;
  if (includeReport) {
    const reportPath = paths.report(batchId);
    if (existsSync(reportPath)) {
      archive.append(createReadStream(reportPath), {
        name: `${batchId}/report.csv`,
      });
      reportIncluded = true;
    }
  }

  return { archive, fileCount: mp4s.length, reportIncluded };
}
