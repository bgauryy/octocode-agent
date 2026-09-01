import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LiveRuntimePlanState, ToolRegistry, sessionId, type RuntimePlanStateUpdater } from '@octocodeai/agent-core';
import {
  FilePlanStore,
  FileBackedRuntimePlanState,
  InMemoryPlanStore,
  NativePlanWorkerOwnership,
  registerNativePlanTool,
  type NativePlanInteraction,
  type NativePlanVerifier,
  type PlanStore,
  type RuntimePlanSnapshot,
  type PlanScope,
} from '../src/native-plan.js';

const scope = (session = 'session:one', workspace = '/workspace'): PlanScope => ({ sessionId: session, workspace });

function harness(options: { store?: PlanStore; interact?: NativePlanInteraction; verify?: NativePlanVerifier; onSnapshot?: (snapshot: RuntimePlanSnapshot) => void; planState?: RuntimePlanStateUpdater } = {}) {
  const registry = new ToolRegistry();
  const store = options.store ?? new InMemoryPlanStore();
  registerNativePlanTool(registry, {
    store,
    ...(options.interact ? { interact: options.interact } : {}),
    ...(options.verify ? { verify: options.verify } : {}),
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    ...(options.planState ? { planState: options.planState } : {}),
  });
  const tool = registry.get('plan')!;
  const controller = new AbortController();
  const update = vi.fn(async (_event: { message?: string }) => undefined);
  const execute = (input: unknown, selectedScope = scope(), signal = controller.signal) => tool.execute({
    input,
    callId: 'plan-call' as never,
    context: {
      sessionId: sessionId(selectedScope.sessionId),
      cwd: selectedScope.workspace,
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      signal,
    },
    signal,
    update,
  });
  return { store, tool, execute, update, controller };
}

