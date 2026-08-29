import { describe, expect, it } from 'vitest';

import { createOpenAiCompatibleModelPort } from '../src/native-model.js';

describe('native model streamed tool-call ordering', () => {
  it('emits finalized tool calls in provider index order when chunks arrive out of order', async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-b","function":{"name":"beta","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"alpha","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    ].join('\n') + '\n';
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'secret',
      defaultModel: 'model',
      fetch: async () => new Response(body, { status: 200 }),
    });
    const deltas: unknown[] = [];

    const result = await port.run(
      { messages: [{ role: 'user', content: 'run both' }] },
      { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } },
    );

    expect(result.stop).toBe('tool');
    expect(deltas).toEqual([
      { type: 'tool-call', id: 'call-a', name: 'alpha', input: {} },
      { type: 'tool-call', id: 'call-b', name: 'beta', input: {} },
    ]);
  });
});
