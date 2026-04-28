import path from 'node:path';

// Single source of truth for "is this circle a video?" extension lookup.
// Used by:
//   - src/lib/engine.ts to default `circleHasAudio` when the caller doesn't
//     set it explicitly.
//   - src/app/api/batches/route.ts to decide whether to default
//     circleHasAudio=true for an uploaded file.
//   - src/components/batch-workbench.tsx (via the API response or its own
//     extension check) to swap the preview between <img> and <video>.
//
// Extending the set here updates every consumer at once.

export const VIDEO_CIRCLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
]);

export const IMAGE_CIRCLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

export type CircleKind = 'image' | 'video' | 'unknown';

function ext(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isCircleVideo(filePath: string): boolean {
  return VIDEO_CIRCLE_EXTENSIONS.has(ext(filePath));
}

export function isCircleImage(filePath: string): boolean {
  return IMAGE_CIRCLE_EXTENSIONS.has(ext(filePath));
}

export function classifyCircle(filePath: string): CircleKind {
  const e = ext(filePath);
  if (VIDEO_CIRCLE_EXTENSIONS.has(e)) return 'video';
  if (IMAGE_CIRCLE_EXTENSIONS.has(e)) return 'image';
  return 'unknown';
}

// Convenience: the "default" circleHasAudio value when the caller doesn't
// set it explicitly. Image circles never have audio; video circles default
// to having audio (silent talking-head videos exist, but they're the
// minority — let the caller override).
export function inferCircleHasAudio(filePath: string): boolean {
  return isCircleVideo(filePath);
}
