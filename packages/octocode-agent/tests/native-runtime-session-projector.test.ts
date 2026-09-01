import { describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  LifecycleBus,
  revision,
  sessionEventId,
  sessionId,
  type RuntimeEvent,
} from '@octocodeai/agent-core';
import { createRuntimeEventPersister } from '../src/native-runtime-session-projector.js';

describe('native runtime session projector hook context', () => {
  it('persists prompt and post-tool hook output as untrusted user data in model order', async () => {
    const sessions = new InMemorySessionStore();
    const id = sessionId('native:hook-context');
    await sessions.append(id, revision('0'), [{
      schemaVersion: 1,
      sessionId: id,
      eventId: sessionEventId('created'),
      revision: revision('1'),
      sequence: 1,
      timestamp: 1,
      visibility: 'internal',
      event: { type: 'session.created' },
    }]);
    const input = new LifecycleBus<unknown>({
      eventType: 'input.received', authority: ['context'], validate: (_value): _value is unknown => true,
    });
    input.subscribe({ id: 'prompt-hook', source: 'workspace', handler: async () => ({ kind: 'context', text: '[authority:untrusted-hook-data] prompt fact' }) });
    const ended = new LifecycleBus<unknown>({
      eventType: 'tool.ended', authority: ['context'], validate: (_value): _value is unknown => true,
    });
    ended.subscribe({ id: 'post-tool-hook', source: 'workspace', handler: async () => ({ kind: 'context', text: '[authority:untrusted-hook-data] tool fact' }) });
    const persist = createRuntimeEventPersister({
      sessions,
      activeSessionId: id,
      initialRevision: revision('1'),
      lifecycle: new Map([['input.received', input], ['tool.ended', ended]]),
    });
    let sequence = 0;
    const runtimeEvent = (type: RuntimeEvent['type'], payload: RuntimeEvent['payload']): RuntimeEvent => ({
      schemaVersion: 1,
      eventVersion: 1,
      id: `runtime:${++sequence}` as RuntimeEvent['id'],
      type,
      phase: 'notification',
      sessionId: id,
      timestamp: sequence + 1,
      cwd: '/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      payload,
    } as RuntimeEvent);

    await persist(runtimeEvent('input.received', { text: 'current prompt' }));
    await persist(runtimeEvent('message.delta', { type: 'tool-call', id: 'call-1', name: 'lookup', input: {} }));
    await persist(runtimeEvent('message.ended', { status: 'complete' }));
    const typedResult = {
      schemaVersion: 1 as const,
      parts: [{ type: 'text' as const, text: 'typed result' }],
    };
    await persist(runtimeEvent('tool.ended', {
      callId: 'call-1',
      name: 'lookup',
      outcome: 'success',
      result: { ok: true, content: typedResult },
    }));

    expect((await sessions.load(id)).projection.modelContext.map(({ eventId: _eventId, ...message }) => message)).toEqual([
      { role: 'user', content: '[authority:untrusted-hook-data] prompt fact' },
      { role: 'user', content: 'current prompt' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'lookup', input: {} }] },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: JSON.stringify({ ok: true, content: typedResult }),
        result: typedResult,
      },
      { role: 'user', content: '[authority:untrusted-hook-data] tool fact' },
    ]);
  });
});
