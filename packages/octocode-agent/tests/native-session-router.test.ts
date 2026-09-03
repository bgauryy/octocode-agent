import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySessionStore,
  SessionController,
  RuntimeFailure,
  sessionId,
  type AgentRuntime,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type SessionId,
  type SessionProjection,
} from '@octocodeai/agent-core';

import { createNativeSessionRuntimeRouter } from '../src/native-session-router.js';

class FakeRuntime implements AgentRuntime {
  started = 0;
  stopped = 0;
  activeTurn = false;
  stopError: Error | undefined;
  readonly commands: RuntimeCommand[] = [];
  readonly submissions: string[] = [];
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  startEvent: RuntimeEvent | undefined;
  constructor(readonly id: SessionId, readonly projection: SessionProjection) {}
  async start() {
    this.started += 1;
    if (this.startEvent !== undefined) {
      for (const listener of this.listeners) listener(this.startEvent);
    }
  }
  async submit(input: string) { this.submissions.push(input); }
  async cancel() {}
  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> { this.commands.push(command); return { ok: true, data: this.id }; }
  snapshot(): RuntimeSnapshot { return { schemaVersion: 1, state: this.activeTurn ? 'running' : this.stopped ? 'stopped' : 'ready', sessionId: this.id, activeTurn: this.activeTurn, model: null, thinkingLevel: null, usage: { inputTokens: 0, outputTokens: 0 }, revision: 1 }; }
  subscribe(listener: (event: RuntimeEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async stop() { this.stopped += 1; if (this.stopError) throw this.stopError; }
}

async function harness() {
  const store = new InMemorySessionStore();
  const controller = new SessionController(store, () => 10);
  const alpha = sessionId('alpha');
  const beta = sessionId('beta');
  await controller.create(alpha, 'Alpha');
  await controller.create(beta, 'Beta');
  await controller.resume(alpha);
  const runtimes: FakeRuntime[] = [];
  const cleanupErrors: unknown[] = [];
  const router = await createNativeSessionRuntimeRouter({
    controller,
    initialSessionId: alpha,
    createRuntime: async ({ sessionId: id, projection }) => {
      const runtime = new FakeRuntime(id, projection);
      runtimes.push(runtime);
      return runtime;
    },
    resolveNavigation: async ({ current, direction }) => direction === 'next' && current === alpha ? beta : direction === 'previous' && current === beta ? alpha : null,
    onCleanupError: (error) => cleanupErrors.push(error),
  });
  return { router, controller, store, runtimes, cleanupErrors, alpha, beta };
}

describe('native session runtime router', () => {
  it('delegates ordinary commands and replaces, rather than mutates, fixed-session runtimes', async () => {
    const { router, runtimes, alpha, beta } = await harness();
    await router.start();
    await router.submit('hello');
    expect(runtimes[0]?.submissions).toEqual(['hello']);

    await expect(router.execute({ type: 'session.switch', id: beta })).resolves.toMatchObject({ ok: true, data: { sessionId: beta } });
    expect(router.snapshot().sessionId).toBe(beta);
    expect(runtimes[0]?.stopped).toBe(1);
    expect(runtimes[1]).not.toBe(runtimes[0]);
    expect(runtimes[1]?.projection.sessionId).toBe(beta);

    await router.execute({ type: 'session.switch', id: alpha });
    expect(router.snapshot().sessionId).toBe(alpha);
    expect(runtimes[2]).not.toBe(runtimes[0]);
    expect(runtimes[2]?.projection.sessionId).toBe(alpha);
    expect(runtimes[1]?.stopped).toBe(1);

    await router.execute({ type: 'model.thinking', level: 'high' });
    expect(runtimes[2]?.commands).toContainEqual({ type: 'model.thinking', level: 'high' });
    expect(alpha).not.toBe(beta);
  });

  it('composes create, fork, name, export, and navigation through SessionController', async () => {
    const { router, controller, store, alpha, beta } = await harness();
    await router.start();
    const forked = sessionId('alpha-fork');
    await expect(router.execute({ type: 'session.fork', id: forked })).resolves.toMatchObject({ ok: true, data: { sessionId: forked } });
    expect(controller.current()).toBe(forked);
    expect((await store.load(forked)).projection.name).toBe('Alpha');
    expect((await store.load(forked)).projection.customEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'session.parent', value: alpha }),
    ]));

    await expect(router.execute({ type: 'session.name', name: 'Forked' })).resolves.toMatchObject({ ok: true, data: { name: 'Forked' } });
    await expect(router.execute({ type: 'session.export' })).resolves.toMatchObject({ ok: true, data: { projection: { sessionId: forked, name: 'Forked' } } });

    const created = sessionId('created');
    await router.execute({ type: 'session.create', id: created, name: 'Created' });
    expect(router.snapshot().sessionId).toBe(created);
    await router.execute({ type: 'session.switch', id: alpha });
    await router.execute({ type: 'session.navigate', direction: 'next' });
    expect(router.snapshot().sessionId).toBe(beta);
  });

  it('rejects switching while busy and rolls controller identity back when replacement construction fails', async () => {
    const { router, controller, runtimes, alpha, beta } = await harness();
    await router.start();
    runtimes[0]!.activeTurn = true;
    await expect(router.execute({ type: 'session.switch', id: beta })).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } });
    await expect(router.execute({ type: 'session.name', name: 'Busy rename' })).resolves.toMatchObject({ ok: false, error: { category: 'conflict' } });
    expect(controller.current()).toBe(alpha);
    runtimes[0]!.activeTurn = false;

    const broken = sessionId('broken');
    await controller.create(broken);
    await controller.resume(alpha);
    const originalFactory = vi.fn(async ({ sessionId: id, projection }: { sessionId: SessionId; projection: SessionProjection }) => {
      if (id === broken) throw new RuntimeFailure('adapter-compatibility', 'broken runtime');
      return new FakeRuntime(id, projection);
    });
    const isolated = await createNativeSessionRuntimeRouter({ controller, initialSessionId: alpha, createRuntime: originalFactory });
    await isolated.start();
    await expect(isolated.execute({ type: 'session.switch', id: broken })).resolves.toMatchObject({ ok: false, error: { category: 'adapter-compatibility' } });
    expect(controller.current()).toBe(alpha);
    expect(isolated.snapshot().sessionId).toBe(alpha);

    await expect(isolated.execute({ type: 'session.resume', id: 'missing' })).resolves.toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(controller.current()).toBe(alpha);
  });

  it('keeps a committed transition successful when old-runtime cleanup fails', async () => {
    const { router, controller, runtimes, cleanupErrors, beta } = await harness();
    const active = runtimes[0]!;
    active.stopError = new Error('old cleanup failed');
    await router.start();
    await expect(router.execute({ type: 'session.switch', id: beta })).resolves.toMatchObject({ ok: true, data: { sessionId: beta } });
    expect(router.snapshot().sessionId).toBe(beta);
    expect(controller.current()).toBe(beta);
    expect(cleanupErrors).toEqual([active.stopError]);
  });

  it('publishes replacement startup events only after the transition commits', async () => {
    const store = new InMemorySessionStore();
    const controller = new SessionController(store, () => 10);
    const alpha = sessionId('ordered-alpha');
    const beta = sessionId('ordered-beta');
    await controller.create(alpha, 'Alpha');
    await controller.create(beta, 'Beta');
    await controller.resume(alpha);
    const order: string[] = [];
    const router = await createNativeSessionRuntimeRouter({
      controller,
      initialSessionId: alpha,
      createRuntime: async ({ sessionId: id, projection }) => {
        const runtime = new FakeRuntime(id, projection);
        if (id === beta) {
          runtime.startEvent = {
            type: 'session.started',
            payload: {} as never,
          } as unknown as RuntimeEvent;
        }
        return runtime;
      },
      onTransition: () => {
        order.push('transition');
        throw new Error('transition observer failed');
      },
    });
    router.subscribe((event) => order.push(event.type));
    await router.start();

    await expect(router.execute({ type: 'session.switch', id: beta })).resolves.toMatchObject({ ok: true });

    expect(order).toEqual(['transition', 'session.started']);
  });

  it('keeps a committed transition successful when a presentation observer throws', async () => {
    const { router, controller, beta } = await harness();
    router.subscribe(() => {
      throw new Error('presentation observer failed');
    });
    await router.start();

    await expect(router.execute({ type: 'session.switch', id: beta })).resolves.toMatchObject({
      ok: true,
      data: { sessionId: beta },
    });
    expect(router.snapshot().sessionId).toBe(beta);
    expect(controller.current()).toBe(beta);
  });
});
