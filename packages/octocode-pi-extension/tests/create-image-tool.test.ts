import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { createImageFromSvg, createImageFromHtml, registerCreateImageTool } from '../src/tools/create-image-tool.js';
import { setCapabilityCheckForTests } from '../src/tools/image-render.js';
import { findChromePath } from '../src/chrome-debug.js';
import type { ToolDefinition, ImageContentPart, RenderContext } from '../src/types.js';

// Live Chrome render is gated behind an env flag (like RUN_MCP_LIVE) so launching
// a headless browser never destabilizes the parallel unit suite. Run with:
//   RUN_CHROME_LIVE=1 yarn workspace @octocodeai/pi-extension test:unit
function chromeLiveEnabled(): boolean {
  if (process.env.RUN_CHROME_LIVE !== '1') return false;
  try { findChromePath(); return true; } catch { return false; }
}

let dir: string;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0d1117"/><circle cx="20" cy="10" r="6" fill="#58a6ff"/></svg>';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'create-image-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function getTool(): ToolDefinition {
  let def: ToolDefinition | undefined;
  registerCreateImageTool(
    { registerTool: (d: ToolDefinition) => { def = d; } },
    Type,
    new Set<string>(),
    (pi, _n, d) => pi.registerTool?.(d),
  );
  if (!def) throw new Error('createImage not registered');
  return def;
}

describe('createImageFromSvg', () => {
  it('rasterizes valid SVG to a PNG base64 (png magic header)', () => {
    const res = createImageFromSvg(SVG, dir, { name: 'dot.png' });
    expect(res.ok).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    const buf = Buffer.from(res.base64!, 'base64');
    // PNG magic bytes
    expect(buf.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });

  it('honors an explicit render width', () => {
    const small = createImageFromSvg(SVG, dir, { width: 40 });
    const big = createImageFromSvg(SVG, dir, { width: 400 });
    expect(big.bytes!).toBeGreaterThan(small.bytes!);
  });

  it('rejects input without an <svg> element', () => {
    const res = createImageFromSvg('not svg at all', dir);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/<svg>/);
  });

  it('reports a render failure for malformed SVG', () => {
    const res = createImageFromSvg('<svg><rect width="oops"', dir);
    expect(res.ok).toBe(false);
  });

  it('saves the PNG to disk when saveTo is given', async () => {
    const out = path.join(dir, 'nested', 'diagram.png');
    const res = createImageFromSvg(SVG, dir, { saveTo: out });
    expect(res.ok).toBe(true);
    expect(res.savedPath).toBe(out);
    expect(existsSync(out)).toBe(true);
    const onDisk = await readFile(out);
    expect(onDisk.length).toBe(res.bytes);
  });
});

