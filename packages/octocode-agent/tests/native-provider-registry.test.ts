import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('does not treat environment model/protocol/endpoint values as a discoverable model source', () => {
    const resolved = resolveNativeModelConfiguration({
      env: {
        OCTOCODE_MODEL: 'deployment-model',
        OCTOCODE_MODEL_PROTOCOL: 'openai-chat-completions',
        OCTOCODE_MODEL_ENDPOINT: 'http://127.0.0.1:11434/v1',
      },
      configuredProvider: 'anthropic',
      configuredModel: 'claude-custom',
    });

    expect(resolved.selection).toEqual({ providerId: 'anthropic', modelId: 'claude-custom' });
    expect(resolved.endpoint).toBe('https://api.anthropic.com/v1');
    expect(resolved.protocol).toBe('anthropic-messages');
    expect(resolved.catalog.sources.map(({ id }) => id)).toEqual([
      'native.settings',
      'native.canonical',
    ]);
    expect(resolved.catalog.sources).not.toContainEqual(expect.objectContaining({ kind: 'runtime' }));
  });

  it('allows an explicit CLI selection to override environment and persisted defaults without mutating discovery sources', () => {
    const resolved = resolveNativeModelConfiguration({
      env: {
        OCTOCODE_MODEL: 'environment-model',
        OCTOCODE_MODEL_PROTOCOL: 'openai-responses',
      },
      configuredProvider: 'anthropic',
      configuredModel: 'claude-cli',
      configuredSelectionSource: 'cli.override',
      forceConfiguredSelection: true,
    });

    expect(resolved.selection).toEqual({ providerId: 'anthropic', modelId: 'claude-cli' });
    expect(resolved.selectionSource).toBe('cli.override');
    expect(resolved.protocol).toBe('anthropic-messages');
  });

  it('merges filesystem sources and selects a discovered custom provider with deterministic precedence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-provider-discovery-'));
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode');
    const cwd = path.join(root, 'workspace');
    const file = path.join(octocodeHome, 'agent', 'models.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ providers: { local: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: '$LOCAL_KEY', promptCaching: { mode: 'disabled' }, models: [{ id: 'qwen-local' }] } } }));

    const resolved = resolveNativeModelConfiguration({
      env: {}, cwd, home, octocodeHome,
      configuredProvider: 'local',
      configuredModel: 'qwen-local',
    });

    expect(resolved.selection).toEqual({ providerId: 'local', modelId: 'qwen-local' });
    expect(resolved.protocol).toBe('openai-chat-completions');
    expect(resolved.endpoint).toBe('http://localhost:11434/v1');
    expect(resolved.promptCaching).toBe('disabled');
    expect(resolved.catalog.sources.map(({ id, precedence }) => [id, precedence])).toEqual([
      ['native.settings', 60],
      ['native.global', 30],
      ['native.canonical', 10],
    ]);
    expect(resolved.catalog.providers.find(({ id }) => id === 'local')).toMatchObject({
      sourceId: 'native.settings', credential: { type: 'environment', name: 'LOCAL_KEY' },
    });
  });

  it('normalizes Anthropic text, thinking, tools, usage, history, caching, and stop reason', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('anthropic-secret');
      expect(headers['x-session-affinity']).toBe('session-123');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: 'claude-test', stream: true, thinking: { type: 'enabled', budget_tokens: 1024 },
        tool_choice: { type: 'tool', name: 'search' },
        tools: [
          { name: 'search', description: 'Search', input_schema: { type: 'object' } },
          {
            name: 'worker',
            description: 'Worker',
            input_schema: {
              type: 'object',
              required: ['action'],
              properties: { action: { type: 'string', enum: ['list'] } },
            },
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
      expect(body.system).toEqual([{ type: 'text', text: 'stable system', cache_control: { type: 'ephemeral' } }]);
      expect(body.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'find' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'old-call', name: 'search', input: { q: 'old' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: '{"ok":true}', cache_control: { type: 'ephemeral' } }] },
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
      protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1', apiKey: 'anthropic-secret', defaultModel: 'claude-test', fetch, promptCaching: true, sessionAffinityId: 'session-123',
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
      tools: [
        { name: 'search', description: 'Search', inputSchema: { type: 'object' } },
        {
          name: 'worker',
          description: 'Worker',
          inputSchema: { oneOf: [{ type: 'object', properties: { action: { const: 'list' } }, required: ['action'] }] },
        },
      ],
      toolChoice: { name: 'search' },
    }, { signal: new AbortController().signal, emit: async (delta) => { deltas.push(delta); } });
    expect(deltas).toEqual([
      { type: 'thinking', text: 'reason' },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', id: 'call-1', name: 'search', input: { q: 'x' } },
    ]);
    expect(result).toEqual({ stop: 'tool', usage: { inputTokens: 18, outputTokens: 4, cachedInputTokens: 6, cacheWriteInputTokens: 2 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the Anthropic thinking budget below the effective output limit', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens: number; thinking: { budget_tokens: number } };
      expect(body.max_tokens).toBe(body.thinking.budget_tokens + 4_096);
      return anthropicSse([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    });
    const port = createNativeProviderModelPort({
      protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1', apiKey: 'anthropic-secret', defaultModel: 'claude-test', fetch,
    });

    for (const thinkingLevel of ['high', 'xhigh'] as const) {
      await port.run(
        { messages: [{ role: 'user', content: 'think' }], thinkingLevel },
        { signal: new AbortController().signal },
      );
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('adds the thinking budget to an explicit Anthropic answer-token limit', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens: number; thinking: { budget_tokens: number } };
      expect(body).toMatchObject({ max_tokens: 10_240, thinking: { budget_tokens: 8_192 } });
      return anthropicSse([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    });
    const port = createNativeProviderModelPort({
      protocol: 'anthropic-messages', endpoint: 'https://api.anthropic.com/v1', apiKey: 'anthropic-secret', defaultModel: 'claude-test', fetch, maxOutputTokens: 2_048,
    });

    await port.run(
      { messages: [{ role: 'user', content: 'think' }], thinkingLevel: 'high' },
      { signal: new AbortController().signal },
    );
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

  it('supports explicitly configured header-only Anthropic-compatible providers', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer delegated-token' });
      expect(init?.headers).not.toHaveProperty('x-api-key');
      return anthropicSse([
        { type: 'message_start', message: { usage: { input_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]);
    });
    const port = createNativeProviderModelPort({
      protocol: 'anthropic-messages', endpoint: 'https://compatible.test/v1', apiKey: '', defaultModel: 'model-1', fetch,
      allowMissingApiKey: true, headers: { Authorization: 'Bearer delegated-token' },
    });

    await expect(port.run(
      { messages: [{ role: 'user', content: 'hello' }] },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ stop: 'complete' });
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
