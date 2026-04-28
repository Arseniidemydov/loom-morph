import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('batch CLI — argument parsing', () => {
  it('--help exits 0 and prints usage', () => {
    const r = spawnSync('npm', ['run', '--silent', 'batch', '--', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('loom-morph batch');
    expect(r.stdout).toContain('--website-column');
  });

  it('exits non-zero with a clear error when the CSV path is missing', () => {
    const r = spawnSync('npm', ['run', '--silent', 'batch', '--', '--circle', 'face.png'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('missing leads CSV path');
  });

  it('exits non-zero with a clear error when --circle is missing', () => {
    const r = spawnSync('npm', ['run', '--silent', 'batch', '--', 'leads.csv'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('--circle');
  });
});
