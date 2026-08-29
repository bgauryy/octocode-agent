import { describe, expect, it } from 'vitest';
import {
  CompactionMachine,
  ContributionRegistry,
  InMemorySessionStore,
  PluginActivator,
  RuntimeKernel,
  pluginId,
  revision,
  sessionEventId,
  sessionId,
  type PluginManifest,
  type SessionEvent,
} from '../src/index.js';

const stored = (rev: number, event: SessionEvent['event']): SessionEvent => ({
  schemaVersion: 1, sessionId: sessionId('s'), eventId: sessionEventId(`e${rev}`), revision: revision(String(rev)), sequence: rev,
  timestamp: rev, visibility: 'transcript', event,
});

describe('sessions and compaction', () => {
  it('appends atomically at an expected revision and replays deterministically', async () => {
    const store = new InMemorySessionStore();
    await store.append(sessionId('s'), revision('0'), [stored(1, { type: 'session.created', name: 'one' })]);
    await expect(store.append(sessionId('s'), revision('0'), [stored(2, { type: 'session.renamed', name: 'bad' })])).rejects.toMatchObject({ category: 'session-conflict' });
    await store.append(sessionId('s'), revision('1'), [stored(2, { type: 'message.appended', role: 'user', content: 'hello' })]);
    expect((await store.load(sessionId('s'))).projection.transcript).toHaveLength(1);
  });

  it('projects model-visible history separately from transcript and diagnostics', async () => {
    const store = new InMemorySessionStore();
    const modelMessage = { ...stored(1, { type: 'message.appended' as const, role: 'user' as const, content: 'visible' }), visibility: 'model' as const };
    const transcriptOnly = { ...stored(2, { type: 'message.appended' as const, role: 'assistant' as const, content: 'display only' }), visibility: 'transcript' as const };
    const diagnostics = { ...stored(3, { type: 'custom.appended' as const, kind: 'provider.trace', value: { private: true } }), visibility: 'diagnostics' as const };

    await store.append(sessionId('s'), revision('0'), [modelMessage, transcriptOnly, diagnostics]);
    const projection = (await store.load(sessionId('s'))).projection;

    expect(projection.transcript.map(({ content }) => content)).toEqual(['visible', 'display only']);
    expect(projection.modelContext).toEqual([{ eventId: sessionEventId('e1'), role: 'user', content: 'visible' }]);
    expect(projection.modelContext).not.toEqual(expect.arrayContaining([expect.objectContaining({ content: 'display only' })]));
  });

  it('compaction reaches exactly one terminal state', async () => {
    const machine = new CompactionMachine();
    machine.start('manual');
    machine.retry('overflow');
    machine.complete({ summary: 'short', retainedEventIds: [] });
    expect(machine.snapshot().state).toBe('compacted');
    expect(() => machine.fail('late')).toThrow(/terminal/i);
  });
});

describe('plugin activation', () => {
  it('publishes contributions atomically and rolls back failures', async () => {
    const registry = new ContributionRegistry();
    const activator = new PluginActivator(registry);
    const manifest: PluginManifest = { schemaVersion: 1, id: pluginId('p'), version: '1.0.0', apiVersion: '1', activationEvents: ['onSessionStart'], permissions: ['tools.register'], contributions: [] };
    await expect(activator.activate(manifest, { requested: ['tools.register'], granted: ['tools.register'], denied: [], revision: revision('1') }, async (tx) => {
      tx.add({ kind: 'resource', id: 'p:r', owner: pluginId('p'), value: { ok: true } });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(registry.list()).toEqual([]);
  });
});

describe('RuntimeKernel', () => {
  it('owns turn cancellation and emits a single terminal event', async () => {
    const events: string[] = [];
    const kernel = new RuntimeKernel({
      sessionId: sessionId('s'),
      model: { run: async (_request, context) => { await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true })); return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }; } },
      emit: async (event) => { events.push(event.type); },
    });
    const running = kernel.submit('hello');
    await kernel.cancel('user');
    await running;
    expect(events.filter((event) => event === 'turn.ended')).toHaveLength(1);
    expect(kernel.snapshot().state).toBe('ready');
  });

  it('joins an active turn before emitting stopped and never returns to ready', async () => {
    const events: string[] = [];
    let releaseTurn!: () => void;
    const turnReleased = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => { modelStarted = resolve; });
    const kernel = new RuntimeKernel({
      sessionId: sessionId('stop-race'),
      model: {
        run: async (_request, context) => {
          modelStarted();
          await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
          await turnReleased;
          return { stop: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
      emit: async (event) => { events.push(event.type); },
    });

    const running = kernel.submit('hello');
    await started;
    let stopped = false;
    const stopping = kernel.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseTurn();
    await Promise.all([running, stopping]);

    expect(kernel.snapshot().state).toBe('stopped');
    expect(events.at(-1)).toBe('runtime.stopped');
    expect(events.filter((event) => event === 'runtime.stopped')).toHaveLength(1);
  });

  it('treats cancellation while idle as a no-op for the next turn', async () => {
    let aborted = false;
    const kernel = new RuntimeKernel({
      sessionId: sessionId('idle-cancel'),
      model: {
        run: async (_request, context) => {
          aborted = context.signal.aborted;
          return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
        },
      },
    });

    await kernel.cancel('idle');
    await kernel.submit('hello');

    expect(aborted).toBe(false);
    expect(kernel.snapshot().state).toBe('ready');
  });
});
