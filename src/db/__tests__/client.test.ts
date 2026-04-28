import { describe, expect, it } from 'vitest';
import { createDbClient } from '@/db/client';
import type { BatchInput, LeadRecord } from '@/types';

const baseConfig = {
  durationSec: 30,
  resolution: '1080p' as const,
  circlePosition: 'bottom-right' as const,
  circleSize: 'M' as const,
  circleMargin: 40,
  filenameTemplate: 'lead-{i}.mp4',
};

function makeBatch(): BatchInput {
  return {
    id: 'batch-1',
    config: baseConfig,
    leads: [
      { rowIndex: 0, website: 'https://a.example', csvData: { name: 'A' } },
      { rowIndex: 1, website: 'https://b.example', csvData: { name: 'B' } },
    ],
    circleSourcePath: '/tmp/circle.png',
    circleHasAudio: false,
  };
}

function makeLeadRecord(batchId: string, rowIndex: number, id: string): LeadRecord {
  return {
    id,
    batchId,
    rowIndex,
    website: `https://${id}.example`,
    csvData: { name: id },
    status: 'pending',
  };
}

describe('DbClient', () => {
  it('inserts a batch and reads it back with parsed config', () => {
    const db = createDbClient({ filename: ':memory:', clock: () => 1_000 });
    const batch = makeBatch();
    db.insertBatch(batch);

    const read = db.getBatch('batch-1');
    expect(read).not.toBeNull();
    expect(read!.id).toBe('batch-1');
    expect(read!.status).toBe('pending');
    expect(read!.total).toBe(2);
    expect(read!.createdAt).toBe(1_000);
    expect(read!.config.durationSec).toBe(30);
    expect(read!.finishedAt).toBeUndefined();
    db.close();
  });

  it('inserts leads in a single transaction and orders by row_index on read', () => {
    const db = createDbClient({ filename: ':memory:' });
    const batch = makeBatch();
    db.insertBatch(batch);
    db.insertLeads([
      makeLeadRecord('batch-1', 1, 'lead-b'),
      makeLeadRecord('batch-1', 0, 'lead-a'),
    ]);

    const leads = db.getLeads('batch-1');
    expect(leads.map((l) => l.id)).toEqual(['lead-a', 'lead-b']);
    expect(leads[0]!.csvData).toEqual({ name: 'lead-a' });
    db.close();
  });

  it('handles an empty insertLeads call without throwing', () => {
    const db = createDbClient({ filename: ':memory:' });
    db.insertBatch(makeBatch());
    expect(() => db.insertLeads([])).not.toThrow();
    db.close();
  });

  it('updateLeadStatus persists status + error', () => {
    const db = createDbClient({ filename: ':memory:' });
    db.insertBatch(makeBatch());
    db.insertLeads([makeLeadRecord('batch-1', 0, 'lead-a')]);

    db.updateLeadStatus('lead-a', 'capturing');
    expect(db.getLeads('batch-1')[0]!.status).toBe('capturing');

    db.updateLeadStatus('lead-a', 'failed', 'capture:timeout: too slow');
    const leads = db.getLeads('batch-1');
    expect(leads[0]!.status).toBe('failed');
    expect(leads[0]!.error).toBe('capture:timeout: too slow');
    db.close();
  });

  it('updateLeadResult sets done + paths + timings and clears error', () => {
    const db = createDbClient({ filename: ':memory:' });
    db.insertBatch(makeBatch());
    db.insertLeads([makeLeadRecord('batch-1', 0, 'lead-a')]);
    db.updateLeadStatus('lead-a', 'failed', 'previous run failed');

    db.updateLeadResult('lead-a', '/output/x.mp4', 1234, 5678);

    const lead = db.getLeads('batch-1')[0]!;
    expect(lead.status).toBe('done');
    expect(lead.outputPath).toBe('/output/x.mp4');
    expect(lead.captureMs).toBe(1234);
    expect(lead.renderMs).toBe(5678);
    expect(lead.error).toBeUndefined();
    db.close();
  });

  it('finishBatch stamps status + finished_at', () => {
    let now = 100;
    const db = createDbClient({ filename: ':memory:', clock: () => now });
    db.insertBatch(makeBatch());
    now = 999;
    db.finishBatch('batch-1', 'done');
    const read = db.getBatch('batch-1');
    expect(read!.status).toBe('done');
    expect(read!.finishedAt).toBe(999);
    db.close();
  });

  it('returns null for an unknown batch id', () => {
    const db = createDbClient({ filename: ':memory:' });
    expect(db.getBatch('nope')).toBeNull();
    db.close();
  });
});
