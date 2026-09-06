import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultNativeRuntime, parseNativeArgs } from '../src/native-launcher.js';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { resolveModelInputBudget, RuntimeFailure, RuntimeKernel, ToolRegistry, sessionId, type RuntimeEvent } from '@octocodeai/agent-core';
import { initDb } from '@octocodeai/octocode-awareness';
import { createNativePhysiology } from '../src/native-physiology.js';
import { registerNativeAwarenessTool } from '../src/native-awareness.js';

const event = (type: string, payload: unknown): RuntimeEvent => ({ type, payload, timestamp: 100 } as RuntimeEvent);
const physiologyWithLimit = (resolveInputLimit: (model: { providerId: string; modelId: string }) => number | undefined = () => 1_000) =>
  createNativePhysiology({ initialModel: { providerId: 'fixture', modelId: 'large' }, resolveInputLimit });

describe('native operational physiology', () => {
  it('bounds and redacts tool samples, invalidates changed context, and returns isolated copies', () => {
    const physiology = physiologyWithLimit();
    for (let i = 0; i < 40; i++) physiology.observe(event('tool.ended', {
      name: 'file', outcome: i < 8 ? 'failed' : 'success', input: 'secret', result: 'secret',
    }));
    expect(physiology.snapshot().tools).toEqual({ window: 32, observed: 32, failed: 0, cancelled: 0, blocked: 0 });
    physiology.observe(event('context.usage-changed', { currentContextTokens: 123, inputTokens: 9999, outputTokens: 5 }));
    const snapshot = physiology.snapshot();
    expect(snapshot.context).toEqual({
      current_tokens: 123, measured_at: 100, input_limit_tokens: 1_000,
      remaining_input_tokens: 877, saturation_basis_points: 1230,
    });
    snapshot.context!.current_tokens = 1;
    expect(physiology.snapshot().context?.current_tokens).toBe(123);
    physiology.observe(event('context.compacted', { reason: 'threshold', summary: 'secret' }));
    expect(physiology.snapshot().context).toBeUndefined();
    expect(physiology.snapshot().controls.compactions_committed).toBe(1);
    expect(JSON.stringify(physiology.snapshot())).not.toContain('secret');
    physiology.observe(event('context.usage-changed', { currentContextTokens: 123 }));
    physiology.observe(event('provider.request-started', { attempt: 1, maxAttempts: 2 }));
    expect(physiology.snapshot().context).toBeUndefined();
    physiology.observe(event('context.usage-changed', { currentContextTokens: 123 }));
    physiology.observe(event('model.selected', { providerId: 'fixture', modelId: 'small' }));
    expect(physiology.snapshot().context).toBeUndefined();
    expect(physiology.snapshot().controls.provider_attempt).toBeUndefined();
  });

  it('uses only a fresh matching model budget and withholds derived pressure when the limit is unknown', () => {
    const physiology = physiologyWithLimit(model => model.modelId === 'large' ? 1_000 : 80);
    physiology.observe(event('context.usage-changed', { currentContextTokens: 900 }));
    expect(physiology.snapshot().context).toMatchObject({ input_limit_tokens: 1_000, remaining_input_tokens: 100, saturation_basis_points: 9000 });

    physiology.observe(event('model.selected', { providerId: 'fixture', modelId: 'small' }));
    expect(physiology.snapshot().context).toBeUndefined();
    physiology.observe(event('context.usage-changed', { currentContextTokens: 72 }));
    expect(physiology.snapshot().context).toMatchObject({ input_limit_tokens: 80, remaining_input_tokens: 8, saturation_basis_points: 9000 });

    const unknown = physiologyWithLimit(() => undefined);
    unknown.observe(event('context.usage-changed', { currentContextTokens: 72 }));
    expect(unknown.snapshot().context).toEqual({ current_tokens: 72, measured_at: 100 });
    const invalid = physiologyWithLimit(() => Number.NaN);
    invalid.observe(event('context.usage-changed', { currentContextTokens: 72 }));
    expect(invalid.snapshot().context).toEqual({ current_tokens: 72, measured_at: 100 });
  });

  it('reports fresh pressure recovery without retaining prior saturation', () => {
    const physiology = physiologyWithLimit(() => 100);
    physiology.observe(event('context.usage-changed', { currentContextTokens: 95 }));
    expect(physiology.snapshot().context?.saturation_basis_points).toBe(9500);
    physiology.observe(event('context.compacted', { reason: 'threshold', summary: 'redacted' }));
    expect(physiology.snapshot().context).toBeUndefined();
    physiology.observe(event('context.usage-changed', { currentContextTokens: 20 }));
    expect(physiology.snapshot().context).toMatchObject({ remaining_input_tokens: 80, saturation_basis_points: 2000 });
  });

  it('projects the exact live kernel admission budget after a measured provider response', async () => {
    const modelLimits = { context: 100, output: 10 };
    const physiology = physiologyWithLimit(() => resolveModelInputBudget(modelLimits)!);
    const runtime = new RuntimeKernel({
      sessionId: sessionId('physiology-context-receipt'), modelLimits,
      contextTokenMeter: { measure: async () => 20 },
      model: { run: async () => ({ stop: 'complete' as const, usage: { inputTokens: 20, outputTokens: 5 } }) },
      emit: async receipt => physiology.observe(receipt),
    });
    try {
      await runtime.submit('measure live context');
      expect(physiology.snapshot().context).toEqual({
        current_tokens: 25, measured_at: expect.any(Number), input_limit_tokens: 85,
        remaining_input_tokens: 60, saturation_basis_points: 2941,
      });
    } finally { await runtime.stop(); }
  });

  it('withholds derived headroom after failed model receipt persistence while the selected kernel remains usable', async () => {
    const physiology = physiologyWithLimit(model => model.modelId === 'large' ? 1_000 : 80);
    const runtime = new RuntimeKernel({
      sessionId: sessionId('failed-model-receipt'),
      initialModel: { providerId: 'fixture', modelId: 'large' },
      contextTokenMeter: { measure: async () => 20 },
      model: { run: async () => ({ stop: 'complete' as const, usage: { inputTokens: 20, outputTokens: 5 } }) },
      emit: async receipt => {
        try {
          if (receipt.type === 'model.selected') throw new Error('session persistence failed');
          physiology.observe(receipt);
        } catch (error) {
          physiology.invalidateUnpersistedReceipt(receipt);
          throw error;
        }
      },
    });
    try {
      await runtime.submit('measure with large model');
      expect(physiology.snapshot().context?.input_limit_tokens).toBe(1_000);

      await expect(runtime.execute({ type: 'model.select', providerId: 'fixture', modelId: 'small' }))
        .resolves.toMatchObject({ ok: false, error: { message: 'session persistence failed' } });
      expect(runtime.snapshot().model).toEqual({ providerId: 'fixture', modelId: 'small' });
      expect(physiology.snapshot().context).toBeUndefined();

      await runtime.submit('kernel remains usable after persistence failure');
      expect(physiology.snapshot().context).toEqual({
        current_tokens: 25,
        measured_at: expect.any(Number),
      });
    } finally { await runtime.stop(); }
  });

  it('reports real core bounded retry enforcement through the admitted native attend tool', async () => {
    const db = new DatabaseSync(':memory:');
    initDb(db);
    const physiology = physiologyWithLimit();
    const tools = new ToolRegistry();
    registerNativeAwarenessTool(tools, {
      cwd: '/workspace', agentId: 'native-test', openDb: () => db, closeDb: () => {},
      observeRuntime: () => physiology.snapshot(),
    });
    let calls = 0;
    const runtime = new RuntimeKernel({
      sessionId: sessionId('physiology-runtime'), cwd: '/workspace', tools, maxProviderAttempts: 2,
      model: { run: async () => { calls++; throw new RuntimeFailure('provider', 'secret upstream body', 'safe'); } },
      emit: async receipt => physiology.observe(receipt),
    });
    try {
      await expect(runtime.submit('private input')).rejects.toThrow('secret upstream body');
      expect(calls).toBe(2);
      const result = await runtime.execute({ type: 'tool.execute', operationId: 'attend-live', name: 'awareness',
        input: { action: 'attend', request: { compact: true, runtimeObservation: { tools: { failed: 999 } } } } });
      expect(result).toMatchObject({ ok: true, data: { ok: true, content: { payload: {
        operational_state: { runtime: { schema_version: 1, source: 'native_runtime',
          controls: { owner: 'agent_core', retries_scheduled: 1, provider_attempt: 2, provider_max_attempts: 2 } } },
      } } } });
      expect(JSON.stringify(result)).not.toContain('private input');
      expect(JSON.stringify(result)).not.toContain('secret upstream');
      expect(JSON.stringify(result)).not.toContain('999');
      expect(calls).toBe(2);
    } finally { await runtime.stop(); db.close(); }
  });
});


