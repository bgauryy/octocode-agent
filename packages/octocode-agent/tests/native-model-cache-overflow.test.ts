import { describe, expect, it, vi } from 'vitest';

import {
  createAnthropicMessagesModelPort,
  createOpenAiCompatibleModelPort,
  NativeModelInputOverflowFailure,
} from '../src/native-model.js';

const signal = new AbortController().signal;

function anthropicResponse(): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('native provider cache and overflow normalization', () => {
  it('keeps the Anthropic cache breakpoint on the stable prompt prefix after compaction', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return anthropicResponse();
    });
    const port = createAnthropicMessagesModelPort({
      endpoint: 'https://api.anthropic.com/v1',
      apiKey: 'secret',
      defaultModel: 'claude-test',
      promptCaching: true,
      fetch,
    });

    await port.run({
      messages: [
        { role: 'system', content: 'stable product and repository policy' },
        { role: 'user', content: 'before compaction' },
      ],
    }, { signal });
    await port.run({
      messages: [
        { role: 'system', content: 'stable product and repository policy' },
        { role: 'system', content: 'Conversation summary:\nchanging summary' },
        { role: 'user', content: 'retained tail' },
      ],
    }, { signal });

    const before = requests[0]?.['system'] as Array<Record<string, unknown>>;
    const after = requests[1]?.['system'] as Array<Record<string, unknown>>;
    expect(before[0]).toMatchObject({ text: 'stable product and repository policy', cache_control: { type: 'ephemeral' } });
    expect(after[0]).toMatchObject({ text: 'stable product and repository policy', cache_control: { type: 'ephemeral' } });
    expect(after[1]).toMatchObject({ text: 'Conversation summary:\nchanging summary' });
    expect(after[1]).not.toHaveProperty('cache_control');
  });

  it('normalizes identifiable OpenAI and Anthropic input overflow responses', async () => {
    const openai = createOpenAiCompatibleModelPort({
      endpoint: 'https://api.openai.com/v1', apiKey: 'secret', defaultModel: 'gpt-test', stream: false,
      fetch: async () => new Response(JSON.stringify({
        error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'maximum context length exceeded' },
      }), { status: 400, headers: { 'content-type': 'application/json' } }),
    });
    const anthropic = createAnthropicMessagesModelPort({
      endpoint: 'https://api.anthropic.com/v1', apiKey: 'secret', defaultModel: 'claude-test',
      fetch: async () => new Response(JSON.stringify({
        type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 200001 tokens > 200000 maximum' },
      }), { status: 400, headers: { 'content-type': 'application/json' } }),
    });

    for (const [provider, run] of [
      ['openai', () => openai.run({ messages: [{ role: 'user', content: 'large' }] }, { signal })],
      ['anthropic', () => anthropic.run({ messages: [{ role: 'user', content: 'large' }] }, { signal })],
    ] as const) {
      const failure = run();
      await expect(failure).rejects.toBeInstanceOf(NativeModelInputOverflowFailure);
      await expect(failure).rejects.toMatchObject({
        category: 'provider',
        provider,
        safeCause: 'input-overflow',
        retry: 'unsafe',
      });
      await expect(failure).rejects.not.toThrow(/200001|maximum context length/);
    }
  });
});
