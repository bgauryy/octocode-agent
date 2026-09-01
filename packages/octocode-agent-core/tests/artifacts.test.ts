import { describe, expect, it } from 'vitest';

import type { ModelMessage } from '../src/contracts/ports.js';
import {
  MODEL_TOOL_RESULT_MAX_PARTS,
  MODEL_TOOL_RESULT_MAX_TEXT_BYTES,
  assertArtifactDescriptorV1,
  assertModelToolResultV1,
  modelToolResultTextFallback,
  type ArtifactDescriptorV1,
  type ModelToolResultV1,
} from '../src/contracts/artifacts.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const artifact = (overrides: Partial<ArtifactDescriptorV1> = {}): ArtifactDescriptorV1 => ({
  schemaVersion: 1,
  artifactId: 'frame-001',
  kind: 'image',
  path: 'artifacts/frame.png',
  mediaType: 'image/png',
  byteLength: png.byteLength,
  sha256: 'a'.repeat(64),
  title: 'Extracted frame',
  ...overrides,
});

const result = (overrides: Partial<ModelToolResultV1> = {}): ModelToolResultV1 => ({
  schemaVersion: 1,
  parts: [
    { type: 'text', text: 'Frame extracted.' },
    {
      type: 'image',
      mediaType: 'image/png',
      data: { encoding: 'base64', value: png.toString('base64') },
      byteLength: png.byteLength,
      filename: 'frame.png',
    },
    { type: 'artifact', artifact: artifact() },
  ],
  ...overrides,
});

describe('typed model artifact contracts', () => {
  it('strictly accepts bounded text, verified inline images, and workspace artifacts', () => {
    const decoded = assertModelToolResultV1(result());
    expect(decoded).toEqual(result());
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.parts)).toBe(true);
    expect(assertArtifactDescriptorV1(artifact())).toEqual(artifact());

    const message: ModelMessage = {
      role: 'tool',
      toolCallId: 'call-1',
      content: modelToolResultTextFallback(decoded),
      result: decoded,
    };
    expect(message.result).toBe(decoded);
  });

  it('rejects unknown fields, malformed bytes, traversal, absolute paths, and dishonest metadata', () => {
    expect(() => assertModelToolResultV1({ ...result(), extra: true })).toThrow(/field/i);
    expect(() => assertModelToolResultV1({
      ...result(),
      parts: [{ type: 'text', text: 'ok', extra: true }],
    })).toThrow(/field/i);
    expect(() => assertModelToolResultV1({
      ...result(),
      parts: [{
        type: 'image', mediaType: 'image/png',
        data: { encoding: 'base64', value: Buffer.from('not png').toString('base64') },
        byteLength: 7,
      }],
    })).toThrow(/signature/i);
    expect(() => assertArtifactDescriptorV1(artifact({ path: '../escape.png' }))).toThrow(/workspace-relative/i);
    expect(() => assertArtifactDescriptorV1(artifact({ path: '/tmp/escape.png' }))).toThrow(/workspace-relative/i);
    expect(() => assertArtifactDescriptorV1(artifact({ path: 'artifacts\\escape.png' }))).toThrow(/workspace-relative/i);
    expect(() => assertArtifactDescriptorV1(artifact({ byteLength: -1 }))).toThrow(/byteLength/i);
    expect(() => assertArtifactDescriptorV1(artifact({ sha256: 'bad' }))).toThrow(/sha256/i);
    expect(() => assertArtifactDescriptorV1(artifact({ mediaType: 'text/html\r\nx-bad: yes' }))).toThrow(/media type/i);
  });

  it('enforces aggregate part and UTF-8 text ceilings', () => {
    expect(() => assertModelToolResultV1({
      schemaVersion: 1,
      parts: Array.from({ length: MODEL_TOOL_RESULT_MAX_PARTS + 1 }, () => ({ type: 'text', text: 'x' })),
    })).toThrow(/parts/i);
    expect(() => assertModelToolResultV1({
      schemaVersion: 1,
      parts: [{ type: 'text', text: 'x'.repeat(MODEL_TOOL_RESULT_MAX_TEXT_BYTES + 1) }],
    })).toThrow(/text/i);
  });

  it('renders a bounded truthful text fallback without inline bytes', () => {
    const fallback = modelToolResultTextFallback(result());
    expect(fallback).toContain('Frame extracted.');
    expect(fallback).toContain('Image frame.png (image/png, 8 bytes) is available as structured tool output.');
    expect(fallback).toContain('Artifact Extracted frame (image/png, 8 bytes) is available at workspace path artifacts/frame.png.');
    expect(fallback).not.toContain(png.toString('base64'));
    expect(Buffer.byteLength(fallback)).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_TEXT_BYTES);
  });
});