it('enforces the newly selected catalog limit through native composition and durable compaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-selected-limit-'));
  const home = join(root, 'home');
  mkdirSync(join(home, 'agent'), { recursive: true });
  writeFileSync(join(home, 'agent', 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions',
    models: [{ id: 'large', contextWindow: 1000000, maxTokens: 10 }, { id: 'small', contextWindow: 100, maxTokens: 10 }],
  } } }));
  let providerCalls = 0;
  let summaryCalls = 0;
  const runtime = await createDefaultNativeRuntime({
    env: { OCTOCODE_HOME: home }, cwd: root,
    args: parseNativeArgs(['--no-session', '--model', 'fixture/large']), tools: new ToolRegistry(),
    model: { run: async (request, context) => {
      if (request.toolChoice === 'none') { summaryCalls++; await context.emit?.({ type: 'text', text: 'short summary' }); }
      else providerCalls++;
      return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
    } },
  });
  try {
    await runtime.start();
    await expect(runtime.execute({ type: 'model.select', providerId: 'fixture', modelId: 'small' })).resolves.toMatchObject({ ok: true });
    await expect(runtime.submit('small input with immutable native prompt')).rejects.toMatchObject({ category: 'model' });
    expect(summaryCalls).toBe(1);
    expect(providerCalls).toBe(0);
  } finally { await runtime.stop(); rmSync(root, { recursive: true, force: true }); }
});
