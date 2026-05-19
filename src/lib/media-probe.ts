import { spawn } from 'node:child_process';

// Thin ffprobe wrapper. Returns the container duration in seconds, or null
// when ffprobe is missing, the file is unreadable, or the duration field
// can't be parsed. The engine treats null as "unknown — fall back to config".

export interface ProbeOptions {
  ffprobePath?: string; // default 'ffprobe' on PATH
  timeoutMs?: number;   // default 5_000
}

export async function probeMediaDurationSec(
  filePath: string,
  options: ProbeOptions = {},
): Promise<number | null> {
  const bin = options.ffprobePath ?? 'ffprobe';
  const timeoutMs = options.timeoutMs ?? 5_000;

  return await new Promise<number | null>((resolve) => {
    let settled = false;
    const child = spawn(
      bin,
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=nokey=1:noprint_wrappers=1',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const value = Number.parseFloat(stdout.trim());
      finish(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}
