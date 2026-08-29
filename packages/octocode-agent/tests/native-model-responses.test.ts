import type { ModelDelta } from '@octocodeai/agent-core';
import type * as Responses from 'openai/resources/responses/responses';
import { describe, expect, it, vi } from 'vitest';

import { createOpenAiCompatibleModelPort, NATIVE_MODEL_PROTOCOL_SUPPORT } from '../src/native-model.js';

function responseFixture(
  usage: Responses.ResponseUsage,
  output: Responses.ResponseOutputItem[] = [],
): Responses.Response {
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
} satisfies Responses.ResponseUsage;

function sse(events: readonly Responses.ResponseStreamEvent[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('native OpenAI Responses model port', () => {
  it('streams typed text and reports only terminal Responses usage', async () => {
    const events = [
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
    ] satisfies Responses.ResponseStreamEvent[];
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
    } satisfies Responses.ResponseFunctionToolCall;
    const events = [
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
    ] satisfies Responses.ResponseStreamEvent[];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: 'gpt-5',
        stream: true,
        tool_choice: { type: 'function', name: 'search' },
        tools: [{ type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' }, strict: false }],
      });
      expect(body.input).toEqual([
        { type: 'message', role: 'user', content: 'find' },
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
    } satisfies Responses.ResponseErrorEvent;
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
