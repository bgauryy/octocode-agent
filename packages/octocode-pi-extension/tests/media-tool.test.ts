import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidTimestamp,
  summarizeProbe,
  frameArgs,
  contactSheetArgs,
  gifArgs,
  trimArgs,
  audioArgs,
  convertArgs,
  runMediaQuery,
} from '../src/tools/media-tool.js';
import { detectFfmpeg, runBinary } from '../src/tools/ffmpeg-runtime.js';

const ff = detectFfmpeg();
const hasFfmpeg = ff.ok;

// ── pure validators ────────────────────────────────────────────────────────
describe('isValidTimestamp', () => {
  it('accepts SS, MM:SS, HH:MM:SS and fractional forms', () => {
    for (const t of ['0', '12', '12.5', '1:05', '01:05', '00:01:05', '00:01:05.500']) {
      expect(isValidTimestamp(t)).toBe(true);
    }
  });
  it('rejects garbage / injection attempts', () => {
    for (const t of ['-ss', '12; rm -rf /', 'abc', '99:99', '1:2:3:4', '']) {
      expect(isValidTimestamp(t)).toBe(false);
    }
  });
});

describe('summarizeProbe', () => {
  it('extracts width/height/codecs/duration from ffprobe json', () => {
    const s = summarizeProbe({
      format: { format_name: 'mov,mp4', duration: '5.0', bit_rate: '128000' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, avg_frame_rate: '30/1' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    expect(s).toMatchObject({ width: 640, height: 360, videoCodec: 'h264', audioCodec: 'aac', fps: 30, durationSec: 5 });
  });
});

// ── argv builders never route through a shell; assert flag structure ────────
describe('argv builders', () => {
  it('frameArgs places timestamp + input in fixed positions', () => {
    const a = frameArgs('in.mp4', 'out.png', '1:05', 320);
    expect(a).toEqual(['-y', '-ss', '1:05', '-i', 'in.mp4', '-frames:v', '1', '-vf', 'scale=320:-1', 'out.png']);
  });
  it('contactSheetArgs builds an fps,scale,tile chain', () => {
    const a = contactSheetArgs('in.mp4', 'out.png', 10, 9, 3, 160).join(' ');
    expect(a).toMatch(/fps=0\.9/);
    expect(a).toMatch(/tile=3x3/);
  });
  it('gifArgs uses palettegen/paletteuse', () => {
    expect(gifArgs('in.mp4', 'o.gif', { fps: 12, width: 480 }).join(' ')).toMatch(/palettegen.*paletteuse/);
  });
  it('trimArgs stream-copies by default and re-encodes on demand', () => {
    expect(trimArgs('in.mp4', 'o.mp4', '1', '3', undefined, false)).toContain('copy');
    expect(trimArgs('in.mp4', 'o.mp4', '1', '3', undefined, true)).toContain('libx264');
  });
  it('audioArgs maps format→codec and drops video', () => {
    const a = audioArgs('in.mp4', 'o.mp3', 'mp3', '192k');
    expect(a).toContain('-vn');
    expect(a).toContain('libmp3lame');
    expect(a).toContain('192k');
  });
  it('convertArgs maps codec aliases and scale', () => {
    const a = convertArgs('in.mp4', 'o.webm', { videoCodec: 'vp9', scale: '1280x-1' }).join(' ');
    expect(a).toMatch(/libvpx-vp9/);
    expect(a).toMatch(/scale=1280:-1/);
  });
});

// ── end-to-end against real ffmpeg (skipped when binary absent) ──────────────
const d = hasFfmpeg ? describe : describe.skip;
d('runMediaQuery (live ffmpeg)', () => {
  let dir: string;
  let sample: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'media-tool-'));
    sample = path.join(dir, 'sample.mp4');
    // 3s 320x180 test clip with a 440Hz tone.
    await runBinary(ff.ffmpeg!, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample,
    ], { cwd: dir });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('probe reports resolution + codecs', async () => {
    const r = await runMediaQuery({ mode: 'probe', input: sample }, dir);
    expect(r.ok).toBe(true);
    expect(r.probe?.width).toBe(320);
    expect(r.probe?.height).toBe(180);
    expect(r.probe?.videoCodec).toBe('h264');
  });

  it('frame returns an inline PNG', async () => {
    const r = await runMediaQuery({ mode: 'frame', input: sample, at: '1', width: 160 }, dir);
    expect(r.ok).toBe(true);
    expect(r.mimeType).toBe('image/png');
    expect(Buffer.from(r.base64!, 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });

  it('contactSheet tiles multiple frames into one PNG', async () => {
    const r = await runMediaQuery({ mode: 'contactSheet', input: sample, count: 4, columns: 2, width: 120 }, dir);
    expect(r.ok).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it('trim writes a shorter clip (stream-copy)', async () => {
    const out = path.join(dir, 'clip.mp4');
    const r = await runMediaQuery({ mode: 'trim', input: sample, output: out, from: '0', to: '1' }, dir);
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect((r.probe?.durationSec ?? 99)).toBeLessThan(2);
  });

  it('gif writes an animated gif', async () => {
    const out = path.join(dir, 'out.gif');
    const r = await runMediaQuery({ mode: 'gif', input: sample, output: out, fps: 8, width: 160 }, dir);
    expect(r.ok).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
  });

  it('audio extracts an mp3 track', async () => {
    const out = path.join(dir, 'out.mp3');
    const r = await runMediaQuery({ mode: 'audio', input: sample, output: out, format: 'mp3' }, dir);
    expect(r.ok).toBe(true);
    expect(r.probe?.audioCodec).toBe('mp3');
  });

  it('refuses to overwrite without overwrite:true', async () => {
    const out = path.join(dir, 'clip.mp4'); // already written above
    await expect(runMediaQuery({ mode: 'trim', input: sample, output: out, from: '0', to: '1' }, dir)).rejects.toThrow(/already exists/);
  });

  it('rejects a missing input', async () => {
    await expect(runMediaQuery({ mode: 'probe', input: path.join(dir, 'nope.mp4') }, dir)).rejects.toThrow(/not found/);
  });
});
