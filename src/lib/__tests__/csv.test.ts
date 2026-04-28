import { describe, expect, it } from 'vitest';
import { parseLeadsCsv } from '@/lib/csv';

describe('parseLeadsCsv', () => {
  it('parses a basic CSV with explicit websiteColumn', () => {
    const text = `name,website
Alice,acme.com
Bob,https://northwind.example/path`;
    const result = parseLeadsCsv(text, { websiteColumn: 'website' });
    expect(result.leads).toHaveLength(2);
    expect(result.leads[0]!.website).toBe('https://acme.com/');
    expect(result.leads[0]!.csvData).toEqual({ name: 'Alice', website: 'acme.com' });
    expect(result.leads[1]!.website).toBe('https://northwind.example/path');
    expect(result.skipped).toHaveLength(0);
  });

  it('infers "website" column by exact match', () => {
    const text = `Name,Website,Other
A,acme.com,x`;
    const result = parseLeadsCsv(text);
    expect(result.websiteColumn).toBe('Website');
    expect(result.leads).toHaveLength(1);
  });

  it('infers "Company domain" column (real-world B2B CSV)', () => {
    const text = `First Name,Last Name,Company domain
Fabia,Dellsperger,kargo.ch
John,Doe,example.com`;
    const result = parseLeadsCsv(text);
    expect(result.websiteColumn).toBe('Company domain');
    expect(result.leads).toHaveLength(2);
    expect(result.leads[0]!.website).toBe('https://kargo.ch/');
  });

  it('reports skipped rows with reason', () => {
    const text = `website
kargo.ch
n/a
not-a-url
example.com`;
    const result = parseLeadsCsv(text, { websiteColumn: 'website' });
    expect(result.leads).toHaveLength(2);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toMatchObject({ rowIndex: 1, reason: 'invalid-url', raw: 'n/a' });
    expect(result.skipped[1]).toMatchObject({ rowIndex: 2, raw: 'not-a-url' });
  });

  it('caps at maxLeads (default 3)', () => {
    const lines = ['website'];
    for (let i = 0; i < 250; i++) lines.push(`example${i}.com`);
    const result = parseLeadsCsv(lines.join('\n'));
    expect(result.leads).toHaveLength(3);
    expect(result.totalRows).toBe(250);
  });

  it('respects smaller custom maxLeads', () => {
    const lines = ['website'];
    for (let i = 0; i < 50; i++) lines.push(`example${i}.com`);
    const result = parseLeadsCsv(lines.join('\n'), { maxLeads: 2 });
    expect(result.leads).toHaveLength(2);
  });

  it('does not allow custom maxLeads above the hard cap', () => {
    const lines = ['website'];
    for (let i = 0; i < 50; i++) lines.push(`example${i}.com`);
    const result = parseLeadsCsv(lines.join('\n'), { maxLeads: 5 });
    expect(result.leads).toHaveLength(3);
  });

  it('throws when no website column is inferable', () => {
    const text = `name,age\nAlice,30`;
    expect(() => parseLeadsCsv(text)).toThrow(/website-like column/);
  });

  it('throws when an explicit websiteColumn is missing', () => {
    const text = `name,website\nAlice,acme.com`;
    expect(() => parseLeadsCsv(text, { websiteColumn: 'url' })).toThrow(/not present/);
  });

  it('preserves non-empty csvData for filename templating', () => {
    const text = `Company Name,website,Industry
Kargo,kargo.ch,Marketing
Acme,acme.com,`;
    const result = parseLeadsCsv(text, { websiteColumn: 'website' });
    expect(result.leads[0]!.csvData['Company Name']).toBe('Kargo');
    expect(result.leads[0]!.csvData['Industry']).toBe('Marketing');
    // Empty Industry should be omitted, not stored as ''.
    expect(result.leads[1]!.csvData['Industry']).toBeUndefined();
  });
});
