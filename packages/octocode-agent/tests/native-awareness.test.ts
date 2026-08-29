import { describe, expect, it, vi } from 'vitest';
import { ROUTABLE_OPERATIONS } from '@octocodeai/octocode-awareness';
import { ToolRegistry } from '@octocodeai/agent-core';

import { registerNativeAwarenessTool } from '../src/native-awareness.js';

function execution(input: unknown, overrides: { sessionId?: string; cwd?: string } = {}) {
  const signal = new AbortController().signal;
  return {
    input,
    callId: 'awareness:1' as never,
    context: {
      sessionId: (overrides.sessionId ?? 'session-1') as never,
      cwd: overrides.cwd ?? '/workspace',
      mode: 'headless' as const,
      trust: { workspace: 'trusted' as const, managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

describe('native Awareness tool', () => {
  it('registers the owner catalog as a closed, conservatively gated action schema', () => {
    const registry = new ToolRegistry();
    registerNativeAwarenessTool(registry, { cwd: '/workspace' });

    const tool = registry.get('awareness')!;
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: [...ROUTABLE_OPERATIONS] },
        request: { type: 'object', additionalProperties: true },
      },
    });
    expect(tool.policy).toEqual({
      effects: ['read', 'write'], trust: 'workspace', approval: 'on-request', plan: 'allowed',
    });
    expect(tool.description).toContain('conservative write approval');
  });

  it('delegates to the package owner with cwd, session, and agent identity and closes its DB scope', async () => {
    const registry = new ToolRegistry();
    const db = {} as never;
    const openDb = vi.fn(() => db);
    const closeDb = vi.fn();
    const run = vi.fn(() => ({ exitCode: 0, payload: { peers: 2 } }));
    registerNativeAwarenessTool(registry, {
      cwd: '/configured',
      env: { OCTOCODE_AGENT_ID: 'native-agent' },
      dbPath: '/state/octocode.sqlite3',
      openDb,
      closeDb,
      run,
    });

    const result = await registry.get('awareness')!.execute(execution({
      action: 'workspace_status', request: { compact: true },
    }, { cwd: '/runtime-workspace', sessionId: 'session-native' }));

    expect(openDb).toHaveBeenCalledWith('/state/octocode.sqlite3');
    expect(run).toHaveBeenCalledWith(db, 'workspace_status', { compact: true }, {
      cwd: '/runtime-workspace', sessionId: 'session-native', agentId: 'native-agent',
    });
    expect(closeDb).toHaveBeenCalledWith('/state/octocode.sqlite3');
    expect(result).toEqual({
      ok: true,
      content: { operation: 'workspace_status', exitCode: 0, payload: { peers: 2 } },
      detailsVersion: 1,
    });
  });

  it('returns non-zero owner exits and thrown failures as structured tool results', async () => {
    const db = {} as never;
    const closeDb = vi.fn();
    const registry = new ToolRegistry();
    const run = vi.fn()
      .mockReturnValueOnce({ exitCode: 2, payload: { conflict: 'peer lock' } })
      .mockImplementationOnce(() => { throw new Error('database unavailable'); });
    registerNativeAwarenessTool(registry, {
      cwd: '/workspace',
      openDb: () => db,
      closeDb,
      run,
      dbPath: '/state/octocode.sqlite3',
    });
    const tool = registry.get('awareness')!;

    await expect(tool.execute(execution({ action: 'file_lock', request: { type: 'lock' } }))).resolves.toEqual({
      ok: false,
      category: 'awareness-exit',
      content: { operation: 'file_lock', exitCode: 2, payload: { conflict: 'peer lock' } },
      detailsVersion: 1,
    });
    await expect(tool.execute(execution({ action: 'query', request: {} }))).resolves.toEqual({
      ok: false,
      category: 'awareness-error',
      content: { operation: 'query', exitCode: 1, error: { message: 'database unavailable' } },
      detailsVersion: 1,
    });
    expect(closeDb).toHaveBeenCalledTimes(2);
  });

  it('uses a session-scoped native identity when the environment has no agent id', async () => {
    const registry = new ToolRegistry();
    const run = vi.fn(() => ({ exitCode: 0, payload: {} }));
    registerNativeAwarenessTool(registry, {
      cwd: '/workspace', env: {}, openDb: () => ({} as never), closeDb: () => undefined, run,
    });

    await registry.get('awareness')!.execute(execution({ action: 'query', request: {} }, { sessionId: 'session-2' }));
    expect(run.mock.calls[0]?.[3]).toMatchObject({ agentId: 'native:session-2', sessionId: 'session-2' });
  });
});
