import { Readable } from 'node:stream';
import { getRegisteredBatch } from '@/lib/batch-registry';
import { createPaths } from '@/lib/storage';
import { createBatchZipStream } from '@/lib/zip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  const batch = getRegisteredBatch(params.batchId);
  if (!batch) return new Response('Batch not found', { status: 404 });
  if (!batch.summary) return new Response('Archive not ready', { status: 409 });

  try {
    const { archive, fileCount, reportIncluded } = await createBatchZipStream(
      params.batchId,
      createPaths(),
    );
    const body = Readable.toWeb(archive as unknown as Readable) as ReadableStream<Uint8Array>;
    void archive.finalize().catch((err: unknown) => {
      archive.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${params.batchId}-mp4s.zip"`,
        'X-MP4-Count': String(fileCount),
        'X-Report-Included': String(reportIncluded),
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), {
      status: 500,
    });
  }
}
