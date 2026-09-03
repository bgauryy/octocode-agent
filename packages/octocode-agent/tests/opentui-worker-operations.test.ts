import { describe, expect, it } from 'vitest';
import type { NativeWorkerInboxSnapshot } from '../src/native-worker-operations.js';
import { WorkerOperationsWidget } from '../src/terminal/opentui/widgets/worker-operations.js';

function snapshot(overrides: Partial<NativeWorkerInboxSnapshot> = {}): NativeWorkerInboxSnapshot {
  return {
    authority: 'runtime',
    generation: 3,
    capturedAt: 100,
    workers: [
      {
        workerId: 'worker-1',
        state: 'running',
        queueDepth: 1,
        taskLabel: 'Check auth flow',
        availableActions: ['inspect', 'send', 'follow-up', 'steer', 'abort'],
        forceKillAvailable: true,
      },
      {
        workerId: 'worker-2',
        state: 'succeeded',
        queueDepth: 0,
        terminalOutcome: 'succeeded',
        availableActions: ['inspect'],
        forceKillAvailable: false,
      },
    ],
    ...overrides,
  };
}

function widget(value = snapshot()): WorkerOperationsWidget {
  const instance = new WorkerOperationsWidget('worker-inbox', value, { widthColumns: 80, viewportRows: 4 });
  instance.mount();
  instance.activate();
  instance.focus();
  return instance;
}

describe('WorkerOperationsWidget', () => {
  it('renders a safe generation-scoped inbox with read-only inspection first', () => {
    const instance = widget();
    const rendered = instance.render();
    expect(rendered.accessibility).toMatchObject({ role: 'listbox', label: 'Worker inbox' });
    expect(rendered.regions.map(({ id }) => id)).toEqual([
      'summary',
      'worker-worker-1',
      'worker-worker-2',
      'actions',
      'help',
    ]);
    expect(rendered.regions[1]?.text).toContain('> worker-1 [RUNNING]');
    expect(rendered.regions[1]?.text).toContain('queue 1');
    expect(instance.toPlainText()).toContain('Read-only: /workers status worker-1 3');
    expect(instance.toPlainText()).toContain('Send: /workers send worker-1 3 <message>');
    expect(instance.toPlainText()).toContain('Graceful abort: /workers abort worker-1 3 [reason]');
    expect(instance.toPlainText()).toContain('Force kill (approval required): /workers kill worker-1 3 [reason]');
    expect(rendered.regions.map(({ text }) => text).join('\n')).not.toContain('Check auth flow');
    expect(instance.toPlainText()).not.toContain('Check auth flow');
  });

  it('emits only a typed inspect intent while navigation remains observational', () => {
    const instance = widget();
    expect(instance.handleInput({ type: 'key', key: 'arrowdown' })).toEqual({ status: 'handled' });
    expect(instance.selectedWorkerId).toBe('worker-2');
    expect(instance.handleInput({ type: 'key', key: 'enter' })).toEqual({
      status: 'handled',
      output: { type: 'inspect', expectedGeneration: 3, workerId: 'worker-2' },
    });
    expect(instance.handleInput({ type: 'text', text: 'kill' })).toEqual({ status: 'ignored' });
  });

  it('rejects stale generations and preserves selection by stable ID across updates', () => {
    const instance = widget();
    instance.handleInput({ type: 'key', key: 'arrowdown' });
    expect(() => instance.update(snapshot({ generation: 2 }))).toThrow(/stale generation/i);
    instance.update(snapshot({ generation: 4, workers: [...snapshot().workers].reverse() }));
    expect(instance.selectedWorkerId).toBe('worker-2');
  });

  it('announces each accepted inbox generation once with only bounded public state', () => {
    const instance = widget();
    expect(instance.takeAnnouncements()).toEqual([
      'Worker inbox — generation 3 — 2 workers',
    ]);
    expect(instance.takeAnnouncements()).toEqual([]);

    instance.update(snapshot({ generation: 4, capturedAt: 200 }));
    expect(instance.takeAnnouncements()).toEqual([
      'Worker inbox — generation 4 — 2 workers',
    ]);
    expect(instance.takeAnnouncements()).toEqual([]);
  });

  it('never renders private worker process or prompt fields smuggled into a snapshot', () => {
    const poisoned = {
      ...snapshot(),
      workers: [{
        ...snapshot().workers[0],
        pid: 1234,
        prompt: 'secret task prompt',
        capabilities: ['bash'],
        hiddenReasoning: 'private thought',
        taskLabel: 'PRIVATE_ASSIGNMENT',
        planStepId: 'PRIVATE_PLAN_STEP',
      }],
    } as unknown as NativeWorkerInboxSnapshot;
    const output = widget(poisoned).toPlainText();
    expect(output).not.toMatch(/1234|secret task prompt|bash|private thought|PRIVATE_ASSIGNMENT|PRIVATE_PLAN_STEP|capabilit|reasoning/iu);
    expect(widget(poisoned).takeAnnouncements().join('\n')).not.toMatch(
      /1234|secret task prompt|bash|private thought|PRIVATE_ASSIGNMENT|PRIVATE_PLAN_STEP|capabilit|reasoning/iu,
    );
  });
});
