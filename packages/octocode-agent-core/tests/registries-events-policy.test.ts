import { describe, expect, it } from 'vitest';
import {
  CommandRegistry,
  LifecycleBus,
  PolicyChain,
  ToolRegistry,
  eventId,
  sessionId,
  toolCallId,
  type AgentEventEnvelope,
  type ToolDefinition,
} from '../src/index.js';

const tool = (name: string): ToolDefinition => ({
  name,
  label: name,
  description: `${name} tool`,
  schemaVersion: 1,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  outputVersion: 1,
  policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
  execute: async ({ input }) => ({ ok: true, content: input, detailsVersion: 1 }),
});

describe('canonical registries', () => {
  it('is deterministic and rejects duplicate identities', () => {
    const tools = new ToolRegistry();
    tools.register(tool('z'), 'builtin');
    tools.register(tool('a'), 'builtin');
    expect(tools.list().map((entry) => entry.name)).toEqual(['a', 'z']);
    expect(() => tools.register(tool('a'), 'plugin:x')).toThrow(/duplicate/i);

    const commands = new CommandRegistry();
    commands.register({ name: 'hello', description: 'hello', permission: 'none', headless: 'supported', execute: async () => ({ status: 'ok' }) }, 'builtin');
    expect(commands.get('hello')?.owner).toBe('builtin');
  });
});

describe('LifecycleBus', () => {
  it('sorts deterministically, composes valid rewrites, and deny wins', async () => {
    const bus = new LifecycleBus<{ value: number }>({
      eventType: 'tool.requested',
      authority: ['rewrite', 'allow-deny'],
      validate: (payload): payload is { value: number } => typeof payload === 'object' && payload !== null && typeof (payload as { value?: unknown }).value === 'number',
    });
    const order: string[] = [];
    bus.subscribe({ id: 'later', source: 'workspace', priority: 2, handler: async ({ payload }) => { order.push('later'); return { kind: 'deny', reason: `blocked:${payload.value}` }; } });
    bus.subscribe({ id: 'first', source: 'managed', priority: 99, handler: async ({ payload }) => { order.push('first'); return { kind: 'rewrite', payload: { value: payload.value + 1 } }; } });
    const envelope: AgentEventEnvelope<'tool.requested', { value: number }> = {
      schemaVersion: 1, eventVersion: 1, id: eventId('e1'), type: 'tool.requested', phase: 'permission',
      sessionId: sessionId('s1'), timestamp: 1, cwd: '/tmp', mode: 'interactive',
      trust: { workspace: 'trusted', managedOnly: false }, payload: { value: 1 },
    };
    const result = await bus.dispatch(envelope);
    expect(order).toEqual(['first', 'later']);
    expect(result.payload).toEqual({ value: 2 });
    expect(result.decision).toEqual({ kind: 'deny', reason: 'blocked:2' });
    expect(result.receipts).toHaveLength(2);
  });

  it('rejects an invalid rewrite', async () => {
    const bus = new LifecycleBus<{ value: number }>({ eventType: 'input.received', authority: ['rewrite'], validate: (v): v is { value: number } => typeof (v as { value?: unknown })?.value === 'number' });
    bus.subscribe({ id: 'bad', source: 'plugin', handler: async () => ({ kind: 'rewrite', payload: { value: 'bad' } as unknown as { value: number } }) });
    await expect(bus.dispatch({ schemaVersion: 1, eventVersion: 1, id: eventId('e'), type: 'input.received', phase: 'before', sessionId: sessionId('s'), timestamp: 1, cwd: '/', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload: { value: 1 } })).rejects.toMatchObject({ category: 'validation' });
  });
});

describe('PolicyChain', () => {
  it('centralizes deny-first policy and preserves receipts', async () => {
    const chain = new PolicyChain();
    chain.use('trust', async () => ({ effect: 'allow' }));
    chain.use('peer-lock', async () => ({ effect: 'deny', reason: 'locked', category: 'peer-lock' }));
    chain.use('approval', async () => ({ effect: 'allow' }));
    const result = await chain.evaluate({ operation: 'tool.execute', trust: { workspace: 'trusted', managedOnly: false }, effects: ['write'], metadata: { call: toolCallId('c') } });
    expect(result.effect).toBe('deny');
    expect(result.receipts.map((receipt) => receipt.policy)).toEqual(['trust', 'peer-lock']);
  });
});