describe('createImage tool', () => {
  it('returns a text note and keeps the image out of model content by default', async () => {
    const tool = getTool();
    const result = await tool.execute!('c1', { svg: SVG }, undefined, undefined, { cwd: dir });
    expect(result.isError).toBeFalsy();
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
    expect(result.content.some((c) => c.type === 'text')).toBe(true);
    expect((result.details as { base64?: string }).base64).toBeTruthy();
  });

  it('includes a vision image block when showToModel is true', async () => {
    const tool = getTool();
    const result = await tool.execute!('c2', { svg: SVG, showToModel: true }, undefined, undefined, { cwd: dir });
    const img = result.content.find((c) => c.type === 'image') as ImageContentPart | undefined;
    expect(img).toBeDefined();
    expect(img!.mimeType).toBe('image/png');
  });

  it('returns an error result for invalid svg', async () => {
    const tool = getTool();
    const result = await tool.execute!('c3', { svg: 'nope' }, undefined, undefined, { cwd: dir });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
  });

  it('throws when neither svg nor html is given', async () => {
    const tool = getTool();
    await expect(tool.execute!('c4', {}, undefined, undefined, { cwd: dir })).rejects.toThrow(/svg.*html/);
  });

  it('throws when both svg and html are given', async () => {
    const tool = getTool();
    await expect(tool.execute!('c4b', { svg: SVG, html: '<div>x</div>' }, undefined, undefined, { cwd: dir })).rejects.toThrow(/only one/);
  });

  it('renderResult inlines the rendered image below the status line (placeholder when unsupported)', async () => {
    setCapabilityCheckForTests(() => false);
    try {
      const tool = getTool();
      const result = await tool.execute!('c5', { svg: SVG, name: 'chart.png' }, undefined, undefined, { cwd: dir });
      const ctx = { state: {}, invalidate() {} } as unknown as RenderContext;
      const lines = tool.renderResult!(result, { expanded: true }, undefined, ctx).render(120);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.some((l) => l.includes('\ud83d\uddbc image: chart.png'))).toBe(true);
    } finally {
      setCapabilityCheckForTests(undefined);
    }
  });

  it('on an image-incapable terminal: saves the PNG and suggests opening in a browser (never auto-opens)', async () => {
    setCapabilityCheckForTests(() => false);
    try {
      const tool = getTool();
      const result = await tool.execute!('cff', { svg: SVG, name: 'chart.png' }, undefined, undefined, { cwd: dir });
      const text = (result.content.find((c) => c.type === 'text') as { text: string }).text;
      expect(text).toMatch(/no inline-image support/i);
      expect(text).toMatch(/ask the user first/i);
      const details = result.details as { savedPath?: string; terminalSupportsImages?: boolean };
      expect(details.terminalSupportsImages).toBe(false);
      expect(details.savedPath).toBeTruthy();
      expect(existsSync(details.savedPath!)).toBe(true);
    } finally {
      setCapabilityCheckForTests(undefined);
    }
  });

  it('on an image-capable terminal: no browser suggestion, no fallback save', async () => {
    setCapabilityCheckForTests(() => true);
    try {
      const tool = getTool();
      const result = await tool.execute!('cok', { svg: SVG }, undefined, undefined, { cwd: dir });
      const text = (result.content.find((c) => c.type === 'text') as { text: string }).text;
      expect(text).not.toMatch(/browser/i);
      const details = result.details as { savedPath?: string; terminalSupportsImages?: boolean };
      expect(details.terminalSupportsImages).toBe(true);
      expect(details.savedPath).toBeFalsy();
    } finally {
      setCapabilityCheckForTests(undefined);
    }
  });

  it('rejects empty html markup', async () => {
    const res = await createImageFromHtml('   ', dir);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/html/);
  });

  it.skipIf(!chromeLiveEnabled())('renders HTML to a PNG via headless Chrome [RUN_CHROME_LIVE=1]', async () => {
    const res = await createImageFromHtml(
      '<div style="width:120px;height:60px;background:#58a6ff;color:#fff;font:16px sans-serif;display:flex;align-items:center;justify-content:center">hi</div>',
      dir,
      { name: 'card.png' },
    );
    expect(res.ok).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    const buf = Buffer.from(res.base64!, 'base64');
    expect(buf.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  }, 30000);

  it('renderResult does NOT self-render when showToModel put an image in content (pi renders it)', async () => {
    setCapabilityCheckForTests(() => false);
    try {
      const tool = getTool();
      const result = await tool.execute!('c6', { svg: SVG, name: 'chart.png', showToModel: true }, undefined, undefined, { cwd: dir });
      expect(result.content.some((c) => c.type === 'image')).toBe(true);
      const ctx = { state: {}, invalidate() {} } as unknown as RenderContext;
      const lines = tool.renderResult!(result, { expanded: true }, undefined, ctx).render(120);
      // Only the status line — pi's tool-execution renders the content image block.
      expect(lines.length).toBe(1);
      expect(lines.some((l) => l.includes('\ud83d\uddbc image:'))).toBe(false);
    } finally {
      setCapabilityCheckForTests(undefined);
    }
  });
});
