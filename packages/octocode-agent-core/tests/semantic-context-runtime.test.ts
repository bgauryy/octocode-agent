import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeKernel,
  sessionId,
  type LifecycleDispatchResult,
  type ModelRequest,
  type SemanticContextManifestV1,
} from '../src/index.js';

const textUserInput = (text: string) => ({
  schemaVersion: 1 as const,
  parts: [{ type: 'text' as const, text }],
});

const semanticManifest = (query: string): SemanticContextManifestV1 => ({
  schemaVersion: 1,
  query,
  generatedAt: 100,
  slices: [{
    schemaVersion: 1,
    id: `symbol:${query}`,
    kind: 'symbol',
    content: `symbol for ${query}`,
    provenance: {
      workspaceRoot: '/workspace',
      path: 'src/example.ts',
      range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 10 },
      sha256: 'b'.repeat(64),
      proof: 'lsp',
      tool: 'lspGetSemantics',
      observedAt: 99,
      complete: true,
    },
    freshness: { state: 'fresh', checkedAt: 100, documentVersion: 'sha256:source' },
  }],
  degradations: [],
});

describe('runtime semantic context placement', () => {
  it('projects one ephemeral untrusted map before the current user input on each turn', async () => {
    const requests: ModelRequest[] = [];
    const prepare = vi.fn(async ({ query }: { query: string }) => semanticManifest(query));
    const kernel = new RuntimeKernel({
      sessionId: sessionId('semantic-context-runtime'),
      cwd: '/workspace',
      semanticContext: { provider: { prepare }, maxTokens: 4_096 },
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
    });

    await kernel.submit('first request');
    await kernel.submit('second request');

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ schemaVersion: 1, query: 'first request', workspaceRoot: '/workspace', iteration: 0 }),
      expect.objectContaining({ schemaVersion: 1, query: 'second request', workspaceRoot: '/workspace', iteration: 0 }),
    ]);
    const first = requests[0]!.messages;
    const second = requests[1]!.messages;
    const semantic = (request: ModelRequest) => request.messages.filter(({ content }) => content.includes('<semantic_context '));
    expect(semantic(requests[0]!)).toHaveLength(1);
    expect(semantic(requests[1]!)).toHaveLength(1);
    expect(first.findIndex(({ content }) => content.includes('<semantic_context ')))
      .toBeLessThan(first.findIndex(({ content }) => content === 'first request'));
    expect(second.findIndex(({ content }) => content.includes('<semantic_context ')))
      .toBeLessThan(second.findIndex(({ content }) => content === 'second request'));
    expect(second.filter(({ content }) => content.includes('<semantic_context '))).toHaveLength(1);
    expect(second.some(({ content }) => content.includes('symbol for first request'))).toBe(false);
  });

  it('drops malformed provider data without poisoning the model turn', async () => {
    const run = vi.fn(async (_request: ModelRequest) => ({ stop: 'complete' as const, usage: { inputTokens: 0, outputTokens: 0 } }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId('semantic-context-malformed'),
      cwd: '/workspace',
      semanticContext: { provider: { prepare: async () => ({ schemaVersion: 999 }) }, maxTokens: 1_024 },
      model: { run },
    });

    await expect(kernel.submit('continue safely')).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].messages).toEqual([
      {
        role: 'user',
        content: 'continue safely',
        userInput: textUserInput('continue safely'),
      },
    ]);
  });

  it('cancels a turn while semantic preparation is pending and never calls the model', async () => {
    let providerSignal: AbortSignal | undefined;
    const run = vi.fn(async (_request: ModelRequest) => ({ stop: 'complete' as const, usage: { inputTokens: 0, outputTokens: 0 } }));
    const kernel = new RuntimeKernel({
      sessionId: sessionId('semantic-context-cancel'),
      cwd: '/workspace',
      semanticContext: {
        provider: {
          prepare: async (request) => {
            providerSignal = request.signal;
            return await new Promise<never>(() => undefined);
          },
        },
      },
      model: { run },
    });

    const turn = kernel.submit('cancel context preparation');
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    await kernel.cancel('test cancellation');
    await expect(turn).resolves.toBeUndefined();

    expect(providerSignal?.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the stable current-turn position when lifecycle preparation rewrites user text', async () => {
    const requests: ModelRequest[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('semantic-context-rewrite'),
      cwd: '/workspace',
      semanticContext: { provider: { prepare: async () => semanticManifest('ask') } },
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type !== 'context.preparing') return;
        const payload = event.payload as { iteration: number; messages: ModelRequest['messages'] };
        return {
          payload: {
            ...payload,
            messages: payload.messages.map((message, index) => index === payload.messages.length - 1
              ? { ...message, content: 'rewritten ask' }
              : message),
          },
          decision: { kind: 'continue' },
          context: [],
          suppressed: false,
          receipts: [],
        };
      },
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
    });

    await kernel.submit('ask');

    expect(requests[0]?.messages.map(({ content }) => content)).toEqual([
      expect.stringContaining('<semantic_context '),
      'rewritten ask',
    ]);
  });

  it('passes an explicit tiny budget through unchanged and omits enrichment', async () => {
    const prepare = vi.fn(async () => semanticManifest('tiny'));
    const requests: ModelRequest[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('semantic-context-tiny-budget'),
      cwd: '/workspace',
      semanticContext: { provider: { prepare }, maxTokens: 1 },
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
    });

    await kernel.submit('tiny');

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ budget: { maxTokens: 1 } }));
    expect(requests[0]?.messages).toEqual([{
      role: 'user',
      content: 'tiny',
      userInput: textUserInput('tiny'),
    }]);
  });
});
