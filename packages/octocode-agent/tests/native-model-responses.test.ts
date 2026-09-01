import type { ModelDelta } from '@octocodeai/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { createOpenAiCompatibleModelPort, NATIVE_MODEL_PROTOCOL_SUPPORT } from '../src/native-model.js';

function responseFixture(
  usage: Record<string, unknown>,
  output: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id: 'resp-1',
    created_at: 1,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5',
    object: 'response',
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage,
  };
}

const usageFixture = {
  input_tokens: 8,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 5 },
  output_tokens: 3,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 11,
};

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('native OpenAI Responses model port', () => {
  it('maps ordered text and image parts without dropping bytes', async () => {
    const completed = { type: 'response.completed', response: responseFixture(usageFixture), sequence_number: 1 };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: unknown };
      expect(body.input).toEqual([{ role: 'user', content: [
        { type: 'input_text', text: 'before ' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        { type: 'input_text', text: ' after' },
      ] }]);
      return sse([completed]);
    });
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5', fetch,
    });
    await port.run({ messages: [{
      role: 'user', content: 'before  after', userInput: { schemaVersion: 1, parts: [
        { type: 'text', text: 'before ' },
        { type: 'image', mediaType: 'image/png', data: { encoding: 'base64', value: 'iVBORw0KGgo=' }, byteLength: 8 },
        { type: 'text', text: ' after' },
      ] },
    }] }, { signal: new AbortController().signal });
  });

  it('fails closed before fetch when multimodal text and payload disagree', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5', fetch,
    });
    await expect(port.run({ messages: [{
      role: 'user', content: 'different', userInput: { schemaVersion: 1, parts: [{ type: 'text', text: 'actual' }] },
    }] }, { signal: new AbortController().signal })).rejects.toThrow('does not match');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('defers credential validation until the first model request', async () => {
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: '', defaultModel: 'gpt-5',
    });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/OCTOCODE_MODEL_API_KEY|OPENAI_API_KEY/);
  });

  it('supports explicitly configured header-only Responses providers', async () => {
    const completed = {
      type: 'response.completed', response: responseFixture(usageFixture), sequence_number: 1,
    };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-provider-key')).toBe('header-secret');
      expect(headers.has('authorization')).toBe(false);
      return sse([completed]);
    });
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://responses.example/v1', apiKey: '', defaultModel: 'model-1',
      allowMissingApiKey: true, headers: { 'x-provider-key': 'header-secret' }, fetch,
    });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ stop: 'complete' });
  });

  it('streams typed text and reports only terminal Responses usage', async () => {
    const events = [
      {
        type: 'response.output_item.added', output_index: 0, sequence_number: 0,
        item: { type: 'message', id: 'message-1', status: 'in_progress', role: 'assistant', content: [] },
      },
      {
        type: 'response.output_text.delta',
        content_index: 0,
        delta: 'hello',
        item_id: 'message-1',
        logprobs: [],
        output_index: 0,
        sequence_number: 1,
      },
      {
        type: 'response.completed',
        response: responseFixture(usageFixture),
        sequence_number: 2,
      },
    ];
    const fetch = vi.fn(async () => sse(events));
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5', fetch,
    });
    const deltas: ModelDelta[] = [];

    const result = await port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } },
    );

    expect(deltas).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result).toEqual({
      stop: 'complete',
      usage: { inputTokens: 8, outputTokens: 3, cachedInputTokens: 5, cacheWriteInputTokens: 0 },
    });
  });

  it('emits a typed completed function call and serializes Responses history and tools', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'item-1',
      call_id: 'call-1',
      name: 'search',
      arguments: '{"q":"x"}',
      status: 'completed',
    };
    const events = [
      {
        type: 'response.output_item.added', output_index: 0, sequence_number: 0,
        item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'search', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        delta: '{"q":"x"}',
        item_id: 'item-1',
        output_index: 0,
        sequence_number: 1,
      },
      {
        type: 'response.output_item.done',
        item: functionCall,
        output_index: 0,
        sequence_number: 2,
      },
      {
        type: 'response.completed',
        response: responseFixture(usageFixture, [functionCall]),
        sequence_number: 3,
      },
    ];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'gpt-5',
        stream: true,
        tool_choice: { type: 'function', name: 'search' },
      });
      expect(body.tools).toEqual([
        expect.objectContaining({ type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' } }),
      ]);
      expect(body.input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: 'find' }] },
        { type: 'function_call', call_id: 'old-call', name: 'search', arguments: '{"q":"old"}' },
        { type: 'function_call_output', call_id: 'old-call', output: '{"ok":true}' },
      ]);
      return sse(events);
    });
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5', fetch,
    });
    const deltas: ModelDelta[] = [];

    const result = await port.run({
      messages: [
        { role: 'user', content: 'find' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'old-call', name: 'search', input: { q: 'old' } }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'old-call' },
      ],
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: { name: 'search' },
    }, { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } });

    expect(deltas).toEqual([{ type: 'tool-call', id: 'call-1', name: 'search', input: { q: 'x' } }]);
    expect(result.stop).toBe('tool');
  });

  it('uses a stable prompt cache key and disables SDK retries', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt_cache_key: 'octocode:stable-prefix' });
      return new Response('provider detail must stay private', { status: 500 });
    });
    const port = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5',
      promptCacheKey: 'octocode:stable-prefix', fetch,
    });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ category: 'provider', retry: 'safe' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps stream aborts to cancellation and explicit stream errors to provider failures', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const streamStarted = new Promise<void>((resolve) => { started = resolve; });
    const aborting = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5',
      fetch: async (_url, init) => new Response(new ReadableStream({
        start(stream) {
          started();
          init?.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const running = aborting.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: controller.signal },
    );
    await streamStarted;
    controller.abort();
    await expect(running).resolves.toEqual({ stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } });

    const errorEvent = {
      type: 'error',
      code: 'server_error',
      message: 'provider detail must stay private',
      param: null,
      sequence_number: 1,
    };
    const failing = createOpenAiCompatibleModelPort({
      protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-5',
      fetch: async () => sse([errorEvent]),
    });
    await expect(failing.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ category: 'provider' });
    await expect(failing.run(
      { messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal },
    )).rejects.not.toThrow(/provider detail/);
  });

  it('advertises Responses support only through the production factory', () => {
    expect(NATIVE_MODEL_PROTOCOL_SUPPORT.filter((entry) => entry.supported).map((entry) => entry.protocol))
      .toEqual(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);
  });
});
