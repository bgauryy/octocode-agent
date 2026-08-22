import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { readImageFile, registerReadImageTool } from '../src/tools/read-image-tool.js';
import type { ToolDefinition, ImageContentPart } from '../src/types.js';

let dir: string;

// Minimal valid 1x1 PNG (has the PNG magic header sniffImageMime checks for).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'read-image-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function getTool(): ToolDefinition {
  let def: ToolDefinition | undefined;
  registerReadImageTool(
    { registerTool: (d: ToolDefinition) => { def = d; } },
    Type,
    new Set<string>(),
    (pi, _n, d) => pi.registerTool?.(d),
  );
  if (!def) throw new Error('readImage not registered');
  return def;
}

describe('readImageFile', () => {
  it('loads a valid png and reports mime + bytes', async () => {
    const f = path.join(dir, 'shot.png');
    await writeFile(f, PNG_1x1);
    const res = readImageFile(f, dir);
    expect(res.ok).toBe(true);
    expect(res.mimeType).toBe('image/png');
    expect(res.base64).toBe(PNG_1x1.toString('base64'));
    expect(res.bytes).toBeGreaterThan(0);
  });

  it('rejects a non-image file with a reason', async () => {
    const f = path.join(dir, 'notes.txt');
    await writeFile(f, 'hello world', 'utf8');
    const res = readImageFile(f, dir);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not a supported image|missing/);
  });

  it('rejects a missing file', () => {
    const res = readImageFile(path.join(dir, 'nope.png'), dir);
    expect(res.ok).toBe(false);
  });
});

describe('readImage tool', () => {
  it('returns an image content block for the vision model', async () => {
    const f = path.join(dir, 'shot.png');
    await writeFile(f, PNG_1x1);
    const tool = getTool();
    const result = await tool.execute!('t1', { path: f }, undefined, undefined, { cwd: dir });
    expect(result.isError).toBeFalsy();
    const img = result.content.find((c) => c.type === 'image') as ImageContentPart | undefined;
    expect(img).toBeDefined();
    expect(img!.mimeType).toBe('image/png');
    expect(img!.data).toBe(PNG_1x1.toString('base64'));
    // plus a short text note
    expect(result.content.some((c) => c.type === 'text')).toBe(true);
  });

  it('returns an error result (no image block) for a non-image', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, 'nope', 'utf8');
    const tool = getTool();
    const result = await tool.execute!('t2', { path: f }, undefined, undefined, { cwd: dir });
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.type === 'image')).toBe(false);
  });

  it('throws when path is missing', async () => {
    const tool = getTool();
    await expect(tool.execute!('t3', {}, undefined, undefined, { cwd: dir })).rejects.toThrow(/path/);
  });

  it('renderCall shows the path; renderResult shows the note', async () => {
    const f = path.join(dir, 'shot.png');
    await writeFile(f, PNG_1x1);
    const tool = getTool();
    const call = tool.renderCall!({ path: 'shot.png' }).render(120).join('');
    expect(call).toContain('readImage');
    expect(call).toContain('shot.png');
    const result = await tool.execute!('t4', { path: f }, undefined, undefined, { cwd: dir });
    const line = tool.renderResult!(result, { expanded: false }).render(120).join('');
    expect(line).toContain('readImage');
    expect(line).toMatch(/image\/png/);
  });

  it('renderResult renders only the status line (pi renders the content image block natively)', async () => {
    const f = path.join(dir, 'shot.png');
    await writeFile(f, PNG_1x1);
    const tool = getTool();
    const result = await tool.execute!('t5', { path: f }, undefined, undefined, { cwd: dir });
    // The image content block is present for pi/the vision model, but renderResult
    // must NOT re-render it (pi's tool-execution component does) — single line only.
    expect(result.content.some((c) => c.type === 'image')).toBe(true);
    const lines = tool.renderResult!(result, { expanded: true }).render(120);
    expect(lines.length).toBe(1);
  });
});
