import { Readable } from 'node:stream';
import { getRegisteredBatch, type RegisteredBatch } from '@/lib/batch-registry';
import { getBatchSnapshot, type BatchSnapshot } from '@/lib/snapshot';
import { createPaths, type PathHelpers } from '@/lib/storage';
import { createBatchZipStream } from '@/lib/zip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  return getArchiveResponse(params);
}

interface ArchiveResponseDeps {
  paths?: PathHelpers;
  getBatch?: (batchId: string) => RegisteredBatch | undefined;
  getSnapshot?: (batchId: string) => BatchSnapshot | null;
}

export async function getArchiveResponse(
  params: { batchId: string },
  deps: ArchiveResponseDeps = {},
): Promise<Response> {
  const paths = deps.paths ?? createPaths();
  const readiness = resolveArchiveReadiness(params.batchId, {
    getBatch: deps.getBatch ?? getRegisteredBatch,
    getSnapshot: deps.getSnapshot ?? ((batchId) => getBatchSnapshot(batchId, { paths })),
  });
  if (readiness.status === 'batch-not-found') {
    return new Response('Batch not found', { status: 404 });
  }
  if (readiness.status === 'archive-not-ready') {
    return new Response('Archive not ready', { status: 409 });
  }

  try {
    const { archive, fileCount, reportIncluded } = await createBatchZipStream(
      params.batchId,
      paths,
    );
    const body = Readable.toWeb(archive as unknown as Readable) as ReadableStream<Uint8Array>;
    void archive.finalize().catch((err: unknown) => {
      archive.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${params.batchId}-videos.zip"`,
        'X-MP4-Count': String(fileCount),
        'X-Report-Included': String(reportIncluded),
      },
    });
  } catch (err) {
    if (err instanceof Error && /output directory does not exist/.test(err.message)) {
      return new Response('Archive not ready', { status: 409 });
    }
    return new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
    });
  }
}

type ArchiveReadiness =
  | { status: 'ready' }
  | { status: 'batch-not-found' | 'archive-not-ready' };

function resolveArchiveReadiness(
  batchId: string,
  deps: Required<Pick<ArchiveResponseDeps, 'getBatch' | 'getSnapshot'>>,
): ArchiveReadiness {
  const batch = deps.getBatch(batchId);
  if (batch?.summary) return { status: 'ready' };

  const snapshot = deps.getSnapshot(batchId);
  if (!snapshot) {
    return batch ? { status: 'archive-not-ready' } : { status: 'batch-not-found' };
  }
  return snapshot.batch.finishedAt ? { status: 'ready' } : { status: 'archive-not-ready' };
}
