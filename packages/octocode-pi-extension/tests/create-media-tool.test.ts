import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import {
  pdfDocumentFromHtml,
  pdfDocumentFromMarkdown,
  pdfDocumentFromImages,
  runMediaOperation,
  registerMediaTool,
} from '../src/tools/create-media-tool.js';
import { detectFfmpeg, runBinary } from '../src/tools/ffmpeg-runtime.js';
import type { ToolDefinition } from '../src/types.js';

const ff = detectFfmpeg();
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0d1117"/><circle cx="20" cy="10" r="6" fill="#58a6ff"/></svg>';

// ── pure PDF composition helpers ────────────────────────────────────────────
describe('pdf document builders', () => {
  it('wraps fragment html but passes full docs through', () => {
    expect(pdfDocumentFromHtml('<h1>hi</h1>')).toMatch(/<!doctype html>.*<h1>hi<\/h1>/is);
    const full = '<!doctype html><html><body>x</body></html>';
    expect(pdfDocumentFromHtml(full)).toBe(full);
  });
  it('renders markdown to html', () => {
    const doc = pdfDocumentFromMarkdown('# Title\n\n- a\n- b');
    expect(doc).toMatch(/<h1>Title<\/h1>/);
    expect(doc).toMatch(/<li>a<\/li>/);
  });
  it('makes one page per image with page-breaks', () => {
    const doc = pdfDocumentFromImages(['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
    expect(doc.match(/<img/g)?.length).toBe(2);
    expect(doc).toMatch(/page-break-after:always/);
  });
});

// ── registration ────────────────────────────────────────────────────────────
describe('registerMediaTool', () => {
  it('registers the single artifact-producing `media` tool', () => {
    let def: ToolDefinition | undefined;
    registerMediaTool({ registerTool: (d: ToolDefinition) => { def = d; } }, Type, new Set(), (pi, _n, d) => pi.registerTool?.(d));
    expect(def?.name).toBe('media');
  });
});

// ── image authoring (browser-free svg path — always runs) ───────────────────
describe('runMediaOperation image (svg)', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'create-media-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('rasterizes svg to an inline PNG', async () => {
    const r = await runMediaOperation({ type: 'image', svg: SVG }, dir);
    expect(r.ok).toBe(true);
    expect(r.mimeType).toBe('image/png');
    expect(Buffer.from(r.base64!, 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });
  it('rejects image with neither svg nor html', async () => {
    await expect(runMediaOperation({ type: 'image' }, dir)).rejects.toThrow(/svg.*html/);
  });
  it('rejects an unknown output', async () => {
    await expect(runMediaOperation({ type: 'hologram' }, dir)).rejects.toThrow(/type/);
  });
  it('pdf requires exactly one source', async () => {
    await expect(runMediaOperation({ type: 'pdf', dest: path.join(dir, 'x.pdf'), html: '<p>a</p>', markdown: '# b' }, dir))
      .rejects.toThrow(/only one PDF source/);
  });
});

// ── ffmpeg delegation (skipped when binary absent) ──────────────────────────
const d = ff.ok ? describe : describe.skip;
d('runMediaOperation ffmpeg delegation', () => {
  let dir: string;
  let sample: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'create-media-ff-'));
    sample = path.join(dir, 'sample.mp4');
    await runBinary(ff.ffmpeg!, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample,
    ], { cwd: dir });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('gif writes a file via `dest`', async () => {
    const out = path.join(dir, 'out.gif');
    const r = await runMediaOperation({ type: 'gif', source: sample, dest: out, fps: 8, width: 120 }, dir);
    expect(r.ok).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
  });
  it('trim honors the overwrite guard', async () => {
    const out = path.join(dir, 'clip.mp4');
    await runMediaOperation({ type: 'trim', source: sample, dest: out, from: '0', to: '1' }, dir);
    expect(existsSync(out)).toBe(true);
    await expect(runMediaOperation({ type: 'trim', source: sample, dest: out, from: '0', to: '1' }, dir))
      .rejects.toThrow(/already exists/);
  });
});
