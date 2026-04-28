/**
 * Generates the three circle-mask PNGs used by the FFmpeg filter graph (D-007).
 *
 * Output: public/circle-mask-{200,280,360}.png
 *  - Square N x N image, fully transparent OUTSIDE the inscribed circle,
 *    fully opaque white INSIDE.
 *  - Used as the alpha channel via `alphamerge` to crop the circle source
 *    into a circular shape without per-frame alpha math.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// At runtime this file is compiled to scripts/.dist/generate-mask.js, so
// the repo root sits two levels up (.dist → scripts → repo). Resolving via
// `process.cwd()` would be brittle if the script is invoked from elsewhere.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

const SIZES = [200, 280, 360] as const;

async function generateMask(size: number): Promise<string> {
  const outPath = path.join(PUBLIC_DIR, `circle-mask-${size}.png`);
  const radius = size / 2;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/>` +
      `</svg>`,
  );

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: svg, left: 0, top: 0 }])
    .png()
    .toFile(outPath);

  return outPath;
}

async function main(): Promise<void> {
  await mkdir(PUBLIC_DIR, { recursive: true });
  for (const size of SIZES) {
    const out = await generateMask(size);
    // eslint-disable-next-line no-console
    console.log(`wrote ${path.relative(REPO_ROOT, out)}`);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
