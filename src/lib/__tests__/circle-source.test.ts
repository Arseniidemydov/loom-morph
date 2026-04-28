import { describe, expect, it } from 'vitest';
import {
  IMAGE_CIRCLE_EXTENSIONS,
  VIDEO_CIRCLE_EXTENSIONS,
  classifyCircle,
  inferCircleHasAudio,
  isCircleImage,
  isCircleVideo,
} from '@/lib/circle-source';

describe('circle-source extension predicates', () => {
  it('isCircleVideo matches all canonical video extensions', () => {
    for (const ext of VIDEO_CIRCLE_EXTENSIONS) {
      expect(isCircleVideo(`/tmp/face${ext}`)).toBe(true);
    }
  });

  it('isCircleVideo is false for image extensions, audio, and unknown', () => {
    expect(isCircleVideo('/tmp/face.png')).toBe(false);
    expect(isCircleVideo('/tmp/face.jpg')).toBe(false);
    expect(isCircleVideo('/tmp/narration.mp3')).toBe(false);
    expect(isCircleVideo('/tmp/unknown')).toBe(false);
    expect(isCircleVideo('/tmp/file.txt')).toBe(false);
  });

  it('isCircleVideo is case-insensitive on the extension', () => {
    expect(isCircleVideo('/tmp/face.MP4')).toBe(true);
    expect(isCircleVideo('/tmp/face.MoV')).toBe(true);
  });

  it('isCircleImage matches all canonical image extensions', () => {
    for (const ext of IMAGE_CIRCLE_EXTENSIONS) {
      expect(isCircleImage(`/tmp/face${ext}`)).toBe(true);
    }
  });

  it('classifyCircle returns the right kind', () => {
    expect(classifyCircle('/tmp/x.mp4')).toBe('video');
    expect(classifyCircle('/tmp/x.png')).toBe('image');
    expect(classifyCircle('/tmp/x.svg')).toBe('unknown');
    expect(classifyCircle('/tmp/no-extension')).toBe('unknown');
  });

  it('inferCircleHasAudio mirrors isCircleVideo (videos default to audio, images do not)', () => {
    expect(inferCircleHasAudio('/tmp/face.mp4')).toBe(true);
    expect(inferCircleHasAudio('/tmp/face.mov')).toBe(true);
    expect(inferCircleHasAudio('/tmp/face.png')).toBe(false);
    expect(inferCircleHasAudio('/tmp/face.webp')).toBe(false);
  });
});
