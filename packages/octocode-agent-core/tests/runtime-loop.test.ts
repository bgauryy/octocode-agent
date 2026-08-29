import { describe, expect, it, vi } from 'vitest';
import { InMemoryEffectLedger, LiveRuntimePlanState, PolicyChain, RuntimeFailure, RuntimeKernel, ToolRegistry, jsonSchemaError, sessionId, turnId, type LifecycleDispatchResult, type ModelPort, type ModelRequest, type RuntimeEvent, type ToolDefinition } from '../src/index.js';
const definition = (execute: () => Promise<unknown>, name = 'lookup'): ToolDefinition => ({ name, label: name, description: name, schemaVersion: 1, inputSchema: { type: 'object' }, outputSchema: {}, outputVersion: 1, policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' }, execute: async () => ({ ok: true, content: await execute(), detailsVersion: 1 }) });
describe('bounded model/tool loop', () => {
  it('enforces an independent turn deadline and reports timeout distinctly from user cancellation', async () => {
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async () => await new Promise<never>(() => undefined) };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-turn-deadline'),
      model,
      turnTimeoutMs: 10,
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('wait forever');

    expect(kernel.snapshot().state).toBe('ready');
    expect(events.find((event) => event.type === 'turn.ended')?.payload).toMatchObject({ stop: 'timeout' });
  });

  it('lists composed tools through safe, sorted runtime metadata', async () => {
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'zeta'),
      label: 'Zeta tool',
      description: 'Runs zeta',
      policy: { effects: ['write'], trust: 'workspace', approval: 'on-request', plan: 'required' },
    }, 'private-owner');
    tools.register({
      ...definition(async () => undefined, 'alpha'),
      label: 'Alpha tool',
      description: 'Runs alpha',
      policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
    }, 'private-owner');
    const kernel = new RuntimeKernel({ sessionId: sessionId('s-tools-list'), model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) }, tools });

    await expect(kernel.execute({ type: 'tools.list' })).resolves.toEqual({
      ok: true,
      data: [
        {
          name: 'alpha', label: 'Alpha tool', description: 'Runs alpha',
          policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
        },
        {
          name: 'zeta', label: 'Zeta tool', description: 'Runs zeta',
          policy: { effects: ['write'], trust: 'workspace', approval: 'on-request', plan: 'required' },
        },
      ],
    });
  });

  it('runs policy before one effect and feeds the result into the next request', async () => { let calls = 0; const requests: number[] = []; const model: ModelPort = { run: async (request, context) => { requests.push(request.messages.length); if (requests.length === 1) { expect(request.tools?.[0]?.name).toBe('lookup'); await context.emit?.({ type: 'tool-call', id: 'call-1', name: 'lookup', input: { q: 1 } }); return { stop: 'tool', usage: { inputTokens: 1, outputTokens: 1 } }; } expect(request.messages.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call-1', name: 'lookup', input: { q: 1 } }] }); expect(request.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call-1' }); return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }; } }; const tools = new ToolRegistry(); tools.register(definition(async () => { calls += 1; return { answer: 1 }; }), 'builtin'); const events: string[] = []; const kernel = new RuntimeKernel({ sessionId: sessionId('s'), model, tools, emit: async (event) => { events.push(event.type); } }); await kernel.submit('go'); expect(calls).toBe(1); expect(requests).toEqual([1, 3]); expect(events).toContain('tool.started'); expect(events).toContain('tool.ended'); expect(kernel.snapshot().usage).toEqual({ inputTokens: 2, outputTokens: 2 }); });

  it('uses host-owned durable turn identities so resumed call ids do not collide', async () => {
    const ledger = new InMemoryEffectLedger(() => 1);
    const tools = new ToolRegistry();
    let effects = 0;
    tools.register(definition(async () => { effects += 1; return { effects }; }), 'builtin');
    const runtime = (identity: string): RuntimeKernel => {
      let iteration = 0;
      return new RuntimeKernel({
        sessionId: sessionId('s-resumed-effect'),
        effectLedger: ledger,
        tools,
        createTurnId: () => turnId(identity),
        model: { run: async (_request, context) => {
          iteration += 1;
          if (iteration === 1) {
            await context.emit?.({ type: 'tool-call', id: 'same-provider-call-id', name: 'lookup', input: {} });
            return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        } },
      });
    };

    await runtime('turn:first-runtime').submit('first');
    await runtime('turn:resumed-runtime').submit('second');

    expect(effects).toBe(2);
    expect(ledger.list().map(({ key, state }) => ({ key, state }))).toEqual([
      { key: 's-resumed-effect:turn:first-runtime:same-provider-call-id', state: 'committed' },
      { key: 's-resumed-effect:turn:resumed-runtime:same-provider-call-id', state: 'committed' },
    ]);
  });

  it('applies a tool-request rewrite before lookup, validation, policy, and execution', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: { rewritten: true }, detailsVersion: 1 }));
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'rewritten'),
      inputSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
        additionalProperties: false,
      },
      execute,
    }, 'builtin');
    let requests = 0;
    const model: ModelPort = {
      run: async (request, context) => {
        requests += 1;
        if (requests === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-rewrite', name: 'original', input: { unsafe: true } });
          return { stop: 'tool', usage: { inputTokens: 1, outputTokens: 1 } };
        }
        expect(request.messages.at(-2)).toMatchObject({
          role: 'assistant',
          toolCalls: [{ id: 'call-rewrite', name: 'rewritten', input: { approved: true } }],
        });
        return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-lifecycle-rewrite'),
      model,
      tools,
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type !== 'tool.requested') return;
        const payload = { callId: 'call-rewrite', name: 'rewritten', input: { approved: true } };
        return { payload, decision: { kind: 'rewrite', payload }, context: [], suppressed: false, receipts: [] };
      },
    });

    await kernel.submit('rewrite the tool');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ input: { approved: true } }));
  });

  it('fails closed when final tool input cannot be bound into an admission receipt', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: {}, detailsVersion: 1 }));
    const tools = new ToolRegistry();
    tools.register({ ...definition(async () => undefined, 'unsafe-receipt'), execute }, 'builtin');
    const events: RuntimeEvent[] = [];
    let iteration = 0;
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-invalid-receipt'),
      tools,
      model: { run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'invalid-receipt', name: 'unsafe-receipt', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
      emit: async (event) => {
        events.push(event);
        if (event.type !== 'tool.requested') return;
        const payload = { ...(event.payload as object), input: { callback: () => undefined } };
        return { payload, decision: { kind: 'rewrite', payload }, context: [], suppressed: false, receipts: [] };
      },
    });

    await expect(kernel.submit('go')).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'tool.blocked')?.payload).toMatchObject({ category: 'validation' });
  });

  it.each(['deny', 'stop'] as const)('honors a tool-request %s decision before the effect', async (kind) => {
    const execute = vi.fn(async () => ({ ok: true, content: 'should not run', detailsVersion: 1 }));
    const tools = new ToolRegistry();
    tools.register({ ...definition(async () => undefined), execute }, 'builtin');
    let requests = 0;
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId(`s-lifecycle-${kind}`),
      tools,
      model: {
        run: async (_request, context) => {
          requests += 1;
          if (requests === 1) {
            await context.emit?.({ type: 'tool-call', id: `call-${kind}`, name: 'lookup', input: {} });
            return { stop: 'tool', usage: { inputTokens: 1, outputTokens: 1 } };
          }
          return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        events.push(event);
        if (event.type !== 'tool.requested') return;
        return {
          payload: event.payload,
          decision: { kind, reason: `blocked by ${kind}` },
          context: [],
          suppressed: false,
          receipts: [],
        };
      },
    });

    await kernel.submit('block the tool');

    expect(execute).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'tool.blocked')?.payload).toMatchObject({
      name: 'lookup',
      error: `blocked by ${kind}`,
      category: 'policy',
    });
  });

  it('projects lifecycle context exactly once into subsequent model-visible history', async () => {
    const tools = new ToolRegistry();
    tools.register(definition(async () => ({ answer: 1 })), 'builtin');
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      run: async (request, context) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-context', name: 'lookup', input: {} });
          return { stop: 'tool', usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-lifecycle-context'),
      model,
      tools,
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type !== 'tool.requested') return;
        return {
          payload: event.payload,
          decision: { kind: 'continue' },
          context: ['Workspace policy: redact secrets.'],
          suppressed: false,
          receipts: [],
        };
      },
    });

    await kernel.submit('use context');
    await kernel.submit('history check');

    expect(requests[1]?.messages.filter((message) => message.role === 'system' && message.content === 'Workspace policy: redact secrets.')).toHaveLength(1);
    expect(requests[2]?.messages.filter((message) => message.role === 'system' && message.content === 'Workspace policy: redact secrets.')).toHaveLength(1);
  });

  it('rewrites input before it becomes model-visible history', async () => {
    const requests: ModelRequest[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-input-rewrite'),
      model: { run: async (request) => { requests.push(structuredClone(request)); return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }; } },
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type !== 'input.received') return;
        const payload = { text: 'rewritten input' };
        return { payload, decision: { kind: 'rewrite', payload }, context: [], suppressed: false, receipts: [] };
      },
    });

    await kernel.submit('original input');

    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'rewritten input' });
  });

  it('appends attributed peer context once and reuses durable event ids after restart', async () => {
    const requests: ModelRequest[] = [];
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-peer-context'),
      initialContextEventIds: ['evt-restored'],
      model: { run: async (request) => { requests.push(structuredClone(request)); return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }; } },
      emit: async (event) => { events.push(event); },
    });

    expect(await kernel.execute({ type: 'context.append', eventId: 'evt-1', text: '[peer:a; authority:data]\nresult', provenance: 'peer-attributed-data' }))
      .toEqual({ ok: true, data: { duplicate: false } });
    expect(await kernel.execute({ type: 'context.append', eventId: 'evt-1', text: 'duplicate', provenance: 'peer-attributed-data' }))
      .toEqual({ ok: true, data: { duplicate: true } });
    expect(await kernel.execute({ type: 'context.append', eventId: 'evt-restored', text: 'replayed', provenance: 'peer-attributed-data' }))
      .toEqual({ ok: true, data: { duplicate: true } });
    await kernel.submit('continue');

    expect(requests[0]?.messages.filter((message) => message.content.includes('authority:data'))).toEqual([
      { role: 'system', content: '[peer:a; authority:data]\nresult' },
    ]);
    expect(events.filter((event) => event.type === 'context.appended')).toHaveLength(1);
  });

  it.each(['deny', 'stop'] as const)('honors an input %s decision before any model effect', async (kind) => {
    const run = vi.fn(async () => ({ stop: 'complete' as const, usage: { inputTokens: 1, outputTokens: 1 } }));
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId(`s-input-${kind}`),
      model: { run },
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        events.push(event);
        if (event.type !== 'input.received') return;
        return { payload: event.payload, decision: { kind, reason: `input ${kind}` }, context: [], suppressed: false, receipts: [] };
      },
    });

    await kernel.submit('blocked input');

    expect(run).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'turn.ended')?.payload).toMatchObject({ stop: kind });
  });

  it('prepares rewritten model context with attributed context exactly once and stable ordering', async () => {
    const requests: ModelRequest[] = [];
    const providerIterations: number[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-context-preparing-rewrite'),
      initialMessages: [{ role: 'system', content: 'stable base prompt' }],
      model: { run: async (request) => { requests.push(structuredClone(request)); return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }; } },
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        if (event.type === 'provider.request-started') providerIterations.push((event.payload as { iteration: number }).iteration);
        if (event.type !== 'context.preparing') return;
        const source = event.payload as { messages: ModelRequest['messages']; iteration: number };
        const payload = { iteration: 999, messages: [...source.messages, { role: 'system' as const, content: 'rewritten context' }] };
        return {
          payload,
          decision: { kind: 'rewrite', payload },
          context: ['attributed context'],
          suppressed: false,
          receipts: [],
        };
      },
    });

    await kernel.submit('prepare');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.map((message) => message.content)).toEqual([
      'stable base prompt',
      'prepare',
      'rewritten context',
      'attributed context',
    ]);
    expect(providerIterations).toEqual([0]);
  });

  it.each(['deny', 'stop'] as const)('honors a context.preparing %s before provider execution', async (kind) => {
    const run = vi.fn(async () => ({ stop: 'complete' as const, usage: { inputTokens: 1, outputTokens: 1 } }));
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId(`s-context-preparing-${kind}`),
      model: { run },
      emit: async (event): Promise<LifecycleDispatchResult<unknown> | void> => {
        events.push(event);
        if (event.type !== 'context.preparing') return;
        return { payload: event.payload, decision: { kind, reason: `context ${kind}` }, context: [], suppressed: false, receipts: [] };
      },
    });

    await kernel.submit('blocked context');

    expect(run).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).not.toContain('provider.request-started');
    expect(events.find((event) => event.type === 'turn.ended')?.payload).toMatchObject({ stop: kind });
  });

  it('correlates turn events and emits cumulative cached-token usage', async () => {
    const events: RuntimeEvent[] = [];
    let request = 0;
    const model: ModelPort = {
      run: async (_request, context) => {
        request += 1;
        await context.emit?.({ type: 'text', text: `answer-${request}` });
        return {
          stop: 'complete',
          usage: {
            inputTokens: request * 2,
            outputTokens: request,
            cachedInputTokens: request + 2,
            cacheWriteInputTokens: request,
          },
        };
      },
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-envelope'),
      model,
      emit: async (event) => { events.push(event); },
    });
    await kernel.execute({ type: 'model.select', providerId: 'openai', modelId: 'gpt-test' });
    await kernel.submit('first');
    await kernel.submit('second');

    expect(kernel.snapshot().usage).toEqual({ inputTokens: 6, outputTokens: 3, cachedInputTokens: 7, cacheWriteInputTokens: 3 });
    expect(events.filter((event) => event.type === 'context.usage-changed').map((event) => event.payload)).toEqual([
      { inputTokens: 2, outputTokens: 1, cachedInputTokens: 3, cacheWriteInputTokens: 1 },
      { inputTokens: 6, outputTokens: 3, cachedInputTokens: 7, cacheWriteInputTokens: 3 },
    ]);
    const turnEvents = events.filter((event) => [
      'turn.started',
      'provider.request-started',
      'message.delta',
      'provider.response-received',
      'context.usage-changed',
      'turn.ended',
    ].includes(event.type));
    expect(turnEvents).not.toHaveLength(0);
    expect(turnEvents.every((event) => event.turnId !== undefined)).toBe(true);
    expect(turnEvents.every((event) => event.model?.providerId === 'openai' && event.model.modelId === 'gpt-test')).toBe(true);
  });

  it('keeps model identity immutable for an active turn', async () => {
    const requests: ModelRequest[] = [];
    let entered!: () => void;
    let release!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const model: ModelPort = {
      run: async (request) => {
        requests.push(structuredClone(request));
        if (requests.length === 1) { entered(); await blocked; }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-model-stability'),
      model,
      initialModel: { providerId: 'openai', modelId: 'gpt-initial' },
    });
    const turn = kernel.submit('first');
    await active;

    await expect(kernel.execute({ type: 'model.select', providerId: 'openai', modelId: 'gpt-next' })).resolves.toMatchObject({
      ok: false,
      error: { category: 'conflict' },
    });
    release();
    await turn;

    expect(requests[0]?.model).toEqual({ providerId: 'openai', modelId: 'gpt-initial' });
    expect(kernel.snapshot().model).toEqual({ providerId: 'openai', modelId: 'gpt-initial' });
  });

  it('emits a correlated provider failure before the runtime failure', async () => {
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-provider-failure'),
      model: { run: async () => { throw new Error('provider unavailable'); } },
      emit: async (event) => { events.push(event); },
    });

    await expect(kernel.submit('fail')).rejects.toThrow('provider unavailable');

    expect(events.map((event) => event.type)).toEqual([
      'runtime.ready',
      'input.received',
      'turn.started',
      'context.preparing',
      'provider.request-started',
      'message.started',
      'message.ended',
      'provider.failed',
      'runtime.failed',
      'turn.ended',
    ]);
    expect(events.find((event) => event.type === 'provider.failed')).toMatchObject({
      turnId: expect.any(String),
      payload: { iteration: 0, message: 'provider unavailable' },
    });
  });

  it('rejects every remaining queued input when a queued turn fails', async () => {
    const events: RuntimeEvent[] = [];
    let request = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-queue-failure'),
      model: {
        run: async () => {
          request += 1;
          if (request === 1) {
            await firstBlocked;
            return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          throw new Error('queued provider failed');
        },
      },
      emit: async (event) => { events.push(event); },
    });
    const active = kernel.submit('active');
    await vi.waitFor(() => expect(kernel.snapshot().state).toBe('running'));
    await kernel.execute({ type: 'input.follow-up', text: 'fails' });
    await kernel.execute({ type: 'input.follow-up', text: 'must be rejected' });

    releaseFirst();
    await active;
    await vi.waitFor(() => expect(kernel.snapshot().state).toBe('failed'));

    expect(events.filter((event) => event.type === 'input.rejected').map((event) => event.payload)).toContainEqual({
      kind: 'follow-up',
      text: 'must be rejected',
      reason: 'earlier queued input failed',
    });
  });

  it('treats a provider error stop as a failed turn in every transport', async () => {
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-error-stop'),
      model: { run: async () => ({ stop: 'error', usage: { inputTokens: 1, outputTokens: 0 } }) },
      emit: async (event) => { events.push(event); },
    });

    await expect(kernel.execute({ type: 'input.submit', text: 'fail' })).resolves.toMatchObject({
      ok: false,
      error: { category: 'provider' },
    });
    expect(events.map((event) => event.type)).toContain('provider.failed');
    expect(events.map((event) => event.type)).toContain('runtime.failed');
    expect(events.find((event) => event.type === 'turn.ended')?.payload).toMatchObject({ stop: 'error' });
  });

  it.each([
    ['tool calls with a complete stop', 'complete', true],
    ['a tool stop without tool calls', 'tool', false],
  ] as const)('fails closed for %s', async (_case, stop, emitToolCall) => {
    const kernel = new RuntimeKernel({
      sessionId: sessionId(`s-stop-${stop}-${emitToolCall}`),
      model: {
        run: async (_request, context) => {
          if (emitToolCall) await context.emit?.({ type: 'tool-call', id: 'call-mismatch', name: 'lookup', input: {} });
          return { stop, usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
    });

    await expect(kernel.submit('mismatch')).rejects.toMatchObject({ category: 'adapter-translation' });
    expect(kernel.snapshot().state).toBe('failed');
  });

  it('emits one error outcome when a tool result cannot enter model history', async () => {
    const events: RuntimeEvent[] = [];
    let iteration = 0;
    const model: ModelPort = {
      run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-cycle', name: 'cyclic', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(definition(async () => {
      const value: { self?: unknown } = {};
      value.self = value;
      return value;
    }, 'cyclic'), 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-cyclic-result'),
      model,
      tools,
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('cycle');

    const terminal = events.filter((event) => event.type === 'tool.ended');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({
      callId: 'call-cycle',
      outcome: 'error',
      category: 'tool-execution',
    });
  });

  it('bounds model-visible tool results before success publication', async () => {
    const events: RuntimeEvent[] = [];
    let iteration = 0;
    const model: ModelPort = {
      run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-large', name: 'large', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(definition(async () => 'x'.repeat(128), 'large'), 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-large-result'), model, tools, maxToolResultBytes: 64,
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('large');

    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended')?.payload).toMatchObject({
      outcome: 'error', category: 'tool-execution', message: expect.stringMatching(/exceeds 64 bytes/i),
    });
  });

  it('bounds aggregate model-visible tool results within one turn', async () => {
    const events: RuntimeEvent[] = [];
    const secondRequestToolResults: string[] = [];
    let iteration = 0;
    const model: ModelPort = {
      run: async (request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-a', name: 'large-a', input: {} });
          await context.emit?.({ type: 'tool-call', id: 'call-b', name: 'large-b', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        secondRequestToolResults.push(...request.messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.content));
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(definition(async () => ({ value: 'a'.repeat(72) }), 'large-a'), 'builtin');
    tools.register(definition(async () => ({ value: 'b'.repeat(72) }), 'large-b'), 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-aggregate-result-budget'),
      model,
      tools,
      maxToolResultBytes: 256,
      maxToolResultBytesPerTurn: 140,
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('large batch');

    expect(secondRequestToolResults).toHaveLength(2);
    expect(secondRequestToolResults[0]).toContain('"value":"aaaaaaaa');
    expect(secondRequestToolResults[1]).toMatch(/aggregate tool-result budget exceeds 140 bytes/i);
    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'tool.ended').at(-1)?.payload).toMatchObject({
      outcome: 'error', category: 'tool-execution', message: expect.stringMatching(/aggregate tool-result budget exceeds 140 bytes/i),
    });
  });

  it('publishes only the durable terminal tool outcome when persistence rejects success', async () => {
    let iteration = 0;
    const model: ModelPort = {
      run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-persist', name: 'lookup', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(definition(async () => ({ answer: 1 })), 'builtin');
    const observed: RuntimeEvent[] = [];
    const ledger = new InMemoryEffectLedger(() => 1);
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-persistence-outcome'),
      model,
      tools,
      effectLedger: ledger,
      emit: async (event) => {
        if (event.type === 'tool.ended' && (event.payload as { outcome?: string }).outcome === 'success') {
          throw new RuntimeFailure('persistence', 'session append failed');
        }
      },
    });
    kernel.subscribe((event) => { observed.push(event); });

    await kernel.submit('persist');

    const terminal = observed.filter((event) => event.type === 'tool.ended');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({ outcome: 'error', category: 'persistence' });
    expect(ledger.list()).toEqual([
      expect.objectContaining({ state: 'committed' }),
    ]);
  });
  it('records one ordered assistant tool-call envelope before multiple correlated results', async () => { const executed: string[] = []; let iteration = 0; const model: ModelPort = { run: async (request, context) => { iteration += 1; if (iteration === 1) { await context.emit?.({ type: 'text', text: 'checking' }); await context.emit?.({ type: 'tool-call', id: 'call-a', name: 'alpha', input: { order: 1 } }); await context.emit?.({ type: 'tool-call', id: 'call-b', name: 'beta', input: { order: 2 } }); return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } }; } expect(request.messages).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'checking', toolCalls: [{ id: 'call-a', name: 'alpha', input: { order: 1 } }, { id: 'call-b', name: 'beta', input: { order: 2 } }] },
      { role: 'tool', toolCallId: 'call-a', content: JSON.stringify({ ok: true, content: 'alpha', detailsVersion: 1 }) },
      { role: 'tool', toolCallId: 'call-b', content: JSON.stringify({ ok: true, content: 'beta', detailsVersion: 1 }) },
    ]); return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }; } }; const tools = new ToolRegistry(); tools.register(definition(async () => { executed.push('alpha'); return 'alpha'; }, 'alpha'), 'builtin'); tools.register(definition(async () => { executed.push('beta'); return 'beta'; }, 'beta'), 'builtin'); await new RuntimeKernel({ sessionId: sessionId('s'), model, tools }).submit('go'); expect(executed).toEqual(['alpha', 'beta']); });
  it('does not execute a denied effect', async () => { let executed = false; let iteration = 0; const model: ModelPort = { run: async (_request, context) => { iteration += 1; if (iteration === 1) { await context.emit?.({ type: 'tool-call', id: 'call-denied', name: 'lookup', input: {} }); return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } }; } return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }; } }; const tools = new ToolRegistry(); tools.register(definition(async () => { executed = true; }), 'builtin'); const policy = new PolicyChain(); policy.use('managed', async () => ({ effect: 'deny', reason: 'no', category: 'trust' })); const kernel = new RuntimeKernel({ sessionId: sessionId('s'), model, tools, policy }); await kernel.submit('go'); expect(executed).toBe(false); });
  it('fails closed at the iteration bound', async () => { let id = 0; const model: ModelPort = { run: async (_request, context) => { await context.emit?.({ type: 'tool-call', id: `missing-${++id}`, name: 'missing', input: {} }); return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } }; } }; const kernel = new RuntimeKernel({ sessionId: sessionId('s'), model, maxIterations: 2 }); await expect(kernel.submit('loop')).rejects.toMatchObject({ category: 'internal-invariant' }); expect(kernel.snapshot().state).toBe('failed'); });

  it('fails before side effects when one turn exceeds its tool-call budget', async () => {
    let executed = 0;
    const tools = new ToolRegistry();
    tools.register(definition(async () => { executed += 1; }, 'lookup'), 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-tool-budget'), tools, maxToolCalls: 2,
      model: { run: async (_request, context) => {
        for (let index = 0; index < 3; index += 1) {
          await context.emit?.({ type: 'tool-call', id: `budget-${index}`, name: 'lookup', input: {} });
        }
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });

    await expect(kernel.submit('too many')).rejects.toMatchObject({ category: 'model' });
    expect(executed).toBe(0);
  });

  it('projects initial and completed turn history exactly once into later requests', async () => {
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      run: async (request, context) => {
        requests.push(structuredClone(request));
        await context.emit?.({ type: 'text', text: requests.length === 1 ? 'first answer' : 'second answer' });
        return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s'),
      model,
      initialMessages: [
        { role: 'user', content: 'resumed question' },
        { role: 'assistant', content: 'resumed answer' },
      ],
    });

    await kernel.submit('first question');
    await kernel.submit('second question');

    expect(requests[0]?.messages).toEqual([
      { role: 'user', content: 'resumed question' },
      { role: 'assistant', content: 'resumed answer' },
      { role: 'user', content: 'first question' },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'resumed question' },
      { role: 'assistant', content: 'resumed answer' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
  });

  it('prepares the stable tool inventory once per turn across model iterations', async () => {
    let iteration = 0;
    const model: ModelPort = {
      run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-1', name: 'lookup', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const tools = new ToolRegistry();
    tools.register(definition(async () => ({ answer: 1 })), 'builtin');
    let inventoryReads = 0;
    const originalList = tools.list.bind(tools);
    tools.list = () => { inventoryReads += 1; return originalList(); };

    await new RuntimeKernel({ sessionId: sessionId('s'), model, tools }).submit('go');

    expect(iteration).toBe(2);
    expect(inventoryReads).toBe(1);
  });

  it('emits exactly one terminal tool outcome for unknown and denied calls', async () => {
    const terminalEvents = async (name: string, policy?: PolicyChain) => {
      let iteration = 0;
      const events: RuntimeEvent[] = [];
      const model: ModelPort = {
        run: async (_request, context) => {
          iteration += 1;
          if (iteration === 1) {
            await context.emit?.({ type: 'tool-call', id: `call-${name}`, name, input: {} });
            return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
          }
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
      const tools = new ToolRegistry();
      tools.register(definition(async () => 'unexpected', 'denied'), 'builtin');
      await new RuntimeKernel({ sessionId: sessionId(`s-${name}`), model, tools, policy, emit: async (event) => { events.push(event); } }).submit('go');
      return events.filter((event) => event.type === 'tool.ended' && (event.payload as { callId?: string }).callId === `call-${name}`);
    };
    const deny = new PolicyChain();
    deny.use('deny', async () => ({ effect: 'deny', reason: 'blocked', category: 'policy' }));

    await expect(terminalEvents('missing')).resolves.toHaveLength(1);
    await expect(terminalEvents('denied', deny)).resolves.toHaveLength(1);
  });

  it('enforces tool policy metadata and passes configured mode and trust to execution', async () => {
    let iteration = 0;
    const policyRequests: unknown[] = [];
    const contexts: unknown[] = [];
    const approve = vi.fn(async () => true);
    const checkPeerLocks = vi.fn(async () => true);
    const model: ModelPort = {
      run: async (_request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'call-guarded', name: 'guarded', input: { file: 'src/a.ts' } });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const guarded: ToolDefinition = {
      ...definition(async () => 'unused', 'guarded'),
      policy: {
        effects: ['write'], trust: 'workspace', approval: 'always', plan: 'required',
        lockTarget: (input) => [(input as { file: string }).file],
      },
      execute: async ({ context }) => {
        contexts.push(context);
        return { ok: true, content: {}, detailsVersion: 1 };
      },
    };
    const tools = new ToolRegistry();
    tools.register(guarded, 'builtin');
    const policy = new PolicyChain();
    policy.use('capture', async (request) => { policyRequests.push(request); return { effect: 'allow' }; });
    await new RuntimeKernel({
      sessionId: sessionId('s-guarded'), model, tools, policy,
      cwd: '/workspace', mode: 'interactive', trust: { workspace: 'trusted', managedOnly: false },
      planActive: true, approve, checkPeerLocks,
    }).submit('go');

    expect(approve).toHaveBeenCalledOnce();
    expect(checkPeerLocks).toHaveBeenCalledWith(['src/a.ts'], expect.objectContaining({ name: 'guarded' }));
    expect(policyRequests).toEqual([expect.objectContaining({
      trust: { workspace: 'trusted', managedOnly: false }, effects: ['write'],
      metadata: expect.objectContaining({ approval: 'always', plan: 'required', lockTargets: ['src/a.ts'], mode: 'interactive' }),
    })]);
    expect(contexts).toEqual([expect.objectContaining({ cwd: '/workspace', mode: 'interactive', trust: { workspace: 'trusted', managedOnly: false } })]);
  });

  it('reads required, forbidden, and allowed tool policy from live authoritative plan revisions', async () => {
    const executed: string[] = [];
    const observedPlanPolicy: unknown[] = [];
    const planState = new LiveRuntimePlanState();
    const tools = new ToolRegistry();
    for (const [name, plan] of [
      ['required', 'required'],
      ['forbidden', 'forbidden'],
      ['allowed', 'allowed'],
    ] as const) {
      tools.register({
        ...definition(async () => undefined, name),
        policy: { effects: ['read'], trust: 'none', approval: 'never', plan },
        execute: async () => {
          executed.push(name);
          return { ok: true, content: {}, detailsVersion: 1 };
        },
      }, 'builtin');
    }
    let pendingTool: string | undefined;
    const model: ModelPort = {
      run: async (request, context) => {
        const last = request.messages.at(-1);
        if (last?.role === 'user') {
          pendingTool = last.content;
          await context.emit?.({ type: 'tool-call', id: `call-${pendingTool}`, name: pendingTool, input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        pendingTool = undefined;
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const events: RuntimeEvent[] = [];
    const policy = new PolicyChain();
    policy.use('capture-plan-revision', async (request) => {
      observedPlanPolicy.push(request.metadata);
      return { effect: 'allow' };
    });
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-live-plan'), model, tools, planState, policy,
      emit: async (event) => { events.push(event); },
    });
    const submit = async (name: string) => {
      const before = executed.length;
      await kernel.submit(name);
      return executed.length > before;
    };

    await expect(submit('required')).resolves.toBe(false);
    await expect(submit('forbidden')).resolves.toBe(true);
    await expect(submit('allowed')).resolves.toBe(true);

    planState.update({ authority: 'runtime', revision: 1, active: true });
    await expect(submit('required')).resolves.toBe(true);
    await expect(submit('forbidden')).resolves.toBe(false);
    await expect(submit('allowed')).resolves.toBe(true);

    planState.update({ authority: 'runtime', revision: 2, active: false });
    await expect(submit('required')).resolves.toBe(false);
    await expect(submit('forbidden')).resolves.toBe(true);
    expect(observedPlanPolicy).toEqual([
      expect.objectContaining({ planActive: false, planRevision: 0 }),
      expect.objectContaining({ planActive: false, planRevision: 0 }),
      expect.objectContaining({ planActive: true, planRevision: 1 }),
      expect.objectContaining({ planActive: true, planRevision: 1 }),
      expect.objectContaining({ planActive: false, planRevision: 2 }),
    ]);
    expect(events.filter((event) => event.type === 'tool.blocked').map((event) => event.payload))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'required', category: 'plan-policy' }),
        expect.objectContaining({ name: 'forbidden', category: 'plan-policy' }),
      ]));
  });

  it('rejects stale or contradictory live plan revisions', () => {
    const state = new LiveRuntimePlanState();
    state.update({ authority: 'runtime', revision: 2, active: true });
    expect(state.snapshot()).toEqual({ authority: 'runtime', revision: 2, active: true });
    expect(Object.isFrozen(state.snapshot())).toBe(true);
    expect(() => state.update({ authority: 'runtime', revision: 1, active: false })).toThrow(/stale/i);
    expect(() => state.update({ authority: 'runtime', revision: 2, active: false })).toThrow(/same revision/i);
    expect(() => state.update({ authority: 'runtime', revision: 2, active: true })).not.toThrow();
  });

  it('fails closed when required policy inputs are unavailable', async () => {
    let executed = false;
    let iteration = 0;
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: 'call-protected', name: 'protected', input: {} });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'protected'),
      policy: { effects: ['write'], trust: 'workspace', approval: 'always', plan: 'required', lockTarget: () => ['src/a.ts'] },
      execute: async () => { executed = true; return { ok: true, content: {}, detailsVersion: 1 }; },
    }, 'builtin');
    await new RuntimeKernel({ sessionId: sessionId('s-protected'), model, tools, emit: async (event) => { events.push(event); } }).submit('go');

    expect(executed).toBe(false);
    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended')?.payload).toMatchObject({ outcome: 'blocked', category: 'trust' });
  });

  it('validates tool input and output at the execution boundary', async () => {
    let executed = false;
    let iteration = 0;
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: 'call-input-invalid', name: 'validated', input: {} });
        await context.emit?.({ type: 'tool-call', id: 'call-output-invalid', name: 'validated', input: { query: 'x' } });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'validated'),
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
      execute: async () => { executed = true; return { ok: true, content: { answer: 1 }, detailsVersion: 1 }; },
    }, 'builtin');
    await new RuntimeKernel({ sessionId: sessionId('s-validation'), model, tools, emit: async (event) => { events.push(event); } }).submit('go');

    expect(executed).toBe(true);
    const ended = events.filter((event) => event.type === 'tool.ended');
    expect(ended.find((event) => (event.payload as { callId: string }).callId === 'call-input-invalid')?.payload).toMatchObject({ outcome: 'blocked', category: 'validation' });
    expect(ended.find((event) => (event.payload as { callId: string }).callId === 'call-output-invalid')?.payload).toMatchObject({ outcome: 'error', category: 'validation' });
  });

  it('discards updates after cancellation and emits one cancelled terminal outcome', async () => {
    let iteration = 0;
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: 'call-cancel', name: 'slow', input: {} });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'slow'),
      execute: async ({ signal, update }) => {
        await update({ version: 1, kind: 'status', message: 'started' });
        started();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        await update({ version: 1, kind: 'status', message: 'late' });
        return { ok: true, content: {}, detailsVersion: 1 };
      },
    }, 'builtin');
    const kernel = new RuntimeKernel({ sessionId: sessionId('s-cancel'), model, tools, emit: async (event) => { events.push(event); } });
    const turn = kernel.submit('go');
    await executing;
    await kernel.cancel('test');
    await turn;

    expect(events.filter((event) => event.type === 'tool.updated').map((event) => (event.payload as { update: { message: string } }).update.message)).toEqual(['started']);
    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended')?.payload).toEqual({
      callId: 'call-cancel',
      name: 'slow',
      outcome: 'cancelled',
      category: 'cancelled',
      message: 'Tool call cancelled during execution',
      error: expect.objectContaining({ category: 'cancelled', message: 'Tool call cancelled during execution' }),
    });
  });

  it.each(['cancel', 'stop'] as const)('does not wait for an approval handler after %s', async (operation) => {
    let iteration = 0;
    let approvalStarted!: () => void;
    const waitingForApproval = new Promise<void>((resolve) => { approvalStarted = resolve; });
    let approvalSignal: AbortSignal | undefined;
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: `call-approval-${operation}`, name: 'approvalTool', input: {} });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'approvalTool'),
      policy: { effects: ['read'], trust: 'none', approval: 'always', plan: 'allowed' },
    }, 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId(`s-approval-${operation}`),
      model,
      tools,
      approve: async (request) => {
        approvalSignal = request.signal;
        approvalStarted();
        return new Promise<boolean>(() => undefined);
      },
      emit: async (event) => { events.push(event); },
    });
    const turn = kernel.submit('go');
    await waitingForApproval;

    const terminal = operation === 'cancel' ? kernel.cancel('test cancellation') : kernel.stop();
    await expect(Promise.race([
      Promise.all([terminal, turn]).then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])).resolves.toBe('settled');

    expect(approvalSignal?.aborted).toBe(true);
    const ended = events.filter((event) => event.type === 'tool.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.payload).toEqual({
      callId: `call-approval-${operation}`,
      name: 'approvalTool',
      outcome: 'cancelled',
      category: 'cancelled',
      message: 'Tool call cancelled while awaiting approval',
      error: expect.objectContaining({ category: 'cancelled', message: 'Tool call cancelled while awaiting approval' }),
    });
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(0);
  });

  it('turns malformed execution updates into one validation terminal outcome', async () => {
    let iteration = 0;
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: 'call-update', name: 'updating', input: {} });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'updating'),
      execute: async ({ update }) => {
        await update({ version: 1, kind: 'invalid' } as never);
        return { ok: true, content: {}, detailsVersion: 1 };
      },
    }, 'builtin');
    await new RuntimeKernel({ sessionId: sessionId('s-update'), model, tools, emit: async (event) => { events.push(event); } }).submit('go');

    expect(events.filter((event) => event.type === 'tool.updated')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended')?.payload).toMatchObject({ outcome: 'error', category: 'validation' });
  });

  it('queues active-turn follow-ups promptly and drains them in FIFO order', async () => {
    const requests: string[] = [];
    const events: RuntimeEvent[] = [];
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const model: ModelPort = { run: async (request) => {
      requests.push((request.messages.at(-1) as { content: string }).content);
      if (requests.length === 1) { entered(); await blocked; }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const kernel = new RuntimeKernel({ sessionId: sessionId('s-follow-up'), model, emit: async (event) => { events.push(event); } });
    let firstSettled = false;
    const first = kernel.submit('first').finally(() => { firstSettled = true; });
    await active;

    await expect(kernel.execute({ type: 'input.follow-up', text: 'second' })).resolves.toMatchObject({ ok: true, data: { queued: true, position: 1 } });
    await expect(kernel.execute({ type: 'input.follow-up', text: 'third' })).resolves.toMatchObject({ ok: true, data: { queued: true, position: 2 } });
    expect(firstSettled).toBe(false);
    expect(requests).toEqual(['first']);
    release();
    await first;
    await vi.waitFor(() => expect(requests).toEqual(['first', 'second', 'third']));
    expect(events.filter((event) => event.type === 'input.received').map((event) => (event.payload as { text: string }).text)).toEqual(['first', 'second', 'third']);
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'turn.ended')).toHaveLength(3);
  });

  it('steers at a model-safe point within the active turn before draining follow-ups', async () => {
    const requests: string[] = [];
    const events: RuntimeEvent[] = [];
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    let effects = 0;
    const model: ModelPort = { run: async (request, context) => {
      const current = (request.messages.at(-1) as { content: string }).content;
      requests.push(current);
      if (requests.length === 1) {
        entered();
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      if (current === 'replacement' && requests.filter((value) => value === 'replacement').length === 1) {
        await context.emit?.({ type: 'tool-call', id: 'replacement-effect', name: 'effect', input: {} });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register(definition(async () => { effects += 1; return {}; }, 'effect'), 'builtin');
    const kernel = new RuntimeKernel({ sessionId: sessionId('s-steer'), model, tools, emit: async (event) => { events.push(event); } });
    const first = kernel.submit('original');
    await active;
    await kernel.execute({ type: 'input.follow-up', text: 'later' });

    await expect(kernel.execute({ type: 'input.steer', text: 'replacement' })).resolves.toMatchObject({ ok: true, data: { queued: true, position: 1 } });
    await first;
    await vi.waitFor(() => expect(requests).toContain('later'));
    expect(requests.slice(0, 2)).toEqual(['original', 'replacement']);
    expect(effects).toBe(1);
    expect(events.filter((event) => event.type === 'input.received').map((event) => (event.payload as { text: string }).text)).toEqual(['original', 'replacement', 'later']);
    const starts = events.filter((event) => event.type === 'turn.started');
    const ends = events.filter((event) => event.type === 'turn.ended');
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(starts[0]?.turnId).toBe(ends[0]?.turnId);
    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
  });

  it('bounds the input queue and reports overflow explicitly', async () => {
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const model: ModelPort = { run: async (_request, context) => {
      entered();
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const kernel = new RuntimeKernel({ sessionId: sessionId('s-overflow'), model, maxQueuedInputs: 2 });
    const first = kernel.submit('first');
    await active;
    await expect(kernel.execute({ type: 'input.follow-up', text: 'one' })).resolves.toMatchObject({ ok: true });
    await expect(kernel.execute({ type: 'input.follow-up', text: 'two' })).resolves.toMatchObject({ ok: true });
    await expect(kernel.execute({ type: 'input.follow-up', text: 'overflow' })).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } });
    await kernel.stop();
    await first;
  });

  it('stop cancels the active turn and discards queued work', async () => {
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    let modelRuns = 0;
    const events: RuntimeEvent[] = [];
    const model: ModelPort = { run: async (_request, context) => {
      modelRuns += 1;
      entered();
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const kernel = new RuntimeKernel({ sessionId: sessionId('s-stop-queue'), model, emit: async (event) => { events.push(event); } });
    const first = kernel.submit('first');
    await active;
    await kernel.execute({ type: 'input.follow-up', text: 'never-one' });
    await kernel.execute({ type: 'input.follow-up', text: 'never-two' });
    await kernel.stop();
    await first;

    expect(modelRuns).toBe(1);
    expect(kernel.snapshot().state).toBe('stopped');
    expect(events.at(-1)?.type).toBe('runtime.stopped');
    await expect(kernel.execute({ type: 'input.follow-up', text: 'after-stop' })).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } });
  });

  it('isolates the stable prompt and tool prefix from adapter mutation', async () => {
    let iteration = 0;
    const model: ModelPort = { run: async (request, context) => {
      iteration += 1;
      if (iteration === 1) {
        (request.messages[0] as { content: string }).content = 'mutated prompt';
        (request.tools?.[0] as { description: string }).description = 'mutated tool';
        await context.emit?.({ type: 'tool-call', id: 'stable-call', name: 'lookup', input: {} });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      expect(request.messages[0]).toEqual({ role: 'system', content: 'stable prompt' });
      expect(request.tools?.[0]?.description).toBe('lookup');
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const tools = new ToolRegistry();
    tools.register(definition(async () => ({ answer: true })), 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-stable-prefix'),
      model,
      tools,
      initialMessages: [{ role: 'system', content: 'stable prompt' }],
    });

    await kernel.submit('go');
    expect(iteration).toBe(2);
  });

  it('emits one correlated message lifecycle for every provider iteration', async () => {
    const events: RuntimeEvent[] = [];
    let iteration = 0;
    const tools = new ToolRegistry();
    tools.register(definition(async () => ({ answer: true })), 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-message-lifecycle'),
      tools,
      model: { run: async (_request, context) => {
        iteration += 1;
        await context.emit?.({ type: 'text', text: `iteration-${iteration}` });
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'lifecycle-call', name: 'lookup', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('go');

    const started = events.filter((event) => event.type === 'message.started');
    const ended = events.filter((event) => event.type === 'message.ended');
    expect(started).toHaveLength(2);
    expect(ended).toHaveLength(2);
    const ids = started.map((event) => (event.payload as { messageId: string }).messageId);
    expect(new Set(ids).size).toBe(2);
    expect(ended.map((event) => (event.payload as { messageId: string }).messageId)).toEqual(ids);
    expect(events.filter((event) => event.type === 'message.delta').every((event) =>
      ids.includes((event.payload as { messageId: string }).messageId))).toBe(true);
  });

  it('publishes a valid tool error envelope as an error while preserving it for model correction', async () => {
    const events: RuntimeEvent[] = [];
    let iteration = 0;
    const tools = new ToolRegistry();
    tools.register({
      ...definition(async () => undefined, 'remote'),
      execute: async () => ({ ok: false, category: 'tool-execution', content: { message: 'remote rejected the call' }, detailsVersion: 1 }),
    }, 'builtin');
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-tool-error-envelope'),
      tools,
      model: { run: async (request, context) => {
        iteration += 1;
        if (iteration === 1) {
          await context.emit?.({ type: 'tool-call', id: 'remote-call', name: 'remote', input: {} });
          return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
        }
        expect(request.messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId: 'remote-call',
          content: JSON.stringify({ ok: false, category: 'tool-execution', content: { message: 'remote rejected the call' }, detailsVersion: 1 }),
        });
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('go');

    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended')?.payload).toMatchObject({
      callId: 'remote-call', outcome: 'error', category: 'tool-execution', result: { ok: false },
    });
  });

  it('enforces schema combinators, local references, and scalar constraints', () => {
    const schema = {
      $defs: { identifier: { type: 'string', pattern: '^[a-z]+$', minLength: 3 } },
      type: 'object',
      properties: { id: { $ref: '#/$defs/identifier' }, value: { oneOf: [{ type: 'integer', minimum: 2 }, { const: 'auto' }] } },
      required: ['id', 'value'],
      additionalProperties: false,
    } as const;
    expect(jsonSchemaError({ id: 'alpha', value: 2 }, schema)).toBeUndefined();
    expect(jsonSchemaError({ id: 'A', value: 1 }, schema)).toContain('characters');
    expect(jsonSchemaError({ id: 'alpha', value: true }, schema)).toContain('exactly one');
  });

  it('retries only safe provider failures before the turn has started an effect', async () => {
    let attempts = 0;
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-safe-retry'), maxProviderAttempts: 3,
      model: { run: async () => { attempts += 1; if (attempts === 1) throw new RuntimeFailure('provider', 'transient', 'safe'); return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }; } },
      emit: async (event) => { events.push(event); },
    });
    await kernel.submit('retry');
    expect(attempts).toBe(2);
    expect(events.filter((event) => event.type === 'provider.request-started')).toHaveLength(2);
    expect(events.find((event) => event.type === 'provider.failed')?.payload).toMatchObject({ attempt: 1, retrying: true });
  });

  it('bounds cancellation of a non-cooperative tool and emits one terminal event', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const tools = new ToolRegistry();
    tools.register({ ...definition(async () => undefined, 'stuck'), execute: async () => { entered(); return await new Promise<never>(() => undefined); } }, 'builtin');
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-non-cooperative-tool'), tools,
      model: { run: async (_request, context) => { await context.emit?.({ type: 'tool-call', id: 'stuck-call', name: 'stuck', input: {} }); return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } }; } },
      emit: async (event) => { events.push(event); },
    });
    const turn = kernel.submit('start');
    await started;
    await kernel.cancel('stop');
    await expect(Promise.race([turn.then(() => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100))])).resolves.toBe('settled');
    expect(events.filter((event) => event.type === 'tool.ended')).toHaveLength(1);
    expect(events.find((event) => event.type === 'tool.ended')?.payload).toMatchObject({ callId: 'stuck-call', outcome: 'cancelled' });
  });

  it('automatically compacts at the configured safe-point input threshold', async () => {
    const compactions: Array<{ reason: string; messages: readonly unknown[] }> = [];
    const events: RuntimeEvent[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-auto-compaction'),
      compactionInputTokenThreshold: 100,
      initialMessages: [{ role: 'user', content: 'existing history' }],
      compaction: {
        compact: async ({ reason, messages }) => {
          compactions.push({ reason, messages });
          return { summary: 'automatic summary', messages: [{ role: 'system', content: 'Summary: automatic' }] };
        },
      },
      model: {
        run: async () => ({
          stop: 'complete',
          usage: { inputTokens: 100, outputTokens: 1 },
        }),
      },
      emit: async (event) => { events.push(event); },
    });

    await kernel.submit('trigger threshold');

    expect(compactions).toEqual([expect.objectContaining({
      reason: 'threshold',
      messages: [
        { role: 'user', content: 'existing history' },
        { role: 'user', content: 'trigger threshold' },
      ],
    })]);
    expect(events.map(({ type }) => type)).toEqual(expect.arrayContaining([
      'context.compaction-started',
      'context.compacted',
    ]));
  });

  it('rate-limits failed automatic compaction attempts by the same input threshold', async () => {
    let modelCalls = 0;
    let compactionCalls = 0;
    const usage = [100, 1, 99];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-auto-compaction-backoff'),
      compactionInputTokenThreshold: 100,
      compaction: {
        compact: async () => {
          compactionCalls += 1;
          throw new Error('summarizer unavailable');
        },
      },
      model: {
        run: async () => ({
          stop: 'complete',
          usage: { inputTokens: usage[modelCalls++]!, outputTokens: 1 },
        }),
      },
    });

    await kernel.submit('first threshold');
    await kernel.submit('below next threshold');
    await kernel.submit('next threshold');

    expect(compactionCalls).toBe(2);
  });

  it('routes compaction through the composed service and replaces model-visible history atomically', async () => {
    const requests: ModelRequest[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-runtime-compaction'),
      initialMessages: [{ role: 'user', content: 'large history' }],
      compaction: { compact: async () => ({ summary: 'short', messages: [{ role: 'system', content: 'Summary: short' }] }) },
      model: { run: async (request) => { requests.push(request); return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }; } },
    });
    await expect(kernel.execute({ type: 'context.compact', reason: 'manual' })).resolves.toMatchObject({ ok: true, data: { summary: 'short' } });
    await kernel.submit('continue');
    expect(requests[0]?.messages).toEqual([{ role: 'system', content: 'Summary: short' }, { role: 'user', content: 'continue' }]);
  });

  it('binds replay prevention to lifecycle-final input, composite effects, and policy receipts', async () => {
    const ledger = new InMemoryEffectLedger(() => 1);
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => ({ ok: true, content: {}, detailsVersion: 1 }));
    tools.register({ ...definition(async () => undefined, 'effect'), policy: { effects: ['network', 'write'], trust: 'none', approval: 'never', plan: 'allowed' }, execute }, 'builtin');
    const model = (input: unknown): ModelPort => { let iteration = 0; return { run: async (_request, context) => { iteration += 1; if (iteration === 1) { await context.emit?.({ type: 'tool-call', id: 'stable-call', name: 'effect', input }); return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } }; } return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }; } }; };
    await new RuntimeKernel({
      sessionId: sessionId('s-ledger'), model: model({ requested: true }), tools, effectLedger: ledger,
      policy: (() => { const chain = new PolicyChain(); chain.use('audit', async () => ({ effect: 'allow' })); return chain; })(),
      emit: async (event) => event.type === 'tool.requested'
        ? { payload: { ...(event.payload as object), input: { final: true } }, decision: { kind: 'continue' }, context: [], suppressed: false, receipts: [] }
        : undefined,
    }).submit('first');
    await new RuntimeKernel({ sessionId: sessionId('s-ledger'), model: model({ final: false }), tools, effectLedger: ledger }).submit('replay');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ledger.list()).toEqual([expect.objectContaining({
      key: expect.stringContaining(':stable-call'),
      state: 'committed',
      receipt: expect.objectContaining({
        input: { final: true },
        effects: ['network', 'write'],
        policy: expect.objectContaining({ receipts: [expect.objectContaining({ policy: 'audit' })] }),
      }),
    })]);
  });
});
