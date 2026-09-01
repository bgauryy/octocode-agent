import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type ModelPort, type ModelRequest } from '@octocodeai/agent-core';

import { createDefaultNativeRuntime, parseNativeArgs } from '../src/native-launcher.js';
import { FilePlanStore, type NativePlanSnapshot, type PlanScope } from '../src/native-plan.js';
import {
  NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES,
  withNativeActivePlanContext,
} from '../src/native-plan-context.js';
import { nativeContextTokenUpperBound } from '../src/native-context-token-meter.js';

const scope: PlanScope = { sessionId: 'session:one', workspace: '/workspace' };
const signal = new AbortController().signal;

function plan(revision: number, text: string): NativePlanSnapshot {
  return {
    version: 1,
    scope,
    revision,
    phase: 'active',
    steps: [{ id: `step:${revision}:1`, text, status: 'doing' }],
    decisions: [],
  };
}

describe('native active-plan turn context', () => {
  it('is wired into the native runtime and observes a plan committed after composition', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-plan-context-runtime-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-plan-context-workspace-'));
    const requests: ModelRequest[] = [];
    const runtime = await createDefaultNativeRuntime({
      env: { OCTOCODE_HOME: home },
      cwd,
      args: parseNativeArgs([]),
      tools: new ToolRegistry(),
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    const runtimeScope = { sessionId: String(runtime.snapshot().sessionId), workspace: cwd };
    await new FilePlanStore(path.join(home, 'agent', 'plans')).save(runtimeScope, 0, {
      version: 1,
      scope: runtimeScope,
      revision: 1,
      phase: 'active',
      steps: [{ id: 'step:1:1', text: 'Runtime authoritative step', status: 'doing' }],
      decisions: [],
    });

    await runtime.submit('execute');
    await runtime.stop();

    expect(requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('Runtime authoritative step') }),
    ]));
    expect(requests[0]?.cache).toEqual({ stablePrefixMessageCount: 1 });
  });

  it('uses a conservative provider-neutral token upper bound including transient plan capacity', () => {
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'hello 世界' }],
      tools: [{ name: 'tool', description: 'Tool', inputSchema: { type: 'object' } }],
    };
    const serializedBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    expect(nativeContextTokenUpperBound(request)).toBeGreaterThanOrEqual(
      serializedBytes + NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES,
    );
  });

  it('reloads the authoritative file plan for request, resume, and post-compaction context', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-plan-context-'));
    const store = new FilePlanStore(directory);
    await store.save(scope, 0, plan(1, 'Initial plan'));
    const requests: ModelRequest[] = [];
    const delegate: ModelPort = {
      run: async (request) => {
        requests.push(structuredClone(request));
        return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const model = withNativeActivePlanContext(delegate, store, scope);

    await model.run({ messages: [{ role: 'system', content: 'stable' }, { role: 'user', content: 'request' }] }, { signal });
    await store.save(scope, 1, plan(2, 'Plan changed while the session was compacted'));
    await model.run({
      messages: [
        { role: 'system', content: 'stable' },
        { role: 'system', content: 'Conversation summary:\nsummary' },
        { role: 'user', content: 'after compaction' },
      ],
    }, { signal });

    const firstContext = requests[0]!.messages.find((message) => message.content.includes('<octocode_active_plan'))!;
    const refreshedContext = requests[1]!.messages.find((message) => message.content.includes('<octocode_active_plan'))!;
    expect(firstContext.content).toContain('"revision":1');
    expect(firstContext.content).toContain('Initial plan');
    expect(refreshedContext.content).toContain('"revision":2');
    expect(refreshedContext.content).toContain('Plan changed while the session was compacted');
    expect(requests[1]!.messages.filter((message) => message.content.includes('<octocode_active_plan'))).toHaveLength(1);
    expect(requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: 'after compaction' });
  });

  it('bounds attributed plan context and removes stale context when no active plan remains', async () => {
    const load = vi.fn(async (): Promise<NativePlanSnapshot | undefined> =>
      plan(1, `<unsafe>${'x'.repeat(NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES * 2)}`),
    );
    const requests: ModelRequest[] = [];
    const delegate: ModelPort = {
      run: async (request) => {
        requests.push(structuredClone(request));
        return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const model = withNativeActivePlanContext(delegate, { load, save: vi.fn() }, scope);
    await model.run({ messages: [{ role: 'user', content: 'go' }] }, { signal });
    const context = requests[0]!.messages.find((message) => message.content.includes('<octocode_active_plan'))!;
    expect(new TextEncoder().encode(context.content).byteLength).toBeLessThanOrEqual(NATIVE_ACTIVE_PLAN_CONTEXT_MAX_BYTES);
    expect(context.content).not.toContain('<unsafe>');

    load.mockResolvedValueOnce(undefined);
    await model.run({ messages: [...requests[0]!.messages, { role: 'user', content: 'resume' }] }, { signal });
    expect(requests[1]!.messages.some((message) => message.content.includes('<octocode_active_plan'))).toBe(false);
  });
});
