import { describe, expect, it } from 'vitest';
import {
  LiveRuntimePlanState,
  RuntimeKernel,
  ToolRegistry,
  createEffectSet,
  sessionId,
  type ModelPort,
  type ToolDefinition,
} from '@octocodeai/agent-core';
import { registerNativePlanTool } from '../src/native-plan.js';

function gatedTool(name: string, plan: 'required' | 'forbidden', executed: string[]): ToolDefinition {
  return {
    name,
    label: name,
    description: `${name} plan-policy fixture`,
    schemaVersion: 1,
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {},
    outputVersion: 1,
    policy: { effects: createEffectSet('read'), trust: 'none', approval: 'never', plan },
    execute: async () => {
      executed.push(name);
      return { ok: true, content: {}, detailsVersion: 1 };
    },
  };
}

describe('native plan policy integration', () => {
  it('shares committed native plan revisions with runtime tool gates', async () => {
    const planState = new LiveRuntimePlanState();
    const tools = new ToolRegistry();
    const executed: string[] = [];
    registerNativePlanTool(tools, { planState });
    tools.register(gatedTool('required', 'required', executed), 'fixture');
    tools.register(gatedTool('forbidden', 'forbidden', executed), 'fixture');

    const model: ModelPort = {
      run: async (request, context) => {
        const last = request.messages.at(-1);
        if (last?.role !== 'user') return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        const call = last.content === 'plan-set'
          ? { name: 'plan', input: { action: 'set', steps: ['Build'] } }
          : last.content === 'plan-clear'
            ? { name: 'plan', input: { action: 'clear' } }
            : { name: last.content, input: {} };
        await context.emit?.({ type: 'tool-call', id: `call-${last.content}`, ...call });
        return { stop: 'tool', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s-native-plan-policy'),
      cwd: '/workspace',
      trust: { workspace: 'trusted', managedOnly: false },
      approve: async () => true,
      model,
      tools,
      planState,
    });

    await kernel.submit('required');
    await kernel.submit('forbidden');
    expect(executed).toEqual(['forbidden']);

    await kernel.submit('plan-set');
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 1, active: true });
    await kernel.submit('required');
    await kernel.submit('forbidden');
    expect(executed).toEqual(['forbidden', 'required']);

    await kernel.submit('plan-clear');
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 2, active: false });
    await kernel.submit('required');
    await kernel.submit('forbidden');
    expect(executed).toEqual(['forbidden', 'required', 'forbidden']);
  });
});
