import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeKernel,
  PolicyChain,
  ToolRegistry,
  sessionId,
  type ModelPort,
  type RuntimeEvent,
  type ToolDefinition,
} from '../src/index.js';

const policyFor = (action: string) => action === 'status'
  ? { effects: ['read'] as const, trust: 'none' as const, approval: 'never' as const, plan: 'allowed' as const }
  : { effects: ['network', 'process'] as const, trust: 'workspace' as const, approval: 'on-request' as const, plan: 'allowed' as const };

async function run(action: string, resolve = (input: unknown) => policyFor((input as { action: string }).action)) {
  let iteration = 0;
  const model: ModelPort = {
    run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: `call-${action}`, name: 'contextual', input: { action } });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const execute = vi.fn(async () => ({ ok: true, content: {}, detailsVersion: 1 }));
  const tool: ToolDefinition = {
    name: 'contextual', label: 'Contextual', description: 'Contextual policy', schemaVersion: 1,
    inputSchema: {
      type: 'object',
      properties: { action: { enum: ['status', 'spawn'] } },
      required: ['action'],
      additionalProperties: false,
    },
    outputSchema: {}, outputVersion: 1,
    policy: {
      effects: ['network', 'process'], trust: 'workspace', approval: 'on-request', plan: 'allowed',
      resolve,
    },
    execute,
  };
  const tools = new ToolRegistry();
  tools.register(tool, 'test');
  const approve = vi.fn(async () => true);
  const events: RuntimeEvent[] = [];
  const policyRequests: unknown[] = [];
  const policy = new PolicyChain();
  policy.use('capture', async (request) => {
    policyRequests.push(request);
    return { effect: 'allow' };
  });
  await new RuntimeKernel({
    sessionId: sessionId(`policy-${action}`), model, tools, approve, policy,
    trust: { workspace: action === 'status' ? 'unknown' : 'trusted', managedOnly: false },
    emit: async (event) => { events.push(event); },
  }).submit('go');
  return { approve, events, execute, policyRequests };
}

describe('input-sensitive tool policy', () => {
  it('resolves read actions after input validation without requesting process approval', async () => {
    const { approve, events, execute, policyRequests } = await run('status');
    expect(approve).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'permission.requested' }));
    expect(execute).toHaveBeenCalledOnce();
    expect(policyRequests).toEqual([expect.objectContaining({ effects: ['read'] })]);
  });

  it('retains network/process approval for mutations', async () => {
    const { approve, events, execute, policyRequests } = await run('spawn');
    expect(approve).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission.requested' }));
    expect(execute).toHaveBeenCalledOnce();
    expect(policyRequests).toEqual([expect.objectContaining({ effects: ['network', 'process'] })]);
  });

  it('fails closed when an input policy resolver returns an incomplete policy', async () => {
    const { approve, events, execute, policyRequests } = await run('status', () => ({ effects: ['read'] }) as never);
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(policyRequests).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.blocked',
      payload: expect.objectContaining({ category: 'validation' }),
    }));
  });

  it('fails closed when an input resolver exceeds the registered capability ceiling', async () => {
    const { approve, events, execute, policyRequests } = await run(
      'status',
      () => ({ effects: ['write'], trust: 'none', approval: 'never' }) as never,
    );
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(policyRequests).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.blocked',
      payload: expect.objectContaining({
        category: 'validation',
        error: expect.stringMatching(/capability ceiling/i),
      }),
    }));
  });
});
