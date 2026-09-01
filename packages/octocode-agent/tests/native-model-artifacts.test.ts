import { describe, expect, it } from 'vitest';

import type { ModelRequest } from '@octocodeai/agent-core';

import { translateNativeModelMessages } from '../src/native-model.js';

const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

const request = (): ModelRequest => ({
  messages: [
    { role: 'user', content: 'inspect it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'readMedia', input: { path: 'clip.mp4' } }] },
    {
      role: 'tool',
      toolCallId: 'call-1',
      content: 'Frame extracted with a durable artifact.',
      result: {
        schemaVersion: 1,
        parts: [
          { type: 'text', text: 'Frame extracted.' },
          {
            type: 'image', mediaType: 'image/png',
            data: { encoding: 'base64', value: pngBase64 }, byteLength: 8, filename: 'frame.png',
          },
          {
            type: 'artifact',
            artifact: {
              schemaVersion: 1, artifactId: 'frame-1', kind: 'image', path: 'artifacts/frame.png',
              mediaType: 'image/png', byteLength: 8, sha256: 'a'.repeat(64), title: 'Frame 1',
            },
          },
        ],
      },
    },
  ],
});

describe('native typed tool-result translation', () => {
  it.each(['openai-responses', 'anthropic-messages'] as const)(
    'carries inline images for %s and converts artifact handles to explicit text',
    (protocol) => {
      const translated = translateNativeModelMessages(request(), { protocol });
      const tool = translated.at(-1) as { content: Array<{ output: unknown }> };
      expect(tool.content[0]?.output).toEqual({
        type: 'content',
        value: [
          { type: 'text', text: 'Frame extracted.' },
          {
            type: 'file', data: { type: 'data', data: pngBase64 },
            mediaType: 'image/png', filename: 'frame.png',
          },
          {
            type: 'text',
            text: 'Artifact Frame 1 (image/png, 8 bytes) is available at workspace path artifacts/frame.png; its bytes are not attached.',
          },
        ],
      });
    },
  );

  it('degrades Chat Completions images to bounded truthful text without base64', () => {
    const translated = translateNativeModelMessages(request(), { protocol: 'openai-chat-completions' });
    const tool = translated.at(-1) as { content: Array<{ output: { type: string; value: string } }> };
    const output = tool.content[0]!.output;
    expect(output.type).toBe('text');
    expect(output.value).toContain('Frame extracted.');
    expect(output.value).toContain('Image frame.png (image/png, 8 bytes) was not attached because openai-chat-completions does not support image tool results.');
    expect(output.value).toContain('Artifact Frame 1');
    expect(output.value).not.toContain(pngBase64);
    expect(Buffer.byteLength(output.value)).toBeLessThanOrEqual(1_048_576);
  });

  it('preserves legacy string-only tool results', () => {
    const legacy: ModelRequest = {
      messages: [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-legacy', name: 'legacy', input: {} }] },
        { role: 'tool', toolCallId: 'call-legacy', content: '{"ok":true}' },
      ],
    };
    const translated = translateNativeModelMessages(legacy, { protocol: 'openai-responses' });
    const tool = translated.at(-1) as { content: Array<{ output: unknown }> };
    expect(tool.content[0]?.output).toEqual({ type: 'text', value: '{"ok":true}' });
  });
});
