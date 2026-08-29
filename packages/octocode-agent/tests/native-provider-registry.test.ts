import { describe, expect, it, vi } from 'vitest';
import type { ModelDelta } from '@octocodeai/agent-core';
import {
  createNativeProviderModelPort,
  resolveNativeModelConfiguration,
  resolveNativeProviderProtocol,
  supportedNativeProviderProtocols,
} from '../src/native-provider-registry.js';
import { runNativeProviderSmoke } from '../src/native-provider-smoke.js';

function anthropicSse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('native provider registry', () => {
  it('selects only real protocol adapters deterministically', () => {
    expect(supportedNativeProviderProtocols()).toEqual(['anthropic-messages', 'openai-chat-completions', 'openai-responses']);
    expect(resolveNativeProviderProtocol({ endpoint: 'https://api.openai.com/v1' })).toBe('openai-responses');
    expect(resolveNativeProviderProtocol({ endpoint: 'https://compatible.test/v1' })).toBe('openai-chat-completions');
    expect(resolveNativeProviderProtocol({ endpoint: 'https://api.anthropic.com/v1', requested: 'anthropic-messages' })).toBe('anthropic-messages');
    expect(() => resolveNativeProviderProtocol({ endpoint: 'https://example.test', requested: 'fake-provider' })).toThrow(/unsupported/i);
  });

  it('composes canonical and persisted model sources before selecting a default', () => {
    const resolved = resolveNativeModelConfiguration({
      env: {},
      configuredProvider: 'anthropic',
      configuredModel: 'claude-custom',
    });

    expect(resolved.selection).toEqual({ providerId: 'anthropic', modelId: 'claude-custom' });
    expect(resolved.protocol).toBe('anthropic-messages');
    expect(resolved.endpoint).toBe('https://api.anthropic.com/v1');
    expect(resolved.catalog.sources.map(({ id }) => id)).toEqual([
      'native.settings',
      'native.canonical',
    ]);
    expect(resolved.catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'openai', id: 'gpt-5', sourceId: 'native.canonical' }),
      expect.objectContaining({ providerId: 'anthropic', id: 'claude-sonnet-4-5', sourceId: 'native.canonical' }),
      expect.objectContaining({ providerId: 'anthropic', id: 'claude-custom', sourceId: 'native.settings' }),
    ]));
    expect(resolved.catalog.defaultModel).toEqual(resolved.selection);
  });

  it('gives environment model/protocol/endpoint explicit precedence while retaining a real source ledger', () => {
    const resolved = resolveNativeModelConfiguration({
      env: {
        OCTOCODE_MODEL: 'deployment-model',
        OCTOCODE_MODEL_PROTOCOL: 'openai-chat-completions',
        OCTOCODE_MODEL_ENDPOINT: 'http://127.0.0.1:11434/v1',
      },
      configuredProvider: 'anthropic',
      configuredModel: 'claude-custom',
    });

    expect(resolved.selection).toEqual({ providerId: 'openai', modelId: 'deployment-model' });
    expect(resolved.endpoint).toBe('http://127.0.0.1:11434/v1');
    expect(resolved.protocol).toBe('openai-chat-completions');
    expect(resolved.catalog.sources.map(({ id }) => id)).toEqual([
      'native.environment',
      'native.settings',
      'native.canonical',
    ]);
    expect(resolved.catalog.providers).toContainEqual(expect.objectContaining({
      id: 'openai',
      endpoint: 'http://127.0.0.1:11434/v1',
      sourceId: 'native.environment',
    }));
  });

  it('normalizes Anthropic text, thinking, tools, usage, history, caching, and stop reason', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('anthropic-secret');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'claude-test', stream: true, thinking: { type: 'enabled', budget_tokens: 1024 },
        tool_choice: { type: 'tool', name: 'search' },
        tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' } }],
      });
      expect(body.system).toEqual([{ type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } }]);
      expect(body.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'find' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'old-call', name: 'search', input: { q: 'old' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: '{"ok":true}' }] },
      ]);
      return anthropicSse([
        { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'search', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]);
    });
    const port = createNativeProviderModelPort({
      protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1', apiKey: 'anthropic-secret', defaultModel: 'claude-test', fetch, promptCaching: true,
    });
    const deltas: ModelDelta[] = [];
    const result = await port.run({
      messages: [
        { role: 'system', content: 'stable system' },
        { role: 'user', content: 'find' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'old-call', name: 'search', input: { q: 'old' } }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'old-call' },
      ],
      thinkingLevel: 'low',
      tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
      toolChoice: { name: 'search' },
    }, { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } });
    expect(deltas).toEqual([
      { type: 'thinking', text: 'reason' },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', id: 'call-1', name: 'search', input: { q: 'x' } },
    ]);
    expect(result).toEqual({ stop: 'tool', usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 6, cacheWriteInputTokens: 2 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sanitizes provider failures and never serializes endpoint or credentials', async () => {
    const fetch = vi.fn(async () => new Response('anthropic-secret https://secret.example', { status: 429, headers: { 'retry-after': '2' } }));
    const port = createNativeProviderModelPort({ protocol: 'anthropic-messages', endpoint: 'https://secret.example/v1', apiKey: 'anthropic-secret', defaultModel: 'claude-test', fetch });
    let failure: unknown;
    try { await port.run({ messages: [{ role: 'user', content: 'hi' }] }, { signal: new AbortController().signal }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ category: 'provider', retry: 'safe', retryAfterMs: 2_000 });
    expect(JSON.stringify(failure)).not.toMatch(/anthropic-secret|secret\.example/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports credential absence as SKIP and a completed adapter probe as PASS', async () => {
    await expect(runNativeProviderSmoke({ protocol: 'anthropic-messages', apiKey: '', endpoint: 'https://api.anthropic.com/v1', model: 'claude-test' }))
      .resolves.toEqual({ status: 'SKIP', capability: 'credentials-absent', protocol: 'anthropic-messages' });
    await expect(runNativeProviderSmoke({
      protocol: 'openai-responses', apiKey: 'redacted', endpoint: 'https://api.openai.com/v1', model: 'gpt-test',
      port: { run: async () => ({ stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }) },
    })).resolves.toEqual({ status: 'PASS', protocol: 'openai-responses', stop: 'complete' });
  });
});
