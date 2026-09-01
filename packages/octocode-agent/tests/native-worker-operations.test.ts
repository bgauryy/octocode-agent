import { describe, expect, it, vi } from 'vitest';
import {
  correlationId,
  sessionId,
  workerId,
  type WorkerController,
  type WorkerSnapshot,
} from '@octocodeai/agent-core';
import {
  NativeWorkerOperationsController,
  NativeWorkerOperationsError,
} from '../src/native-worker-operations.js';

function worker(
  id: string,
  state: WorkerSnapshot['state'] = 'running',
  extras: Record<string, unknown> = {},
): WorkerSnapshot {
  return {
    schemaVersion: 1,
    packetId: `spawn:${id}` as never,
    workerId: workerId(id),
    correlationId: correlationId(`correlation:${id}`),
    sessionId: sessionId('session:one'),
    redaction: 'internal',
    state,
    queueDepth: 0,
    capabilities: {
      tools: ['bash'],
      models: [{ providerId: 'openai', modelId: 'secret-model' }],
      maxTurns: 20,
    },
    ...extras,
  } as WorkerSnapshot;
}

function harness(initial: WorkerSnapshot[] = [worker('worker-1')]) {
  let workers = initial;
  const execute = vi.fn<WorkerController['execute']>(async (command) => {
    if (command.type === 'list') return workers;
    if (command.type === 'status') return workers.find((entry) => entry.workerId === command.workerId) ?? null;
    if (command.type === 'abort') {
      workers = workers.map((entry) => entry.workerId === command.workerId ? worker(String(entry.workerId), 'aborting') : entry);
    }
    if (command.type === 'kill') {
      workers = workers.map((entry) => entry.workerId === command.workerId ? worker(String(entry.workerId), 'killed') : entry);
    }
    return undefined;
  });
  return { controller: { execute } satisfies WorkerController, execute };
}

describe('NativeWorkerOperationsController', () => {
  it('opens read-only and projects a bounded inbox without private worker material', async () => {
    const raw = worker('worker-1', 'running', {
      pid: 1234,
      prompt: 'secret prompt',
      hiddenReasoning: 'chain of thought',
      terminal: {
        type: 'worker.terminal',
        outcome: 'failed',
        reason: 'private process failure',
        handback: { text: 'private handback' },
      },
    });
    const { controller, execute } = harness([raw]);
    const operations = new NativeWorkerOperationsController({ controller, now: () => 100 });

    const snapshot = await operations.open();
    expect(execute).toHaveBeenCalledWith({ type: 'list' });
    expect(snapshot).toEqual({
      authority: 'runtime',
      generation: 1,
      capturedAt: 100,
      workers: [{
        workerId: 'worker-1',
        state: 'running',
        queueDepth: 0,
        availableActions: ['inspect', 'send', 'follow-up', 'steer', 'abort'],
        forceKillAvailable: true,
      }],
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/pid|prompt|capabilit|reason|handback|model|correlation|session|reasoning/iu);
  });

  it('keeps inspect and refresh read-only while rejecting stale generations clearly', async () => {
    const { controller, execute } = harness();
    const operations = new NativeWorkerOperationsController({ controller, now: () => 200 });
    await operations.open();

    const inspected = await operations.dispatch({ type: 'inspect', expectedGeneration: 1, workerId: 'worker-1' });
    expect(inspected.generation).toBe(2);
    expect(inspected.selectedWorkerId).toBe('worker-1');
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual(['list', 'status']);

    await expect(operations.dispatch({
      type: 'send',
      expectedGeneration: 1,
      workerId: 'worker-1',
      text: 'late input',
    })).rejects.toMatchObject({ category: 'stale-generation' } satisfies Partial<NativeWorkerOperationsError>);
    expect(execute).toHaveBeenCalledTimes(2);

    const refreshed = await operations.dispatch({ type: 'refresh' });
    expect(refreshed.generation).toBe(3);
    expect(refreshed.selectedWorkerId).toBe('worker-1');
  });

  it('sends typed input actions through the bound worker identity and refreshes after each action', async () => {
    const { controller, execute } = harness();
    const operations = new NativeWorkerOperationsController({
      controller,
      now: () => 300,
      idFactory: (() => {
        let id = 0;
        return () => `worker-operation:${++id}`;
      })(),
    });
    await operations.open();

    await operations.dispatch({ type: 'send', expectedGeneration: 1, workerId: 'worker-1', text: 'new input' });
    await operations.dispatch({ type: 'follow-up', expectedGeneration: 2, workerId: 'worker-1', text: 'next task' });
    await operations.dispatch({ type: 'steer', expectedGeneration: 3, workerId: 'worker-1', text: 'change direction' });

    const commands = execute.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command.type === 'send' || command.type === 'follow-up' || command.type === 'steer'))
      .toMatchObject([
        { type: 'send', packet: { type: 'worker.send', workerId: 'worker-1', text: 'new input' } },
        { type: 'follow-up', packet: { type: 'worker.follow-up', workerId: 'worker-1', text: 'next task' } },
        { type: 'steer', packet: { type: 'worker.steer', workerId: 'worker-1', text: 'change direction' } },
      ]);
    expect(operations.snapshot().generation).toBe(4);
  });

  it('keeps graceful abort ordinary and force kill behind a separate approval gate', async () => {
    const approveForceKill = vi.fn(async () => false);
    const { controller, execute } = harness();
    const operations = new NativeWorkerOperationsController({ controller, approveForceKill });
    await operations.open();

    await operations.dispatch({ type: 'abort', expectedGeneration: 1, workerId: 'worker-1', reason: 'stop safely' });
    expect(execute).toHaveBeenCalledWith({ type: 'abort', workerId: 'worker-1', reason: 'stop safely' });

    await expect(operations.dispatch({ type: 'kill', expectedGeneration: 2, workerId: 'worker-1', reason: 'force stop' }))
      .rejects.toMatchObject({ category: 'approval-denied' } satisfies Partial<NativeWorkerOperationsError>);
    expect(approveForceKill).toHaveBeenCalledWith({
      workerId: 'worker-1',
      state: 'aborting',
      consequence: 'Immediately terminate the worker; in-flight work may be left uncertain.',
    });
    expect(execute.mock.calls.some(([command]) => command.type === 'kill')).toBe(false);
  });

  it('fails closed when force-kill approval is unavailable', async () => {
    const { controller, execute } = harness();
    const operations = new NativeWorkerOperationsController({ controller });
    await operations.open();
    await expect(operations.dispatch({ type: 'kill', expectedGeneration: 1, workerId: 'worker-1' }))
      .rejects.toMatchObject({ category: 'approval-required' } satisfies Partial<NativeWorkerOperationsError>);
    expect(execute.mock.calls.some(([command]) => command.type === 'kill')).toBe(false);
  });
});
