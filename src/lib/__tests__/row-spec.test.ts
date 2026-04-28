import { describe, expect, it } from 'vitest';
import { parseRowSpec } from '@/lib/row-spec';

describe('parseRowSpec', () => {
  it('matches a single row by 1-based index', () => {
    const spec = parseRowSpec('5');
    expect(spec.matches(4)).toBe(true);
    expect(spec.matches(3)).toBe(false);
    expect(spec.matches(5)).toBe(false);
  });

  it('matches a range inclusive on both ends', () => {
    const spec = parseRowSpec('2-4');
    expect([0, 1, 2, 3, 4, 5].map((i) => spec.matches(i))).toEqual([
      false, true, true, true, false, false,
    ]);
  });

  it('matches a comma-separated mix of singles and ranges', () => {
    const spec = parseRowSpec('1,3-5,8');
    const got = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => spec.matches(i));
    expect(got).toEqual([true, false, true, true, true, false, false, true]);
  });

  it('normalizes reversed ranges', () => {
    const spec = parseRowSpec('5-2');
    expect(spec.matches(0)).toBe(false);
    expect(spec.matches(1)).toBe(true);
    expect(spec.matches(4)).toBe(true);
    expect(spec.matches(5)).toBe(false);
  });

  it('tolerates whitespace inside tokens and around commas', () => {
    const spec = parseRowSpec('  1 ,  3 - 5 , 8 ');
    expect(spec.matches(0)).toBe(true);
    expect(spec.matches(2)).toBe(true);
    expect(spec.matches(7)).toBe(true);
  });

  it('rejects empty input', () => {
    expect(() => parseRowSpec('')).toThrow(/empty/);
    expect(() => parseRowSpec('   ')).toThrow(/empty/);
  });

  it('rejects 0-indexed or non-numeric tokens', () => {
    expect(() => parseRowSpec('0')).toThrow(/1-based/);
    expect(() => parseRowSpec('1,abc')).toThrow(/bad row token/);
    expect(() => parseRowSpec('1.5')).toThrow(/bad row token/);
    expect(() => parseRowSpec('-3')).toThrow(/bad row token/);
  });

  it('description preserves the user-facing tokens for log output', () => {
    expect(parseRowSpec('1, 3-5, 8').description).toBe('1, 3-5, 8'.split(',').map((t) => t.trim()).join(','));
  });
});
