// Copy dev test assets from `test_assets/` (free-form, user-provided, may
// contain subdirectories) into `public/test-assets/` with the canonical
// names the workbench UI expects. Both folders are gitignored — this is a
// dev convenience, not source.
//
// Looks for: a CSV, an MP3, an image (png/jpg), and a video (mp4/mov/webm).
// First match in each category wins. Subdirectories are searched too — drop
// a circle video inside `test_assets/some-folder/` and it'll still get
// staged. Missing categories are simply skipped; the UI falls back.
//
// Run with: npm run stage:test-assets

import { mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(REPO_ROOT, 'test_assets');
const TARGET_DIR = path.join(REPO_ROOT, 'public', 'test-assets');

const TARGETS: Array<{ name: string; match: (file: string) => boolean }> = [
  { name: 'leads.csv',     match: (f) => f.toLowerCase().endsWith('.csv') },
  { name: 'narration.mp3', match: (f) => f.toLowerCase().endsWith('.mp3') },
  { name: 'circle.png',    match: (f) => /\.(png|jpe?g)$/i.test(f) },
  { name: 'circle.mp4',    match: (f) => /\.(mp4|mov|webm|mkv)$/i.test(f) },
];

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const entries = await readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_DIR)) {
    // eslint-disable-next-line no-console
    console.error(`source directory not found: ${SOURCE_DIR}`);
    // eslint-disable-next-line no-console
    console.error(
      `Drop a CSV, an MP3, an image (PNG/JPG), and/or a video (MP4/MOV/WEBM) into ${SOURCE_DIR} and re-run.`,
    );
    process.exit(1);
  }

  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });

  const files = await listFilesRecursive(SOURCE_DIR);
  let copied = 0;
  for (const target of TARGETS) {
    const source = files.find((f) => target.match(path.basename(f)));
    if (!source) {
      // eslint-disable-next-line no-console
      console.warn(`no match for ${target.name} in ${path.relative(REPO_ROOT, SOURCE_DIR)}`);
      continue;
    }
    const to = path.join(TARGET_DIR, target.name);
    await copyFile(source, to);
    // eslint-disable-next-line no-console
    console.log(`${path.relative(REPO_ROOT, source)} → ${path.relative(REPO_ROOT, to)}`);
    copied += 1;
  }

  if (copied === 0) {
    // eslint-disable-next-line no-console
    console.error('no assets matched; nothing staged.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
