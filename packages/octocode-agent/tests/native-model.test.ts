import { describe, expect, it, vi } from 'vitest';

import { createOpenAiCompatibleModelPort } from '../src/native-model.js';

describe('native OpenAI-compatible model port', () => {
  it('defers missing credential failure until a model request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: '',
      defaultModel: 'model-1',
      fetch,
    });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow('Set OCTOCODE_MODEL_API_KEY or OPENAI_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes a non-stream response and keeps credentials out of results', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-secret' });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'synthetic-secret',
      defaultModel: 'model-1',
      fetch,
      stream: false,
    });
    const deltas: unknown[] = [];
    const result = await port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } },
    );

    expect(deltas).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result).toEqual({
      stop: 'complete',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('classifies provider failures without exposing response bodies', async () => {
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'secret',
      defaultModel: 'model-1',
      fetch: async () => new Response('upstream secret detail', { status: 429 }),
      stream: false,
    });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/429/);
  });

  it('serializes tool schemas and normalizes provider tool calls', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'search' } });
      return new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'search', arguments: '{"q":"x"}' } }] }, finish_reason: 'tool_calls' }],
      }), { status: 200 });
    });
    const port = createOpenAiCompatibleModelPort({ endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm', fetch, stream: false });
    const deltas: unknown[] = [];
    const result = await port.run({
      messages: [{ role: 'user', content: 'find' }],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: 'auto',
    }, { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } });
    expect(deltas).toEqual([{ type: 'tool-call', id: 'call-1', name: 'search', input: { q: 'x' } }]);
    expect(result.stop).toBe('tool');
  });

  it('serializes assistant tool-call history and correlated tool results', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toEqual([
        { role: 'user', content: 'find' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1' },
      ]);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }), { status: 200 });
    });
    const port = createOpenAiCompatibleModelPort({ endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm', fetch, stream: false });
    await port.run({ messages: [
      { role: 'user', content: 'find' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'search', input: { q: 'x' } }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call-1' },
    ] }, { signal: new AbortController().signal });
  });
});