describe('native plan tool', () => {
  it('refuses dependency scheduling that could bypass host verification', async () => {
    const store = new InMemoryPlanStore();
    const { execute } = harness({ store });
    const ownership = new NativePlanWorkerOwnership(store, {
      getGraph: vi.fn(),
    });
    await execute({ action: 'set', steps: [{ text: 'Build', checkCommand: 'yarn test' }] });

    await expect(ownership.prepare(scope(), new AbortController().signal))
      .rejects.toThrow(/cannot bypass host verification/i);
  });

  it('claims one runnable active step per worker and releases it without completing or verifying', async () => {
    const store = new InMemoryPlanStore();
    const { execute } = harness({ store });
    const ownership = new NativePlanWorkerOwnership(store);
    await execute({ action: 'set', steps: [{ text: 'Build', checkCommand: 'yarn test' }, { text: 'Ship', dependsOn: [1] }] });

    await expect(ownership.claim({ scope: scope(), planStepId: 'step:1:2', workerId: 'worker:blocked' }))
      .rejects.toThrow(/blocked/i);
    await expect(ownership.claim({ scope: scope(), planStepId: 'step:1:1', workerId: 'worker:one' }))
      .resolves.toMatchObject({ planStepId: 'step:1:1', workerId: 'worker:one', status: 'active' });
    await expect(ownership.claim({ scope: scope(), planStepId: 'step:1:1', workerId: 'worker:two' }))
      .rejects.toThrow(/owned|active/i);
    const claimed = (await execute({ action: 'show' })).content as { plan: { phase: string; steps: Array<Record<string, unknown>> } };
    expect(claimed.plan.phase).toBe('active');
    expect(claimed.plan.steps[0]).toMatchObject({ id: 'step:1:1', status: 'doing', workerId: 'worker:one' });
    await expect(execute({ action: 'complete', index: 1 })).resolves.toMatchObject({ ok: false, category: 'worker-owned-step' });
    await expect(execute({ action: 'clear' })).resolves.toMatchObject({ ok: false, category: 'worker-owned-step' });
    await expect(execute({ action: 'set', steps: ['Replacement'] })).resolves.toMatchObject({ ok: false, category: 'worker-owned-step' });

    await expect(ownership.release({ scope: scope(), planStepId: 'step:1:1', workerId: 'worker:one' }))
      .resolves.toMatchObject({ planStepId: 'step:1:1', workerId: 'worker:one', status: 'released' });
    const shown = (await execute({ action: 'show' })).content as { plan: { phase: string; steps: Array<Record<string, unknown>> } };
    expect(shown.plan.phase).toBe('active');
    expect(shown.plan.steps[0]).toMatchObject({ id: 'step:1:1', status: 'todo' });
    const released = (await store.load(scope()))!;
    expect(released.steps[0]).not.toHaveProperty('workerId');
    expect(released.steps[0]).not.toHaveProperty('receipt');
  });

  it('rejects worker claims when the plan phase is not active', async () => {
    const store = new InMemoryPlanStore();
    const { execute } = harness({ store, interact: async () => ({ status: 'pending' }) });
    const ownership = new NativePlanWorkerOwnership(store);
    await execute({ action: 'propose', steps: ['Draft work'] });
    await expect(ownership.claim({ scope: scope(), planStepId: 'step:1:1', workerId: 'worker:one' }))
      .rejects.toThrow(/active plan/i);
  });

  it('synchronizes active phase and authoritative revision into live runtime policy state', async () => {
    const planState = new LiveRuntimePlanState();
    const { execute } = harness({
      planState,
      interact: async () => ({ status: 'approved' }),
    });

    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 0, active: false });
    await execute({ action: 'set', steps: ['Build'] });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 1, active: true });
    await execute({ action: 'start', index: 1 });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 2, active: true });
    await execute({ action: 'complete', index: 1 });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 3, active: false });
    await execute({ action: 'add', text: 'Ship' });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 4, active: true });
    await execute({ action: 'propose' });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 6, active: false });
    await execute({ action: 'clear' });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 7, active: false });
    await execute({ action: 'show' });
    expect(planState.snapshot()).toEqual({ authority: 'runtime', revision: 7, active: false });
  });

  it('projects successful plan commits and reads into authoritative runtime snapshots', async () => {
    const observed: RuntimePlanSnapshot[] = [];
    const { execute } = harness({
      onSnapshot: (snapshot) => observed.push(snapshot),
      verify: async ({ command }) => ({ command, status: 'SUCCESS', message: 'passed' }),
    });

    await execute({ action: 'show' });
    expect(observed).toEqual([]);

    await execute({ action: 'set', steps: [
      { text: 'Build', checkCommand: 'yarn test' },
      { text: 'Ship', dependsOn: [1] },
    ] });
    await execute({ action: 'start', index: 1 });
    await execute({ action: 'complete', index: 1 });
    await execute({ action: 'show' });

    expect(observed).toHaveLength(4);
    expect(observed[0]).toMatchObject({
      authority: 'runtime',
      planId: expect.stringMatching(/^plan:[a-f0-9]{64}$/),
      scope: scope(),
      revision: 1,
      phase: 'active',
      steps: [
        { id: 'step:1:1', text: 'Build', status: 'todo', checkCommand: 'yarn test' },
        { id: 'step:1:2', text: 'Ship', status: 'todo', dependsOn: ['step:1:1'] },
      ],
    });
    expect(observed[2]?.revision).toBe(3);
    expect(observed[2]?.steps[0]).toMatchObject({
      id: 'step:1:1',
      status: 'done',
      receipt: { authority: 'runtime', command: 'yarn test', status: 'SUCCESS', message: 'passed' },
    });
    expect(observed[3]).toEqual(observed[2]);
    expect(observed.every((snapshot) => snapshot.planId === observed[0]!.planId)).toBe(true);
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(Object.isFrozen(observed[0]!.steps)).toBe(true);
  });

  it('isolates committed plan state from observer failures and does not emit failed validation', async () => {
    const onSnapshot = vi.fn(() => { throw new Error('renderer unavailable'); });
    const { execute } = harness({ onSnapshot });

    await expect(execute({ action: 'set', steps: ['Persisted'] })).resolves.toMatchObject({ ok: true });
    expect(onSnapshot).toHaveBeenCalledOnce();
    await expect(execute({ action: 'start', index: 99 })).resolves.toMatchObject({ ok: false, category: 'invalid-index' });
    expect(onSnapshot).toHaveBeenCalledOnce();
    await expect(execute({ action: 'show' })).resolves.toMatchObject({ ok: true, content: { plan: { revision: 1 } } });
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('runs a dependency- and verification-gated lifecycle with immutable snapshots', async () => {
    const verify = vi.fn<NativePlanVerifier>()
      .mockResolvedValueOnce({ command: 'test implementation', status: 'FAILED', message: 'failed' })
      .mockResolvedValueOnce({ command: 'test implementation', status: 'SUCCESS', message: 'passed' });
    const { execute, update } = harness({ verify });
    const set = await execute({ action: 'set', steps: [
      { text: 'Implement', activeForm: 'Implementing', checkCommand: 'test implementation' },
      { text: 'Verify', dependsOn: [1] },
    ] });
    expect(set).toMatchObject({ ok: true, content: { status: 'set', plan: { phase: 'active', revision: 1 } } });

    expect(await execute({ action: 'start', index: 1 })).toMatchObject({ ok: true, content: { status: 'started' } });
    expect(await execute({ action: 'complete', index: 1, receipt: { command: 'test implementation', status: 'SUCCESS', message: 'fabricated' } }))
      .toMatchObject({ ok: false, category: 'invalid-receipt' });
    expect(verify).not.toHaveBeenCalled();
    const failedReceipt = await execute({ action: 'complete', index: 1 });
    expect(failedReceipt).toMatchObject({ ok: false, category: 'verification-failed' });
    expect((failedReceipt.content as { plan: { steps: Array<{ status: string }> } }).plan.steps[0]?.status).toBe('doing');
    expect(await execute({ action: 'complete', index: 1 }))
      .toMatchObject({ ok: true, content: { status: 'completed' } });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(await execute({ action: 'start', index: 2 })).toMatchObject({ ok: true, content: { status: 'started' } });
    const completed = await execute({ action: 'complete', index: 2 });
    expect(completed).toMatchObject({ ok: true, content: { status: 'completed', plan: { phase: 'complete' } } });

    const shown = await execute({ action: 'show' });
    const plan = (shown.content as { plan: { steps: Array<{ text: string; status: string }> } }).plan;
    expect(plan.steps.map(({ text, status }) => ({ text, status }))).toEqual([
      { text: 'Implement', status: 'done' },
      { text: 'Verify', status: 'done' },
    ]);
    expect(() => { plan.steps[0]!.text = 'mutated'; }).toThrow();
    expect(((await execute({ action: 'show' })).content as { plan: { steps: Array<{ text: string }> } }).plan.steps[0]?.text).toBe('Implement');
    expect(await execute({ action: 'add', text: 'Document', dependsOn: [2] })).toMatchObject({ ok: true, content: { status: 'added' } });
    expect(await execute({ action: 'remove', index: 3 })).toMatchObject({ ok: true, content: { status: 'removed' } });
    expect(await execute({ action: 'clear' })).toMatchObject({ ok: true, content: { status: 'cleared', plan: { phase: 'empty', steps: [] } } });
    expect(update.mock.calls.flatMap(([event]) => event.message ?? [])).toEqual(expect.arrayContaining(['Setting plan', 'Plan set', 'Completing step 1']));
  });

  it('requires a host verifier and rejects mismatched verifier receipts', async () => {
    const unverified = harness();
    await unverified.execute({ action: 'set', steps: [{ text: 'Check', checkCommand: 'yarn test' }] });
    await unverified.execute({ action: 'start', index: 1 });
    expect(await unverified.execute({ action: 'complete', index: 1 })).toMatchObject({ ok: false, category: 'verification-required' });

    const mismatched = harness({ verify: async () => ({ command: 'another command', status: 'SUCCESS', message: 'passed' }) });
    await mismatched.execute({ action: 'set', steps: [{ text: 'Check', checkCommand: 'yarn test' }] });
    await mismatched.execute({ action: 'start', index: 1 });
    expect(await mismatched.execute({ action: 'complete', index: 1 })).toMatchObject({ ok: false, category: 'invalid-receipt' });
    expect(await mismatched.execute({ action: 'show' })).toMatchObject({ content: { plan: { steps: [{ status: 'doing' }] } } });
  });

  it('rejects invalid targets, blocked dependencies, and cycles while allowing four concurrent active steps', async () => {
    const { execute } = harness();
    expect(await execute({ action: 'set', steps: [{ text: 'A', dependsOn: [2] }, { text: 'B', dependsOn: [1] }] }))
      .toMatchObject({ ok: false, category: 'invalid-dependencies' });
    await execute({ action: 'set', steps: [{ text: 'A' }, { text: 'B', dependsOn: [1] }, { text: 'C' }] });
    expect(await execute({ action: 'start', index: 2 })).toMatchObject({ ok: false, category: 'blocked-step' });
    expect(await execute({ action: 'start', index: 0 })).toMatchObject({ ok: false, category: 'invalid-index' });
    expect(await execute({ action: 'remove', index: 1 })).toMatchObject({ ok: false, category: 'dependency-in-use' });
    await execute({ action: 'start', index: 1 });
    expect(await execute({ action: 'start', index: 3 })).toMatchObject({ ok: true, content: { status: 'started' } });
    expect(await execute({ action: 'complete', index: 2 })).toMatchObject({ ok: false, category: 'not-active' });

    const parallel = harness();
    await parallel.execute({ action: 'set', steps: ['A', 'B', 'C', 'D', 'E'] });
    for (let index = 1; index <= 4; index += 1) {
      expect(await parallel.execute({ action: 'start', index })).toMatchObject({ ok: true });
    }
    expect(await parallel.execute({ action: 'start', index: 5 })).toMatchObject({
      ok: false,
      category: 'active-step-limit',
    });
  });

  it('edits by stable ID with a revision precondition and invalidates affected verification', async () => {
    const verify: NativePlanVerifier = async ({ command }) => ({ command, status: 'SUCCESS', message: 'passed' });
    const { execute } = harness({ verify });
    await execute({ action: 'set', steps: [
      { text: 'Build', checkCommand: 'test build' },
      { text: 'Ship', dependsOn: [1], checkCommand: 'test ship' },
    ] });
    await execute({ action: 'start', index: 1 });
    await execute({ action: 'complete', index: 1 });
    await execute({ action: 'start', index: 2 });
    await execute({ action: 'complete', index: 2 });

    expect(await execute({
      action: 'edit',
      expectedRevision: 4,
      stepId: 'step:1:1',
      text: 'Build safely',
    })).toMatchObject({ ok: false, category: 'stale-revision' });

    const edited = await execute({
      action: 'edit',
      expectedRevision: 5,
      stepId: 'step:1:1',
      text: 'Build safely',
      activeForm: 'Building safely',
      checkCommand: 'test safe build',
    });
    expect(edited).toMatchObject({
      ok: true,
      content: {
        status: 'edited',
        stepId: 'step:1:1',
        invalidatedStepIds: ['step:1:1', 'step:1:2'],
        plan: {
          revision: 6,
          phase: 'active',
          steps: [
            { id: 'step:1:1', text: 'Build safely', status: 'todo', checkCommand: 'test safe build' },
            { id: 'step:1:2', text: 'Ship', status: 'todo' },
          ],
        },
      },
    });
    const plan = (edited.content as { plan: { steps: Array<Record<string, unknown>> } }).plan;
    expect(plan.steps[0]).not.toHaveProperty('receipt');
    expect(plan.steps[1]).not.toHaveProperty('receipt');
  });

  it('reorders and changes dependencies using stable IDs without index drift', async () => {
    const { execute } = harness();
    await execute({ action: 'set', steps: [
      { text: 'A' },
      { text: 'B', dependsOn: [1] },
      { text: 'C', dependsOn: [2] },
    ] });

    const reordered = await execute({
      action: 'reorder',
      expectedRevision: 1,
      stepIds: ['step:1:3', 'step:1:1', 'step:1:2'],
    });
    expect(reordered).toMatchObject({
      ok: true,
      content: {
        status: 'reordered',
        plan: {
          revision: 2,
          steps: [
            { id: 'step:1:3', dependsOn: [3] },
            { id: 'step:1:1' },
            { id: 'step:1:2', dependsOn: [2] },
          ],
        },
      },
    });

    expect(await execute({
      action: 'dependency',
      expectedRevision: 2,
      stepId: 'step:1:1',
      dependsOnStepIds: ['step:1:3'],
    })).toMatchObject({ ok: false, category: 'invalid-dependencies' });
    expect(await execute({
      action: 'dependency',
      expectedRevision: 2,
      stepId: 'step:1:1',
      dependsOnStepIds: [],
    })).toMatchObject({ ok: true, content: { status: 'dependencies-changed', plan: { revision: 3 } } });
  });

  it('reopens by stable ID and exposes explicit approve, reject, and change-request review transitions', async () => {
    const { execute } = harness({ verify: async ({ command }) => ({ command, status: 'SUCCESS', message: 'passed' }) });
    await execute({ action: 'set', steps: [{ text: 'Build', checkCommand: 'test build' }] });
    await execute({ action: 'start', index: 1 });
    await execute({ action: 'complete', index: 1 });
    expect(await execute({ action: 'reopen', expectedRevision: 3, stepId: 'step:1:1' })).toMatchObject({
      ok: true,
      content: { status: 'reopened', plan: { revision: 4, phase: 'active', steps: [{ status: 'todo' }] } },
    });

    const proposed = await execute({ action: 'propose' });
    expect(proposed).toMatchObject({ content: { plan: { revision: 5, phase: 'draft' } } });
    expect(await execute({ action: 'approve', expectedRevision: 4 })).toMatchObject({ ok: false, category: 'stale-revision' });
    expect(await execute({ action: 'approve', expectedRevision: 5 })).toMatchObject({
      ok: true,
      content: { status: 'approved', plan: { revision: 6, phase: 'approved' } },
    });
    expect(await execute({ action: 'change-request', expectedRevision: 6, feedback: 'Add rollout checks' })).toMatchObject({
      ok: true,
      content: { status: 'changes-requested', plan: { revision: 7, phase: 'draft' } },
    });
    expect(await execute({ action: 'reject', expectedRevision: 7, feedback: 'Unsafe scope' })).toMatchObject({
      ok: true,
      content: { status: 'rejected', plan: { revision: 8, phase: 'draft' } },
    });
  });

  it('previews typed review intents and a stable-ID diff without mutating the plan', async () => {
    const { execute } = harness();
    await execute({ action: 'set', steps: ['Build', 'Verify'] });
    const review = await execute({
      action: 'review',
      expectedRevision: 1,
      intents: [
        { type: 'edit', stepId: 'step:1:1', text: 'Build safely' },
        { type: 'dependency', stepId: 'step:1:2', dependsOnStepIds: ['step:1:1'] },
        { type: 'reorder', stepIds: ['step:1:2', 'step:1:1'] },
      ],
    });
    expect(review).toMatchObject({
      ok: true,
      content: {
        status: 'reviewed',
        expectedRevision: 1,
        diff: [
          { type: 'step-edited', stepId: 'step:1:1' },
          { type: 'dependencies-changed', stepId: 'step:1:2', afterStepIds: ['step:1:1'] },
          { type: 'steps-reordered', afterStepIds: ['step:1:2', 'step:1:1'] },
        ],
        proposed: { revision: 1, steps: [{ id: 'step:1:2' }, { id: 'step:1:1', text: 'Build safely' }] },
      },
    });
    expect(await execute({ action: 'show' })).toMatchObject({
      content: { plan: { revision: 1, steps: [{ id: 'step:1:1', text: 'Build' }, { id: 'step:1:2', text: 'Verify' }] } },
    });
  });

  it('keeps proposed and clarified drafts pending without an interaction provider', async () => {
    const { execute } = harness();
    const proposed = await execute({ action: 'propose', steps: ['Research', 'Implement'] });
    expect(proposed).toMatchObject({ ok: false, category: 'interaction-required', content: { status: 'interaction-required', action: 'propose', plan: { phase: 'draft' } } });
    expect(await execute({ action: 'start', index: 1 })).toMatchObject({ ok: false, category: 'approval-required' });
    const clarified = await execute({ action: 'clarify', questions: [{ prompt: 'Which rollout?' }] });
    expect(clarified).toMatchObject({ ok: false, category: 'interaction-required', content: { status: 'interaction-required', action: 'clarify', plan: { phase: 'draft' } } });
  });

  it('records explicit approval and clarification outcomes through the interaction port', async () => {
    const interact = vi.fn<NativePlanInteraction>(async (request) => request.action === 'propose'
      ? { status: 'approved' }
      : { status: 'answered', answers: ['Canary first'] });
    const { execute } = harness({ interact });
    expect(await execute({ action: 'propose', steps: ['Ship safely'] })).toMatchObject({ ok: true, content: { status: 'approved', plan: { phase: 'approved' } } });
    expect(await execute({ action: 'clarify', questions: [{ prompt: 'Rollout?' }] })).toMatchObject({
      ok: true,
      content: { status: 'clarified', plan: { decisions: [{ question: 'Rollout?', answer: 'Canary first' }] } },
    });
  });

  it('keeps an explicitly pending proposal as a non-executable draft', async () => {
    const { execute } = harness({ interact: async () => ({ status: 'pending', correlationId: 'approval-1' }) });
    expect(await execute({ action: 'propose', steps: ['Wait for approval'] })).toMatchObject({
      ok: true,
      content: { status: 'pending', outcome: { correlationId: 'approval-1' }, plan: { phase: 'draft' } },
    });
    expect(await execute({ action: 'start', index: 1 })).toMatchObject({ ok: false, category: 'approval-required' });
  });

  it('does not mutate approved state after cancellation during interaction', async () => {
    const controller = new AbortController();
    const interact: NativePlanInteraction = async () => {
      controller.abort('cancelled');
      return { status: 'approved' };
    };
    const { execute } = harness({ interact });
    const result = await execute({ action: 'propose', steps: ['Draft only'] }, scope(), controller.signal);
    expect(result).toMatchObject({ ok: false, category: 'cancelled' });
    expect(await execute({ action: 'show' })).toMatchObject({ content: { plan: { phase: 'draft', revision: 1 } } });
    expect(await execute({ action: 'add', text: 'Must not appear' }, scope(), controller.signal)).toMatchObject({ ok: false, category: 'cancelled' });
    expect(await execute({ action: 'show' })).toMatchObject({ content: { plan: { revision: 1, steps: [{ text: 'Draft only' }] } } });
  });

  it('isolates plan state by both session and workspace', async () => {
    const store = new InMemoryPlanStore();
    const { execute } = harness({ store });
    await execute({ action: 'set', steps: ['One'] }, scope('session:a', '/one'));
    await execute({ action: 'set', steps: ['Two'] }, scope('session:a', '/two'));
    await execute({ action: 'set', steps: ['Three'] }, scope('session:b', '/one'));

    expect(await store.load(scope('session:a', '/one'))).toMatchObject({ steps: [{ text: 'One' }] });
    expect(await store.load(scope('session:a', '/two'))).toMatchObject({ steps: [{ text: 'Two' }] });
    expect(await store.load(scope('session:b', '/one'))).toMatchObject({ steps: [{ text: 'Three' }] });
  });

  it('persists immutable scoped plans across store instances', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-plans-'));
    const first = new FilePlanStore(directory);
    const selected = scope('session:durable', '/workspace');
    const snapshot = {
      version: 1 as const,
      scope: selected,
      revision: 1,
      phase: 'approved' as const,
      steps: [{ id: 'step:1:1', text: 'Persist me', status: 'todo' as const }],
      decisions: [],
    };
    await first.save(selected, 0, snapshot);

    const loaded = await new FilePlanStore(directory).load(selected);
    expect(loaded).toEqual(snapshot);
    expect(Object.isFrozen(loaded)).toBe(true);
    await expect(first.save(selected, 0, { ...snapshot, revision: 2 })).rejects.toThrow(/revision/i);
  });

  it('refreshes runtime plan policy from peer-process commits before admission', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-plan-policy-'));
    const selected = scope('session:shared-policy', '/workspace');
    const reader = new FilePlanStore(directory);
    const writer = new FilePlanStore(directory);
    const state = new FileBackedRuntimePlanState(reader, selected);

    expect(state.snapshot()).toEqual({ authority: 'runtime', revision: 0, active: false });
    await writer.save(selected, 0, {
      version: 1,
      scope: selected,
      revision: 1,
      phase: 'active',
      steps: [{ id: 'step:1:1', text: 'Shared work', status: 'doing' }],
      decisions: [],
    });

    expect(state.snapshot()).toEqual({ authority: 'runtime', revision: 1, active: true });
  });

  it('recovers a stale cross-process plan lock without losing CAS protection', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-plan-lock-'));
    const selected = scope('session:stale-lock', '/workspace');
    const store = new FilePlanStore(directory);
    const first = {
      version: 1 as const,
      scope: selected,
      revision: 1,
      phase: 'active' as const,
      steps: [{ id: 'step:1:1', text: 'Locked work', status: 'doing' as const }],
      decisions: [],
    };
    await store.save(selected, 0, first);
    const planFile = fs.readdirSync(directory).find((entry) => entry.endsWith('.json'))!;
    const lock = path.join(directory, `${planFile}.lock`);
    fs.writeFileSync(lock, 'stale', { mode: 0o600 });
    const stale = new Date(Date.now() - 31_000);
    fs.utimesSync(lock, stale, stale);

    await store.save(selected, 1, { ...first, revision: 2, phase: 'complete', steps: [{ ...first.steps[0]!, status: 'done' }] });

    expect((await store.load(selected))?.revision).toBe(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('fails closed on malformed durable records before they can hydrate runtime authority', async () => {
    type MutableStoredPlan = { phase: string; steps: Array<Record<string, unknown>> };
    const malformed = [
      { label: 'unknown field', mutate: (value: MutableStoredPlan) => { value.steps[0]!.trusted = true; } },
      { label: 'invalid phase', mutate: (value: MutableStoredPlan) => { value.phase = 'running'; } },
      { label: 'invalid status', mutate: (value: MutableStoredPlan) => { value.steps[0]!.status = 'finished'; } },
      { label: 'cyclic dependencies', mutate: (value: MutableStoredPlan) => { value.steps[0]!.dependsOn = [2]; value.steps.push({ id: 'step:1:2', text: 'Other', status: 'todo', dependsOn: [1] }); } },
      { label: 'fabricated receipt', mutate: (value: MutableStoredPlan) => { value.steps[0]!.receipt = { command: 'yarn test', status: 'SUCCESS', message: 'claimed' }; } },
      { label: 'invalid complete invariant', mutate: (value: MutableStoredPlan) => { value.phase = 'complete'; } },
    ] satisfies Array<{ label: string; mutate: (value: MutableStoredPlan) => void }>;

    for (const scenario of malformed) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-plan-invalid-'));
      const store = new FilePlanStore(directory);
      const selected = scope(`session:${scenario.label}`, '/workspace');
      await store.save(selected, 0, {
        version: 1,
        scope: selected,
        revision: 1,
        phase: 'active',
        steps: [{ id: 'step:1:1', text: 'Persist me', status: 'todo', checkCommand: 'yarn test' }],
        decisions: [],
      });
      const file = path.join(directory, fs.readdirSync(directory).find((entry) => entry.endsWith('.json'))!);
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as MutableStoredPlan;
      scenario.mutate(value);
      fs.writeFileSync(file, JSON.stringify(value), 'utf8');

      await expect(store.load(selected), scenario.label).rejects.toBeInstanceOf(Error);
      const onSnapshot = vi.fn();
      const runtime = harness({ store, onSnapshot });
      expect(await runtime.execute({ action: 'show' }, selected), scenario.label).toMatchObject({ ok: false, category: 'invalid-plan' });
      expect(onSnapshot, scenario.label).not.toHaveBeenCalled();
    }
  });
});
