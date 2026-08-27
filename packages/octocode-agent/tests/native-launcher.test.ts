import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySessionStore,
  revision,
  sessionEventId,
  sessionId,
  type AgentRuntime,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from '@octocodeai/agent-core';

import {
  createRuntimeEventPersister,
  launchNativeAgent,
  parseNativeArgs,
  resolveNativeSessionId,
} from '../src/native-launcher.js';

function fakeRuntime(): AgentRuntime {
  return {
    start: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ ok: true, data: {} })),
    snapshot: () => ({ state: 'ready' }) as RuntimeSnapshot,
    subscribe: () => () => undefined,
    stop: vi.fn(async () => undefined),
  };
}

describe('native launcher', () => {
  it('parses interactive, print/json, and rpc modes without host-specific flags', () => {
    expect(parseNativeArgs([]).mode).toBe('interactive');
    expect(parseNativeArgs(['-p', 'hello'])).toMatchObject({ mode: 'print', outputFormat: 'text' });
    expect(parseNativeArgs(['--mode', 'json', 'hello'])).toMatchObject({ mode: 'print', outputFormat: 'json' });
    expect(parseNativeArgs(['--mode', 'rpc'])).toMatchObject({ mode: 'rpc' });
  });

  it('does not construct OpenTUI for print mode', async () => {
    const runtime = fakeRuntime();
    const createTerminal = vi.fn();
    const output: string[] = [];
    await expect(launchNativeAgent(['-p', 'hello'], {
      createRuntime: async () => runtime,
      createTerminal,
      stdout: { write: (value: string) => { output.push(value); return true; } } as never,
    })).resolves.toBe(0);
    expect(createTerminal).not.toHaveBeenCalled();
    expect(runtime.submit).toHaveBeenCalledWith('hello');
  });

  it('does not construct OpenTUI for RPC mode', async () => {
    const runtime = fakeRuntime();
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();
    const createTerminal = vi.fn();
    await expect(launchNativeAgent(['--mode', 'rpc'], {
      createRuntime: async () => runtime,
      createTerminal,
      stdin: input,
      stdout: output,
    })).resolves.toBe(0);
    expect(createTerminal).not.toHaveBeenCalled();
  });

  it('resolves specified and continue sessions from the canonical native store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-resume-'));
    const write = (id: string, cwd: string, mtime: number) => {
      const file = path.join(root, `${encodeURIComponent(id)}.json`);
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        sessionId: id,
        revision: '1',
        events: [{ schemaVersion: 1, sessionId: id, eventId: `${id}:1`, revision: '1', sequence: 1, timestamp: mtime, visibility: 'internal', event: { type: 'custom.appended', kind: 'session.cwd', value: cwd } }],
      }));
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    };
    write('native:old', '/workspace', 1_000);
    write('native:new', '/workspace', 2_000);

    expect(resolveNativeSessionId(parseNativeArgs(['--session', 'native:old']), '/workspace', root, () => 3_000)).toBe('native:old');
    expect(resolveNativeSessionId(parseNativeArgs(['--continue']), '/workspace', root, () => 3_000)).toBe('native:new');
    expect(resolveNativeSessionId(parseNativeArgs([]), '/workspace', root, () => 3_000)).toBe('native:3000');
    expect(() => resolveNativeSessionId(parseNativeArgs(['--session', 'missing']), '/workspace', root, () => 3_000)).toThrow(/not found/i);
  });

  it('persists streamed text deltas as one logical assistant message', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:aggregate');
    await store.append(id, revision('0'), [{
      schemaVersion: 1,
      sessionId: id,
      eventId: sessionEventId('created'),
      revision: revision('1'),
      sequence: 1,
      timestamp: 1,
      visibility: 'internal',
      event: { type: 'session.created' },
    }]);
    const persist = createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') });
    const runtimeEvent = (type: RuntimeEvent['type'], eventId: string, payload: unknown): RuntimeEvent => ({
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId as RuntimeEvent['id'],
      type,
      phase: 'notification',
      sessionId: id,
      timestamp: 2,
      cwd: '/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      payload,
    });
    await persist(runtimeEvent('message.delta', 'delta-1', { type: 'text', text: 'hel' }));
    await persist(runtimeEvent('message.delta', 'delta-2', { type: 'text', text: 'lo' }));
    await persist(runtimeEvent('provider.response-received', 'response-1', { stop: 'complete' }));

    const loaded = await store.load(id);
    expect(loaded.projection.transcript).toHaveLength(1);
    expect(loaded.projection.transcript[0]?.content).toBe('hello');
  });
});
