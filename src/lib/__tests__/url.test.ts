import { describe, expect, it } from 'vitest';
import { normalizeWebsite } from '@/lib/url';

describe('normalizeWebsite', () => {
  it('prepends https:// when scheme is missing', () => {
    expect(normalizeWebsite('kargo.ch')).toBe('https://kargo.ch/');
    expect(normalizeWebsite('example.com/team')).toBe('https://example.com/team');
  });

  it('preserves https when already present', () => {
    expect(normalizeWebsite('https://kargo.ch')).toBe('https://kargo.ch/');
  });

  it('preserves http (lowercases host)', () => {
    expect(normalizeWebsite('http://EXAMPLE.com/PATH')).toBe('http://example.com/PATH');
  });

  it('lowercases the host but keeps the path case-sensitive', () => {
    expect(normalizeWebsite('https://Foo.COM/Bar/Baz')).toBe('https://foo.com/Bar/Baz');
  });

  it('strips default port', () => {
    expect(normalizeWebsite('https://example.com:443/x')).toBe('https://example.com/x');
    expect(normalizeWebsite('http://example.com:80/x')).toBe('http://example.com/x');
  });

  it('keeps non-default port', () => {
    expect(normalizeWebsite('http://example.com:8080/x')).toBe('http://example.com:8080/x');
  });

  it('rejects empty / null / undefined', () => {
    expect(normalizeWebsite('')).toBeNull();
    expect(normalizeWebsite(undefined)).toBeNull();
    expect(normalizeWebsite(null)).toBeNull();
    expect(normalizeWebsite('   ')).toBeNull();
  });

  it('rejects placeholder values', () => {
    for (const v of ['n/a', 'na', 'none', 'null', 'undefined', '-', '---']) {
      expect(normalizeWebsite(v)).toBeNull();
    }
  });

  it('rejects strings without a dot in the host', () => {
    expect(normalizeWebsite('localhost')).toBeNull();
    expect(normalizeWebsite('not-a-url')).toBeNull();
  });

  it('strips wrapping whitespace and quotes', () => {
    expect(normalizeWebsite('  "kargo.ch"  ')).toBe('https://kargo.ch/');
    expect(normalizeWebsite("'example.com'")).toBe('https://example.com/');
  });
});
