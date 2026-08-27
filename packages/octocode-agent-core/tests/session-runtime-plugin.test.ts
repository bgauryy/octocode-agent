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
});
