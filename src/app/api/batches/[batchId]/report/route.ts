import { readFile } from 'node:fs/promises';
import { getRegisteredBatch, type RegisteredBatch } from '@/lib/batch-registry';
import { getBatchSnapshot, type BatchSnapshot } from '@/lib/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  return getReportResponse(params);
}

interface ReportResponseDeps {
  getBatch?: (batchId: string) => RegisteredBatch | undefined;
  getSnapshot?: (batchId: string) => BatchSnapshot | null;
}

export async function getReportResponse(
  params: { batchId: string },
  deps: ReportResponseDeps = {},
): Promise<Response> {
  const resolution = resolveReportPath(params.batchId, {
    getBatch: deps.getBatch ?? getRegisteredBatch,
    getSnapshot: deps.getSnapshot ?? getBatchSnapshot,
  });
  if (resolution.status === 'batch-not-found') {
    return new Response('Batch not found', { status: 404 });
  }
  if (resolution.status === 'report-not-ready') {
    return new Response('Report not ready', { status: 409 });
  }
  if (resolution.status !== 'ready') {
    return new Response('Report not ready', { status: 409 });
  }

  try {
    const report = await readFile(resolution.path);
    return new Response(report, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${params.batchId}-report.csv"`,
      },
    });
  } catch (err) {
    if (isNotFoundError(err)) return new Response('Report not ready', { status: 409 });
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  }
}

type ReportPathResolution =
  | { status: 'ready'; path: string }
  | { status: 'batch-not-found' | 'report-not-ready' };

function resolveReportPath(
  batchId: string,
  deps: Required<ReportResponseDeps>,
): ReportPathResolution {
  const batch = deps.getBatch(batchId);
  if (batch?.summary) return { status: 'ready', path: batch.summary.reportPath };

  const snapshot = deps.getSnapshot(batchId);
  if (!snapshot) {
    return batch ? { status: 'report-not-ready' } : { status: 'batch-not-found' };
  }
  if (snapshot.batch.finishedAt) return { status: 'ready', path: snapshot.reportPath };
  return { status: 'report-not-ready' };
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
