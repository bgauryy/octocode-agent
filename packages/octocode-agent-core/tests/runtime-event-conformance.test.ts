import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  RUNTIME_MODES,
  RuntimeKernel,
  ToolRegistry,
  parseRpcEvent,
  sessionId,
  type ModelPort,
  type AgentEventPayloadMap,
  type OpaqueRuntimeEvent,
  type RuntimeEvent,
  type ToolDefinition,
} from '../src/index.js';

const approvalTool = (execute: () => void): ToolDefinition => ({
  name: 'guarded', label: 'Guarded', description: 'Guarded', schemaVersion: 1,
  inputSchema: { type: 'object' }, outputSchema: {}, outputVersion: 1,
  policy: { effects: ['read'], trust: 'none', approval: 'always', plan: 'allowed' },
  execute: async () => { execute(); return { ok: true, content: {}, detailsVersion: 1 }; },
});

describe('canonical runtime event conformance', () => {
  it('correlates mapped payloads while keeping named plugin events opaque', () => {
    const assertTypes = (event: RuntimeEvent) => {
      if (event.type === 'provider.response-received') {
        expectTypeOf(event.payload).toEqualTypeOf<Readonly<AgentEventPayloadMap['provider.response-received']>>();
        expectTypeOf(event.payload.durationMs).toEqualTypeOf<number>();
      }
      if (event.type === 'plugin.lifecycle') {
        expectTypeOf<OpaqueRuntimeEvent<'plugin.lifecycle'>['payload']>().toEqualTypeOf<Readonly<unknown>>();
      }
    };
    expect(assertTypes).toBeTypeOf('function');
  });

  it('keeps ACP execution context separate from JSON output formatting', async () => {
    expect(RUNTIME_MODES).toContain('acp');
    const events: RuntimeEvent[] = [];
    const runtime = new RuntimeKernel({
      sessionId: sessionId('acp-session'),
      mode: 'acp',
      outputFormat: 'json',
      model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) },
      emit: async (event) => { events.push(event); },
    });
    await runtime.start();
    expect(events[0]).toMatchObject({ mode: 'acp', outputFormat: 'json' });
    expect(parseRpcEvent({ protocolVersion: 1, sequence: 1, event: events[0]! })).toMatchObject({
      event: { mode: 'acp', outputFormat: 'json' },
    });
    expect(() => parseRpcEvent({
      protocolVersion: 1, sequence: 2, event: { ...events[0]!, outputFormat: 'yaml' },
    })).toThrow(/event envelope/i);
  });

  it('emits a permission boundary after policy and honors hook allow before host approval', async () => {
    let iteration = 0;
    const model: ModelPort = { run: async (_request, context) => {
      iteration += 1;
      if (iteration === 1) {
        await context.emit?.({ type: 'tool-call', id: 'permission-call', name: 'guarded', input: { value: 1 } });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
    } };
    const execute = vi.fn();
    const approve = vi.fn(async () => false);
    const events: RuntimeEvent[] = [];
    const tools = new ToolRegistry();
    tools.register(approvalTool(execute), 'test');
    const runtime = new RuntimeKernel({
      sessionId: sessionId('permission-session'), model, tools, approve,
      emit: async (event) => {
        events.push(event);
        if (event.type === 'permission.requested') {
          return { payload: event.payload, decision: { kind: 'allow' }, context: [], suppressed: false, receipts: [] };
        }
        return undefined;
      },
    });
    await runtime.submit('go');
    expect(events.find(({ type }) => type === 'permission.requested')).toMatchObject({
      phase: 'permission', payload: { callId: 'permission-call', name: 'guarded', input: { value: 1 } },
    });
    expect(approve).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(events.some(({ type }) => type === 'agent.ended')).toBe(true);
  });
});
