// Copy dev test assets from `test_assets/` (free-form, user-provided) into
// `public/test-assets/` with the canonical names the workbench UI expects.
// Both folders are gitignored — this is a dev convenience, not source.
//
// Looks for: a CSV (any *.csv), an MP3 (any *.mp3), and an image (any
// *.png|*.jpg|*.jpeg). The first match in each category wins. If a category
// has no match, that filename is left out — the UI falls back gracefully.
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
];

async function main(): Promise<void> {
  if (!existsSync(SOURCE_DIR)) {
    // eslint-disable-next-line no-console
    console.error(`source directory not found: ${SOURCE_DIR}`);
    // eslint-disable-next-line no-console
    console.error(`Drop a CSV, an MP3, and a PNG/JPG into ${SOURCE_DIR} and re-run.`);
    process.exit(1);
  }

  await rm(TARGET_DIR, { recursive: true, force: true });
  await mkdir(TARGET_DIR, { recursive: true });

  const entries = (await readdir(SOURCE_DIR)).filter((f) => !f.startsWith('.'));
  let copied = 0;
  for (const target of TARGETS) {
    const source = entries.find(target.match);
    if (!source) {
      // eslint-disable-next-line no-console
      console.warn(`no match for ${target.name} in ${SOURCE_DIR}`);
      continue;
    }
    const from = path.join(SOURCE_DIR, source);
    const to = path.join(TARGET_DIR, target.name);
    await copyFile(from, to);
    // eslint-disable-next-line no-console
    console.log(`${path.relative(REPO_ROOT, from)} → ${path.relative(REPO_ROOT, to)}`);
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
