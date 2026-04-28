import { describe, expect, it } from 'vitest';
import { buildFilterGraph, buildFfmpegArgs } from '@/pipeline/filter-graph';
import type { RenderConfig, RenderJob } from '@/types';

const base: RenderConfig = {
  screenshotHeight: 4000,
  durationSec: 30,
  resolution: '1080p',
  circlePosition: 'bottom-right',
  circleSize: 'M',
  circleMargin: 40,
  circleHasAudio: false,
  audioMp3Present: false,
};

describe('buildFilterGraph', () => {
  it('30s 1080p bottom-right, no audio (silent)', () => {
    const g = buildFilterGraph(base);
    expect(g.filterComplex).toMatchInlineSnapshot(
      `"[0:v]crop=1920:1080:0:(4000-1080)*(t/30)*(t/30)*(3-2*(t/30)),scale=1920:1080,setsar=1,fps=30[bg];[1:v]scale=280:280:force_original_aspect_ratio=increase,crop=280:280[c_raw];[c_raw][2:v]alphamerge[circle];[bg][circle]overlay=1600:760:shortest=0[v]"`,
    );
    expect(g.videoMap).toBe('[v]');
    expect(g.audioMap).toBeUndefined();
  });

  it('60s 720p top-left, circle audio + mp3 (amix)', () => {
    const g = buildFilterGraph({
      ...base,
      durationSec: 60,
      resolution: '720p',
      circlePosition: 'top-left',
      circleSize: 'S',
      circleHasAudio: true,
      audioMp3Present: true,
    });
    expect(g.filterComplex).toMatchInlineSnapshot(
      `"[0:v]crop=1280:720:0:(4000-720)*(t/60)*(t/60)*(3-2*(t/60)),scale=1280:720,setsar=1,fps=30[bg];[1:v]scale=200:200:force_original_aspect_ratio=increase,crop=200:200[c_raw];[c_raw][2:v]alphamerge[circle];[bg][circle]overlay=40:40:shortest=0[v];[1:a][3:a]amix=inputs=2:duration=first:dropout_transition=0[a]"`,
    );
    expect(g.audioMap).toBe('[a]');
  });

  it('circle audio only (no mp3) → anull on circle stream', () => {
    const g = buildFilterGraph({ ...base, circleHasAudio: true, audioMp3Present: false });
    expect(g.filterComplex).toContain('[1:a]anull[a]');
    expect(g.audioMap).toBe('[a]');
  });

  it('mp3 only (image circle) → anull on mp3 stream', () => {
    const g = buildFilterGraph({ ...base, circleHasAudio: false, audioMp3Present: true });
    expect(g.filterComplex).toContain('[3:a]anull[a]');
    expect(g.audioMap).toBe('[a]');
  });

  it('overlay coords for all four corners (1080p, M=280, margin=40)', () => {
    const corners = (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map(
      (circlePosition) => buildFilterGraph({ ...base, circlePosition }).filterComplex,
    );
    expect(corners[0]).toContain('overlay=40:40:');
    expect(corners[1]).toContain('overlay=1600:40:');
    expect(corners[2]).toContain('overlay=40:760:');
    expect(corners[3]).toContain('overlay=1600:760:');
  });

  it('large circle (L=360) shifts right/bottom corners by the size delta', () => {
    const g = buildFilterGraph({ ...base, circleSize: 'L', circlePosition: 'bottom-right' });
    // 1920 - 360 - 40 = 1520; 1080 - 360 - 40 = 680
    expect(g.filterComplex).toContain('overlay=1520:680:');
  });
});

describe('buildFfmpegArgs', () => {
  const baseJob: RenderJob = {
    screenshotPath: '/tmp/shot.png',
    screenshotHeight: 4000,
    circleSourcePath: '/tmp/circle.png',
    circleHasAudio: false,
    outputPath: '/output/out.mp4',
    config: {
      durationSec: 30,
      resolution: '1080p',
      circlePosition: 'bottom-right',
      circleSize: 'M',
      circleMargin: 40,
      filenameTemplate: '',
    },
  };

  it('silent render: -an, no -c:a, three inputs, mask path injected', () => {
    const args = buildFfmpegArgs(baseJob, { maskDir: '/masks' });
    // Three -i flags (screenshot, circle, mask), no fourth.
    const inputCount = args.filter((a) => a === '-i').length;
    expect(inputCount).toBe(3);
    expect(args).toContain('/masks/circle-mask-280.png');
    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('with mp3: four inputs, -c:a aac present, audio map [a]', () => {
    const args = buildFfmpegArgs({ ...baseJob, audioPath: '/tmp/narration.mp3' }, { maskDir: '/masks' });
    expect(args.filter((a) => a === '-i').length).toBe(4);
    expect(args).toContain('/tmp/narration.mp3');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    const mapIdx = args.indexOf('-map', args.indexOf('-map') + 1);
    expect(args[mapIdx + 1]).toBe('[a]');
    expect(args).not.toContain('-an');
  });

  it('always emits +faststart and the configured duration', () => {
    const args = buildFfmpegArgs({ ...baseJob, config: { ...baseJob.config, durationSec: 45 } }, { maskDir: '/masks' });
    expect(args).toContain('+faststart');
    expect(args).toContain('45');
  });

  it('output path is the last argv element', () => {
    const args = buildFfmpegArgs(baseJob, { maskDir: '/masks' });
    expect(args.at(-1)).toBe('/output/out.mp4');
  });
});
