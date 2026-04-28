import { getRegisteredBatch } from '@/lib/batch-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(
  _request: Request,
  { params }: { params: { batchId: string } },
) {
  const batch = getRegisteredBatch(params.batchId);
  if (!batch) {
    return new Response('Batch not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          (event.type === 'batch-completed' || event.type === 'batch-error')
        ) {
          close();
        }
      };

      for (const event of batch.events) send(event);

      if (batch.completed) {
        if (batch.error) send({ type: 'batch-error', error: batch.error });
        close();
        return;
      }

      unsubscribe = batch.subscribe(send);
      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
      }, 15_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
