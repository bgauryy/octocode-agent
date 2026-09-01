import { describe, expect, it } from 'vitest';

import {
  RuntimeKernel,
  ToolRegistry,
  sessionId,
  type ModelPort,
  type ModelToolResultV1,
  type ToolDefinition,
} from '../src/index.js';

const typedResult: ModelToolResultV1 = {
  schemaVersion: 1,
  parts: [
    { type: 'text', text: 'Created preview.' },
    {
      type: 'artifact',
      artifact: {
        schemaVersion: 1,
        artifactId: 'preview-1',
        kind: 'document',
        path: 'artifacts/preview.html',
        mediaType: 'text/html',
        byteLength: 42,
        sha256: 'a'.repeat(64),
        title: 'Preview',
      },
    },
  ],
};

function tool(name: string, content: unknown): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    schemaVersion: 1,
    inputSchema: { type: 'object' },
    outputSchema: {},
    outputVersion: 1,
    policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
    execute: async () => ({ ok: true, content, detailsVersion: 1 }),
  };
}

describe('runtime typed artifact tool results', () => {
  it('attaches parser-validated structured content beside the legacy bounded string in provider order', async () => {
    let iteration = 0;
    const model: ModelPort = {
      run: async (request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'typed-call', name: 'typed', input: {} });
          await context.emit?.({ type: 'tool-call', id: 'legacy-call', name: 'legacy', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        const messages = request.messages.slice(-2);
        expect(messages).toEqual([
          {
            role: 'tool',
            toolCallId: 'typed-call',
            content: JSON.stringify({ ok: true, content: typedResult, detailsVersion: 1 }),
            result: typedResult,
          },
          {
            role: 'tool',
            toolCallId: 'legacy-call',
            content: JSON.stringify({ ok: true, content: { legacy: true }, detailsVersion: 1 }),
          },
        ]);
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(tool('typed', typedResult), 'builtin');
    tools.register(tool('legacy', { legacy: true }), 'builtin');

    await new RuntimeKernel({ sessionId: sessionId('s-artifact-result'), model, tools }).submit('go');
    expect(iteration).toBe(2);
  });
});
