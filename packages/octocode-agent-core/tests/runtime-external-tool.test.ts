import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryEffectLedger,
  PolicyChain,
  RuntimeKernel,
  ToolRegistry,
  sessionId,
  type ModelMessage,
  type ModelPort,
  type RuntimeEvent,
  type ToolDefinition,
} from '../src/index.js';

const textUserInput = (text: string) => ({
  schemaVersion: 1 as const,
  parts: [{ type: 'text' as const, text }],
});

function externalTool(execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: 'external', label: 'External', description: 'External effect', schemaVersion: 1,
    inputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false },
    outputVersion: 1,
    policy: { effects: ['write'], trust: 'workspace', approval: 'always', plan: 'allowed' },
    execute,
  };
}

function harness(options: {
  execute?: ToolDefinition['execute'];
  policy?: PolicyChain;
  model?: ModelPort;
} = {}) {
  const execute = options.execute ?? vi.fn(async ({ input }) => ({ ok: true, content: input, detailsVersion: 1 }));
  const tools = new ToolRegistry();
  tools.register(externalTool(execute), 'test');
  const events: RuntimeEvent[] = [];
  const ledger = new InMemoryEffectLedger(() => 1);
  const approve = vi.fn(async () => true);
  const runtime = new RuntimeKernel({
    sessionId: sessionId('external-session'), tools, effectLedger: ledger, approve,
    trust: { workspace: 'trusted', managedOnly: false }, policy: options.policy,
    model: options.model ?? { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) },
    emit: async (event) => { events.push(event); },
  });
  return { runtime, execute, events, ledger, approve };
}

const command = (operationId: string, signal?: AbortSignal) => ({
  type: 'tool.execute' as const,
  operationId,
  name: 'external',
  input: { value: 'scheduled' },
  ...(signal === undefined ? {} : { signal }),
});

describe('runtime-originated tool execution', () => {
  it('runs through policy and blocks a denied automation before execution', async () => {
    const policy = new PolicyChain();
    policy.use('deny', async () => ({ effect: 'deny', reason: 'automation denied', category: 'policy' }));
    const { runtime, execute, events } = harness({ policy });

    await expect(runtime.execute(command('denied'))).resolves.toMatchObject({
      ok: false, error: { category: 'approval' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.blocked' }));
  });

  it('records the same approval and effect receipts and rejects duplicate operation ids', async () => {
    const { runtime, execute, events, ledger, approve } = harness();
    await expect(runtime.execute(command('stable-run'))).resolves.toMatchObject({
      ok: true, data: { ok: true, content: { value: 'scheduled' }, detailsVersion: 1 },
    });
    await expect(runtime.execute(command('stable-run'))).resolves.toMatchObject({
      ok: false, error: { category: 'conflict' },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission.requested' }));
    expect(ledger.list()).toEqual([expect.objectContaining({
      key: 'external-session:external:stable-run', state: 'committed',
      receipt: expect.objectContaining({
        effects: ['write'],
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: expect.any(Number),
        policyRevision: 0,
        policy: expect.objectContaining({ approval: 'always', approved: true }),
      }),
    })]);
  });

  it('settles cancellation as uncertain and does not append model conversation messages', async () => {
    const controller = new AbortController();
    const requests: Array<readonly ModelMessage[]> = [];
    const model: ModelPort = { run: async ({ messages }) => {
      requests.push(structuredClone(messages));
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const { runtime, ledger } = harness({
      model,
      execute: vi.fn(async ({ signal }): Promise<never> => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      })),
    });
    const execution = runtime.execute(command('cancelled-run', controller.signal));
    await vi.waitFor(() => expect(ledger.list()).toHaveLength(1));
    controller.abort();

    await expect(execution).resolves.toMatchObject({ ok: false, error: { category: 'cancelled' } });
    expect(ledger.list()).toEqual([expect.objectContaining({ state: 'uncertain' })]);
    await runtime.submit('after automation');
    expect(requests[0]).toEqual([{
      role: 'user',
      content: 'after automation',
      userInput: textUserInput('after automation'),
    }]);
  });
});
