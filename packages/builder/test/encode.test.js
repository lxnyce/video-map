import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clipArgs,
  ffColor,
  fullArgs,
  isWebCompatible,
  overviewGraph,
  parentGraph,
  posterArgs,
  previewWindow,
  stackGraph,
  tileArgs,
  tileEncode,
} from '../src/encode.js';
import { parseProbe } from '../src/probe.js';
import { createLimiter, formatDuration } from '../src/progress.js';

const probe = (over = {}) => ({
  duration: 30, width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1080, rotation: 0, sar: 1, fps: 30,
  videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', hdr: false, container: 'mov,mp4,m4a,3gp,3g2,mj2', ...over,
});
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

describe('previewWindow', () => {
  it('loops videos shorter than the loop from the start', () => {
    assert.deepEqual(previewWindow({ duration: 4, strategy: 'auto', loopLength: 10 }), { start: 0, loop: true, adjusted: false });
    assert.deepEqual(previewWindow({ duration: 10, strategy: 'auto', loopLength: 10 }), { start: 0, loop: true, adjusted: false });
    assert.equal(previewWindow({ duration: 4, previewStart: 2, strategy: 'auto', loopLength: 10 }).adjusted, true);
  });

  it('skips ~10% of long videos in auto mode, never running past the end', () => {
    assert.deepEqual(previewWindow({ duration: 100, strategy: 'auto', loopLength: 10 }), { start: 10, loop: false, adjusted: false });
    assert.deepEqual(previewWindow({ duration: 10.5, strategy: 'auto', loopLength: 10 }), { start: 0.5, loop: false, adjusted: false });
    assert.equal(previewWindow({ duration: 100, strategy: 'start', loopLength: 10 }).start, 0);
  });

  it('honors previewStart, pulling it back when too little video remains', () => {
    assert.deepEqual(previewWindow({ duration: 60, previewStart: 12.5, strategy: 'auto', loopLength: 10 }), { start: 12.5, loop: false, adjusted: false });
    assert.deepEqual(previewWindow({ duration: 60, previewStart: 55, strategy: 'auto', loopLength: 10 }), { start: 50, loop: false, adjusted: true });
  });
});

describe('clipArgs', () => {
  const base = {
    src: 'in.mov', probe: probe(), window: { start: 3, loop: false }, loopShort: true, fps: 24, frames: 240,
    cell: { w: 384, h: 216 }, fit: /** @type {const} */ ('cover'), background: '#101318', toneMap: true,
  };

  it('seeks, normalizes fps and size, and pins the frame count', () => {
    const args = clipArgs(base, 'out.mp4');
    assert.equal(argAfter(args, '-ss'), '3');
    assert.ok(!args.includes('-stream_loop'));
    assert.equal(argAfter(args, '-frames:v'), '240');
    const vf = argAfter(args, '-vf');
    assert.match(vf, /^fps=24,scale=384:216:force_original_aspect_ratio=increase.*,crop=384:216,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=-1$/);
    assert.equal(args.at(-1), 'out.mp4');
  });

  it('loops short sources and letterboxes in contain mode', () => {
    const args = clipArgs({ ...base, window: { start: 0, loop: true }, fit: 'contain' }, 'o.mp4');
    assert.ok(!args.includes('-ss'));
    assert.equal(argAfter(args, '-stream_loop'), '-1');
    assert.match(argAfter(args, '-vf'), /pad=384:216:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0x101318/);
  });

  it('holds the last frame instead of looping when loopShort is off', () => {
    const args = clipArgs({ ...base, window: { start: 0, loop: true }, loopShort: false }, 'o.mp4');
    assert.ok(!args.includes('-stream_loop'));
    assert.match(argAfter(args, '-vf'), /tpad=stop_mode=clone/);
  });

  it('fixes non-square pixels and tone-maps HDR', () => {
    const vf = argAfter(clipArgs({ ...base, probe: probe({ sar: 4 / 3, hdr: true }) }, 'o.mp4'), '-vf');
    assert.match(vf, /^scale=trunc\(iw\*sar\/2\)\*2:ih,setsar=1,zscale=t=linear/);
    assert.match(vf, /tonemap=tonemap=hable/);
    assert.doesNotMatch(argAfter(clipArgs({ ...base, probe: probe({ hdr: true }), toneMap: false }, 'o.mp4'), '-vf'), /tonemap/);
  });
});

