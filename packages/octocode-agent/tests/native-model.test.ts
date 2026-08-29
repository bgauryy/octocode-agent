import { describe, expect, it, vi } from 'vitest';

import { createOpenAiCompatibleModelPort, NATIVE_MODEL_PROTOCOL_SUPPORT } from '../src/native-model.js';

describe('native OpenAI-compatible model port', () => {
  it('publishes an explicit fail-closed protocol support ledger', () => {
      expect(NATIVE_MODEL_PROTOCOL_SUPPORT.filter((entry) => entry.supported).map((entry) => entry.protocol))
        .toEqual(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);
    expect(NATIVE_MODEL_PROTOCOL_SUPPORT.filter((entry) => !entry.supported).every((entry) => Boolean(entry.reason))).toBe(true);
  });

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
        usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 2 } },
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
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });

  it('classifies provider failures without exposing response bodies', async () => {
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'secret',
      defaultModel: 'model-1',
      fetch: async () => new Response('upstream secret detail', { status: 429, headers: { 'retry-after': '2' } }),
      stream: false,
    });

    const failure = port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );
    await expect(failure).rejects.toMatchObject({ category: 'provider', retry: 'safe', retryAfterMs: 2_000 });
    await expect(failure).rejects.not.toThrow(/upstream secret detail/);
  });

  it('normalizes cancellation after streaming response headers', async () => {
    const controller = new AbortController();
    let emitted!: () => void;
    const firstDelta = new Promise<void>((resolve) => { emitted = resolve; });
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm',
      fetch: async (_url, init) => new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n'));
          init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
        },
      }), { status: 200 }),
    });
    const deltas: unknown[] = [];
    const running = port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: controller.signal, emit: async (delta) => { deltas.push(delta); emitted(); } },
    );
    await firstDelta;
    controller.abort('stop');

    await expect(running).resolves.toEqual({ stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(deltas).toEqual([{ type: 'text', text: 'partial' }]);
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

  it('consumes a final SSE record without a trailing newline', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"final"},"finish_reason":"stop"}]}';
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'secret',
      defaultModel: 'm',
      fetch: async () => new Response(body, { status: 200 }),
    });
    const deltas: unknown[] = [];

    const result = await port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } },
    );

    expect(deltas).toEqual([{ type: 'text', text: 'final' }]);
    expect(result.stop).toBe('complete');
  });

  it('rejects malformed streaming frames and tool arguments without echoing them', async () => {
    const malformedFrame = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'secret',
      defaultModel: 'm',
      fetch: async () => new Response('data: {secret-bad-json}\n', { status: 200 }),
    });
    await expect(malformedFrame.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow('Malformed model provider stream frame');

    const malformedTool = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1',
      apiKey: 'secret',
      defaultModel: 'm',
      stream: false,
      fetch: async () => new Response(JSON.stringify({
        choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'search', arguments: '{secret-bad-json}' } }] }, finish_reason: 'tool_calls' }],
      }), { status: 200 }),
    });
    await expect(malformedTool.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow('Malformed model tool arguments');
  });

  it('rejects unsupported thinking controls before sending provider bytes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const port = createOpenAiCompatibleModelPort({ endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm', fetch });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hi' }], thinkingLevel: 'high' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/thinking/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects incomplete and inconsistently indexed streaming tool calls', async () => {
    const incomplete = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm',
      fetch: async () => new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n', { status: 200 }),
    });
    await expect(incomplete.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/tool call/i);

    const conflicting = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm',
      fetch: async () => new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
      ].join('\n') + '\n', { status: 200 }),
    });
    await expect(conflicting.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/inconsistent/i);
  });

  it('does not classify an unterminated stream without a finish reason as complete', async () => {
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://example.test/v1', apiKey: 'secret', defaultModel: 'm',
      fetch: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n', { status: 200 }),
    });
    const result = await port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    );
    expect(result.stop).toBe('error');
  });

  it('sends an explicit stable prompt-cache routing key when configured', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt_cache_key: 'octocode:stable-prefix' });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1 } },
      }), { status: 200 });
    });
    const port = createOpenAiCompatibleModelPort({
      endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'm',
      stream: false, promptCacheKey: 'octocode:stable-prefix', fetch,
    });

    await expect(port.run(
      { messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ usage: { cachedInputTokens: 1 } });
  });
});
