import { readFile } from 'node:fs/promises';
import { getRegisteredBatch } from '@/lib/batch-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  const batch = getRegisteredBatch(params.batchId);
  if (!batch) return new Response('Batch not found', { status: 404 });
  if (!batch.summary) return new Response('Report not ready', { status: 409 });

  const report = await readFile(batch.summary.reportPath);
  return new Response(report, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${params.batchId}-report.csv"`,
    },
  });
}
