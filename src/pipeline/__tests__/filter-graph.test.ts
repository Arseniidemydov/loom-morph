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
      `"[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080:(iw-1920)/2:if(lt(t\\,2.1)\\,0\\,if(lt(t\\,6.6)\\,0+((ih-1080)*0.2933)*((t-2.1)/4.5)*((t-2.1)/4.5)*(3-2*((t-2.1)/4.5))\\,if(lt(t\\,10.5)\\,(ih-1080)*0.2933\\,if(lt(t\\,15.5)\\,(ih-1080)*0.2933+((ih-1080)*0.2583)*((t-10.5)/5)*((t-10.5)/5)*(3-2*((t-10.5)/5))\\,if(lt(t\\,18.6)\\,(ih-1080)*0.5516\\,if(lt(t\\,23.3)\\,(ih-1080)*0.5516+((ih-1080)*0.1978)*((t-18.6)/4.7)*((t-18.6)/4.7)*(3-2*((t-18.6)/4.7))\\,if(lt(t\\,24.7)\\,(ih-1080)*0.7494\\,if(lt(t\\,25.6)\\,(ih-1080)*0.7494+((ih-1080)*-0.1384)*((t-24.7)/0.9)*((t-24.7)/0.9)*(3-2*((t-24.7)/0.9))\\,if(lt(t\\,27.8)\\,(ih-1080)*0.611\\,if(lt(t\\,30)\\,(ih-1080)*0.611+((ih-1080)*0.2008)*((t-27.8)/2.2)*((t-27.8)/2.2)*(3-2*((t-27.8)/2.2))\\,(ih-1080)*0.8118)))))))))),setsar=1,fps=30[bg];[1:v]scale=280:280:force_original_aspect_ratio=increase,crop=280:280[c_raw];[c_raw][2:v]alphamerge[circle];[bg][circle]overlay=1600:760:shortest=0[v]"`,
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
      `"[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720:(iw-1280)/2:if(lt(t\\,1.8)\\,0\\,if(lt(t\\,10)\\,0+((ih-720)*0.2622)*((t-1.8)/8.2)*((t-1.8)/8.2)*(3-2*((t-1.8)/8.2))\\,if(lt(t\\,16.3)\\,(ih-720)*0.2622\\,if(lt(t\\,23)\\,(ih-720)*0.2622+((ih-720)*0.1629)*((t-16.3)/6.7)*((t-16.3)/6.7)*(3-2*((t-16.3)/6.7))\\,if(lt(t\\,29.9)\\,(ih-720)*0.4251\\,if(lt(t\\,35.1)\\,(ih-720)*0.4251+((ih-720)*0.2555)*((t-29.9)/5.2)*((t-29.9)/5.2)*(3-2*((t-29.9)/5.2))\\,if(lt(t\\,37.4)\\,(ih-720)*0.6806\\,if(lt(t\\,38.1)\\,(ih-720)*0.6806+((ih-720)*-0.1138)*((t-37.4)/0.7)*((t-37.4)/0.7)*(3-2*((t-37.4)/0.7))\\,if(lt(t\\,42.3)\\,(ih-720)*0.5668\\,if(lt(t\\,51)\\,(ih-720)*0.5668+((ih-720)*0.2613)*((t-42.3)/8.7)*((t-42.3)/8.7)*(3-2*((t-42.3)/8.7))\\,if(lt(t\\,56.2)\\,(ih-720)*0.8281\\,if(lt(t\\,60)\\,(ih-720)*0.8281+(0)*((t-56.2)/3.8)*((t-56.2)/3.8)*(3-2*((t-56.2)/3.8))\\,(ih-720)*0.8281)))))))))))),setsar=1,fps=30[bg];[1:v]scale=200:200:force_original_aspect_ratio=increase,crop=200:200[c_raw];[c_raw][2:v]alphamerge[circle];[bg][circle]overlay=40:40:shortest=0[v];[1:a][3:a]amix=inputs=2:duration=first:dropout_transition=0[a]"`,
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

  it('supports zooming and offsetting the media inside the circle crop', () => {
    const g = buildFilterGraph({
      ...base,
      circleCropScale: 1.5,
      circleCropX: 40,
      circleCropY: -20,
    });
    // 280 × scale 1.5 × CROP_BASE_ZOOM 1.25 = 525.
    expect(g.filterComplex).toContain(
      '[1:v]scale=525:525:force_original_aspect_ratio=increase,crop=280:280:(iw-280)*0.7:(ih-280)*0.4[c_raw]',
    );
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

  // ─── backgroundKind=video skips the time-based pan ──────────────────────

  it('backgroundKind=video emits a center-crop background stage with no pan expression', () => {
    const g = buildFilterGraph({ ...base, backgroundKind: 'video' });
    // Center crop both axes — no time-based panY.
    // No `fps=30` for video-bg path — preserves the source recording's
    // native timestamps so an on-page hero video doesn't judder from
    // frame duplication. Lanczos filtering keeps the downscale from
    // supersampled captures crisp.
    expect(g.filterComplex).toContain(
      '[0:v]scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080:(iw-1920)/2:(ih-1080)/2,setsar=1[bg]',
    );
    // No `if(lt(t\,…)` segment cascade in the background stage.
    const bgPart = g.filterComplex.split(';')[0]!;
    expect(bgPart).not.toMatch(/if\(lt\(t/);
  });

  it('default (no backgroundKind) keeps the segmented pan behavior', () => {
    const g = buildFilterGraph(base);
    const bgPart = g.filterComplex.split(';')[0]!;
    expect(bgPart).toMatch(/if\(lt\(t\\,\d/); // pan expression present
  });

  it('buildFfmpegArgs with backgroundKind=video drops the -loop/-t flags for input 0', () => {
    const job: RenderJob = {
      screenshotPath: '/tmp/recording.webm',
      screenshotHeight: 800,
      circleSourcePath: '/tmp/circle.png',
      circleHasAudio: false,
      outputPath: '/output/out.mp4',
      backgroundKind: 'video',
      config: {
        durationSec: 5,
        resolution: '720p',
        circlePosition: 'bottom-right',
        circleSize: 'M',
        circleMargin: 20,
        filenameTemplate: '',
      },
    };
    const args = buildFfmpegArgs(job, { maskDir: '/masks' });
    // The first -i should be the recording, NOT preceded by -loop/-t.
    const firstI = args.indexOf('-i');
    expect(args[firstI + 1]).toBe('/tmp/recording.webm');
    expect(args.slice(0, firstI)).toEqual(['-y']); // only -y before -i
    // The mask still gets the loop+t (it's still a still image).
    // Just before the mask path we expect: -loop 1 -framerate 30 -t 5 -i <mask>.
    const maskPathIdx = args.findIndex((a) => a.endsWith('/circle-mask-280.png'));
    expect(maskPathIdx).toBeGreaterThan(0);
    expect(args[maskPathIdx - 1]).toBe('-i');
    expect(args.slice(maskPathIdx - 7, maskPathIdx - 1)).toEqual(['-loop', '1', '-framerate', '30', '-t', '5']);
  });

  it('buildFfmpegArgs adds `-ss <offset>` before the video input when backgroundStartOffsetSec is set', () => {
    const job: RenderJob = {
      screenshotPath: '/tmp/recording.webm',
      screenshotHeight: 800,
      circleSourcePath: '/tmp/circle.png',
      circleHasAudio: false,
      outputPath: '/output/out.mp4',
      backgroundKind: 'video',
      backgroundStartOffsetSec: 3.4,
      config: {
        durationSec: 5,
        resolution: '720p',
        circlePosition: 'bottom-right',
        circleSize: 'M',
        circleMargin: 20,
        filenameTemplate: '',
      },
    };
    const args = buildFfmpegArgs(job, { maskDir: '/masks' });
    const firstI = args.indexOf('-i');
    expect(args[firstI + 1]).toBe('/tmp/recording.webm');
    // ['-y', '-ss', '3.4', '-i', ...] — the seek arg must precede `-i`.
    expect(args.slice(0, firstI)).toEqual(['-y', '-ss', '3.4']);
  });

  it('buildFfmpegArgs ignores backgroundStartOffsetSec=0 (no seek args)', () => {
    const job: RenderJob = {
      screenshotPath: '/tmp/recording.webm',
      screenshotHeight: 800,
      circleSourcePath: '/tmp/circle.png',
      circleHasAudio: false,
      outputPath: '/output/out.mp4',
      backgroundKind: 'video',
      backgroundStartOffsetSec: 0,
      config: {
        durationSec: 5,
        resolution: '720p',
        circlePosition: 'bottom-right',
        circleSize: 'M',
        circleMargin: 20,
        filenameTemplate: '',
      },
    };
    const args = buildFfmpegArgs(job, { maskDir: '/masks' });
    const firstI = args.indexOf('-i');
    expect(args.slice(0, firstI)).toEqual(['-y']);
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
