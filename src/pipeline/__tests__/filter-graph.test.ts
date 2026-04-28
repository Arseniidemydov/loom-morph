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
  it('30s 1080p bottom-right, no audio (silent) — pre-scales then crops, pan in (ih-H) space', () => {
    const g = buildFilterGraph(base);
    expect(g.filterComplex).toMatchInlineSnapshot(
      `"[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:if(lt(t\\\,2.1)\\\,0\\\,if(lt(t\\\,8.1)\\\,0+((ih-1080)*0.2296)*((t-2.1)/6)*((t-2.1)/6)*(3-2*((t-2.1)/6))\\\,if(lt(t\\\,13.3)\\\,(ih-1080)*0.2296\\\,if(lt(t\\\,23.2)\\\,(ih-1080)*0.2296+((ih-1080)*0.1571)*((t-13.3)/9.9)*((t-13.3)/9.9)*(3-2*((t-13.3)/9.9))\\\,if(lt(t\\\,29.4)\\\,(ih-1080)*0.3867\\\,if(lt(t\\\,30)\\\,(ih-1080)*0.3867+((ih-1080)*0.0898)*((t-29.4)/0.6)*((t-29.4)/0.6)*(3-2*((t-29.4)/0.6))\\\,(ih-1080)*0.4765)))))),setsar=1,fps=30[bg];[1:v]scale=280:280:force_original_aspect_ratio=increase,crop=280:280[c_raw];[c_raw][2:v]alphamerge[circle];[bg][circle]overlay=1600:760:shortest=0[v]"`,
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
      `"[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720:(iw-1280)/2:if(lt(t\\\,1.8)\\\,0\\\,if(lt(t\\\,22.2)\\\,0+((ih-720)*0.3952)*((t-1.8)/20.4)*((t-1.8)/20.4)*(3-2*((t-1.8)/20.4))\\\,if(lt(t\\\,38)\\\,(ih-720)*0.3952\\\,if(lt(t\\\,60)\\\,(ih-720)*0.3952+((ih-720)*0.1042)*((t-38)/22)*((t-38)/22)*(3-2*((t-38)/22))\\\,(ih-720)*0.4994)))),setsar=1,fps=30[bg];[1:v]scale=200:200:force_original_aspect_ratio=increase,crop=200:200[c_raw];[c_raw][2:v]alphamerge[circle];[bg][circle]overlay=40:40:shortest=0[v];[1:a][3:a]amix=inputs=2:duration=first:dropout_transition=0[a]"`,
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

  // ─── 1080p output works for narrow / short captures ─────────────────────────
  // The capture worker often returns a 1280×800 PNG (viewport size on a short
  // page). The filter graph must scale that up so a 1920×1080 crop is valid.
  // Without the pre-scale this case used to error out with "crop input width
  // less than crop width", which is why the UI was pinned to 720p.

  it('emits a pre-scale step ahead of the crop (so 1280-wide captures fit 1080p)', () => {
    const g = buildFilterGraph({ ...base, screenshotHeight: 800 });
    // Pre-scale, THEN crop. force_original_aspect_ratio=increase → both
    // iw≥W and ih≥H, so crop=W:H:... always has the space it needs.
    expect(g.filterComplex).toMatch(
      /\[0:v\]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:/,
    );
  });

  it('horizontally centers the crop so wider captures do not lose left content', () => {
    const g = buildFilterGraph({ ...base, screenshotHeight: 800 });
    expect(g.filterComplex).toContain('crop=1920:1080:(iw-1920)/2:');
  });

  it('pan expression scales with `ih` instead of using absolute pixels', () => {
    // The filter must NOT bake in absolute pixel offsets like "1391" — those
    // are wrong as soon as the screenshot is scaled. Every pan magnitude must
    // be a fraction of (ih - viewportHeight) computed at runtime.
    const g = buildFilterGraph({ ...base, screenshotHeight: 800 });
    expect(g.filterComplex).toContain('(ih-1080)*');
    expect(g.filterComplex).not.toMatch(/\+\(\d+\)\*\(\(t-/); // no `+(N)*((t-...))`
  });

  // ─── Tall screenshots still produce the human-ish multi-segment scroll ──────

  it('tall screenshot (5200) keeps the multi-segment pause/scroll structure', () => {
    const g = buildFilterGraph({ ...base, screenshotHeight: 5200, durationSec: 30 });
    // Each segment looks like `if(lt(t\,START)\,FROM\,if(lt(t\,END)\,EASED\,...))`.
    // Count `if(lt(t\\,` openings — at least 4 (= initial pause + at least 2
    // scroll segments + at least 1 hold).
    const openings = g.filterComplex.match(/if\(lt\(t\\,/g) ?? [];
    expect(openings.length).toBeGreaterThanOrEqual(4);
    // And smoothstep easing must still be present.
    expect(g.filterComplex).toMatch(/\*\(\(t-\d/);
    expect(g.filterComplex).toContain('(3-2*((t-');
  });

  it('30s 1080p tall page keeps the same segment timeline regardless of width', () => {
    // Two configs that differ ONLY in caller-irrelevant ways should generate
    // the same scroll TIMING (segment start/end times) — the seed is built
    // from screenshotHeight × viewportHeight × durationSec, all unchanged.
    // Width comes in only via the runtime `ih` reference; the timing must
    // not change.
    const a = buildFilterGraph({ ...base, screenshotHeight: 4000, durationSec: 30 });
    const b = buildFilterGraph({ ...base, screenshotHeight: 4000, durationSec: 30, circlePosition: 'top-left' });
    const timings = (s: string) => Array.from(s.matchAll(/lt\(t\\,([\d.]+)\)/g)).map((m) => m[1]);
    expect(timings(a.filterComplex)).toEqual(timings(b.filterComplex));
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