describe('tile graphs', () => {
  it('stacks inputs at pixel offsets and pads to the tile size', () => {
    assert.equal(
      stackGraph([{ x: 0, y: 0 }, { x: 384, y: 216 }], { w: 768, h: 432 }, '#000000'),
      '[0:v][1:v]xstack=inputs=2:layout=0_0|384_216:fill=0x000000[s];[s]pad=768:432:0:0:color=0x000000[t]',
    );
    assert.equal(stackGraph([{ x: 384, y: 0 }], { w: 768, h: 432 }, '#000000'), '[0:v]pad=768:432:384:0:color=0x000000[t]');
  });

  it('builds parents from children at quadrant offsets, then halves', () => {
    const g = parentGraph([{ dx: 0, dy: 0 }, { dx: 1, dy: 1 }], { w: 512, h: 288 }, '#101318');
    assert.equal(g, '[0:v][1:v]xstack=inputs=2:layout=0_0|512_288:fill=0x101318[s];[s]pad=1024:576:0:0:color=0x101318[d];[d]scale=512:288:flags=area,setsar=1[t]');
  });

  it('crops the level-1 children to the wall and fits it into the overview tile', () => {
    const g = overviewGraph([{ dx: 0, dy: 0 }, { dx: 1, dy: 0 }], { w: 768, h: 432 }, { w: 816, h: 459 }, 768 / 816, '#101318');
    assert.match(g, /\[d\]crop=816:460:0:0,scale=768:432:flags=area,pad=768:432:0:0:color=0x101318,setsar=1\[t\]$/);
  });

  it('writes master, final and still from one composite', () => {
    const finalEncode = tileEncode({ tile: { w: 768, h: 432 }, fps: 24, crf: 28, level: '3.0' });
    assert.equal(argAfter(finalEncode, '-maxrate'), '956k');
    assert.equal(argAfter(finalEncode, '-g'), '24');
    const args = tileArgs({ inputs: ['a.mp4', 'b.mp4'], graph: 'G[t]', fps: 24, frames: 240, finalEncode }, { master: 'm.mp4', final: 'f.mp4', still: 's.webp' });
    assert.deepEqual(args.slice(0, 4), ['-i', 'a.mp4', '-i', 'b.mp4']);
    assert.equal(argAfter(args, '-filter_complex'), 'G[t];[t]split=3[o0][o1][o2]');
    assert.deepEqual(args.filter((a) => /^\[o\d\]$/.test(a)), ['[o0]', '[o1]', '[o2]']);
    assert.deepEqual(args.filter((a) => /\.(mp4|webp)$/.test(a)).slice(2), ['m.mp4', 'f.mp4', 's.webp']);
    const still = args.slice(args.indexOf('[o2]'));
    assert.equal(argAfter(still, '-frames:v'), '1');
  });
});

describe('full renditions and posters', () => {
  it('remuxes web-friendly sources and transcodes the rest', () => {
    assert.ok(isWebCompatible(probe(), 1080));
    assert.ok(!isWebCompatible(probe({ height: 2160 }), 1080));
    assert.ok(!isWebCompatible(probe({ videoCodec: 'hevc' }), 1080));
    assert.ok(!isWebCompatible(probe({ audioCodec: 'opus' }), 1080));
    assert.ok(!isWebCompatible(probe({ rotation: 90 }), 1080));
    assert.ok(!isWebCompatible(probe({ container: 'matroska,webm' }), 1080));

    const copy = fullArgs({ src: 'in.mp4', probe: probe(), maxHeight: 1080, crf: 23, toneMap: true }, 'o.mp4');
    assert.equal(argAfter(copy, '-c'), 'copy');
    const tx = fullArgs({ src: 'in.mkv', probe: probe({ container: 'matroska,webm' }), maxHeight: 720, crf: 23, toneMap: true }, 'o.mp4');
    assert.match(argAfter(tx, '-vf'), /scale=-2:'min\(720,trunc\(ih\/2\)\*2\)'/);
    assert.equal(argAfter(tx, '-c:a'), 'aac');
  });

  it('extracts posters as WebP or JPEG', () => {
    const webp = posterArgs({ src: 'in.mp4', probe: probe(), time: 4, webp: true, toneMap: false }, 'p.webp');
    assert.equal(argAfter(webp, '-ss'), '4');
    assert.equal(argAfter(webp, '-c:v'), 'libwebp');
    const jpg = posterArgs({ src: 'poster.png', probe: null, time: 0, webp: false, toneMap: false }, 'p.jpg');
    assert.ok(!jpg.includes('-ss'));
    assert.ok(!jpg.includes('libwebp'));
  });

  it('formats colors for ffmpeg', () => {
    assert.equal(ffColor('#AbCdEf'), '0xAbCdEf');
  });
});

describe('parseProbe', () => {
  /** @param {any[]} streams @param {any} [format] */
  const data = (streams, format = { duration: '12.5', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }) => ({ streams, format });

  it('reads display size, rotation, fps and audio', () => {
    const p = parseProbe(data([
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p', side_data_list: [{ rotation: -90 }] },
      { codec_type: 'audio', codec_name: 'aac' },
    ]), 'x');
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.equal(p.rotation, -90);
    assert.ok(Math.abs(p.fps - 29.97) < 0.01);
    assert.equal(p.audioCodec, 'aac');
    assert.equal(p.duration, 12.5);
  });

  it('applies sample aspect ratio, detects HDR, skips cover art', () => {
    const p = parseProbe(data([
      { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'hevc', width: 720, height: 576, sample_aspect_ratio: '16:15', color_transfer: 'smpte2084', r_frame_rate: '25/1' },
    ]), 'x');
    assert.equal(p.videoCodec, 'hevc');
    assert.equal(p.width, 768);
    assert.equal(p.hdr, true);
    assert.equal(p.audioCodec, null);
  });

  it('rejects files without video or duration', () => {
    assert.throws(() => parseProbe(data([{ codec_type: 'audio' }]), 'song.mp3'), /no video stream/);
    assert.throws(() => parseProbe(data([{ codec_type: 'video', width: 2, height: 2 }], {}), 'x'), /duration/);
  });
});

describe('createLimiter', () => {
  it('caps concurrency and stops starting jobs after a failure', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = (fail) => limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (fail) throw new Error('boom');
      return 'ok';
    });
    assert.deepEqual(await Promise.all([job(), job(), job(), job()]), ['ok', 'ok', 'ok', 'ok']);
    assert.equal(peak, 2);

    const failing = createLimiter(1);
    let ran = 0;
    const results = await Promise.allSettled([
      failing(async () => { throw new Error('first'); }),
      failing(async () => { ran++; }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
    assert.equal(ran, 0);
  });

  it('formats durations', () => {
    assert.equal(formatDuration(5.2), '6s');
    assert.equal(formatDuration(125), '2m05s');
    assert.equal(formatDuration(3720), '1h02m');
  });
});
