import { describe, expect, it, vi } from 'vitest';
import { ROUTABLE_OPERATIONS, resolveDbPath } from '@octocodeai/octocode-awareness';
import { ToolRegistry } from '@octocodeai/agent-core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  it('opens the same default home store as the Awareness CLI', async () => {
    const registry = new ToolRegistry();
    const openDb = vi.fn(() => ({} as never));
    registerNativeAwarenessTool(registry, {
      cwd: '/workspace', openDb, closeDb: vi.fn(),
      run: () => ({ exitCode: 0, payload: { ok: true } }),
    });
    await registry.get('awareness')!.execute(execution({ action: 'workspace_status', request: {} }));
    expect(openDb).toHaveBeenCalledWith(resolveDbPath(null, { workspace: '/workspace' }));
  });

  it('registers the owner catalog as a closed schema with input-sensitive policy', () => {
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
    expect(tool.policy).toMatchObject({
      effects: ['read', 'write'], trust: 'workspace', approval: 'on-request', plan: 'allowed',
      resolve: expect.any(Function),
    });
    expect(tool.description).not.toContain('cannot vary');
    expect(tool.description).not.toContain('conservative write approval');
  });

  it('classifies every owner-routable operation from its actual effect path', () => {
    const registry = new ToolRegistry();
    registerNativeAwarenessTool(registry, { cwd: '/workspace' });
    const resolve = registry.get('awareness')!.policy.resolve!;
    const readPolicy = { effects: ['read'], trust: 'none', approval: 'never' };
    const mutationPolicy = { effects: ['read', 'write'], trust: 'workspace', approval: 'on-request' };
    const representativeInputs: Record<string, { request?: Record<string, unknown>; policy: typeof readPolicy }> = {
      // Owner recall records access counts for returned memories.
      recall: { policy: mutationPolicy },
      record: { policy: mutationPolicy },
      reflect: { policy: mutationPolicy },
      workspace_status: { policy: readPolicy },
      refine_get: { policy: readPolicy },
      verify_audit: { policy: readPolicy },
      verify: { policy: mutationPolicy },
      digest: { request: {}, policy: mutationPolicy },
      forget: { request: {}, policy: mutationPolicy },
      agent_signal: { request: { action: 'publish' }, policy: mutationPolicy },
      file_lock: { request: { type: 'lock' }, policy: mutationPolicy },
      mine_weakness: { policy: readPolicy },
      export_harness: { policy: readPolicy },
      attend: { policy: readPolicy },
      query: { policy: readPolicy },
      view: { policy: mutationPolicy },
    };

    expect(Object.keys(representativeInputs).sort()).toEqual([...ROUTABLE_OPERATIONS].sort());
    for (const [action, expected] of Object.entries(representativeInputs)) {
      expect(resolve({ action, request: expected.request ?? {} }), action).toEqual(expected.policy);
    }
  });

  it('keeps read-only subactions approval-free and conditional mutations gated', () => {
    const registry = new ToolRegistry();
    registerNativeAwarenessTool(registry, { cwd: '/workspace' });
    const resolve = registry.get('awareness')!.policy.resolve!;
    const readPolicy = { effects: ['read'], trust: 'none', approval: 'never' };
    const mutationPolicy = { effects: ['read', 'write'], trust: 'workspace', approval: 'on-request' };

    expect(resolve({ action: 'digest', request: { dry_run: true } })).toEqual(readPolicy);
    expect(resolve({ action: 'digest', request: { dry_run: true, export_doc: true } })).toEqual(mutationPolicy);
    expect(resolve({ action: 'forget', request: { dry_run: true } })).toEqual(readPolicy);
    expect(resolve({ action: 'forget', request: { dry_run: false } })).toEqual(mutationPolicy);
    expect(resolve({ action: 'agent_signal', request: { action: 'list' } })).toEqual(readPolicy);
    expect(resolve({ action: 'agent_signal', request: { action: 'list', mark_read: true } })).toEqual(mutationPolicy);
    expect(resolve({ action: 'file_lock', request: { type: 'status' } })).toEqual(readPolicy);
    expect(resolve({ action: 'file_lock', request: { type: 'renew' } })).toEqual(mutationPolicy);
  });

  it('fails policy resolution closed for malformed routed input', () => {
    const registry = new ToolRegistry();
    registerNativeAwarenessTool(registry, { cwd: '/workspace' });
    const resolve = registry.get('awareness')!.policy.resolve!;

    expect(() => resolve({ action: 'not-routable', request: {} })).toThrow('not routable');
    expect(() => resolve({ action: 'file_lock', request: {} })).toThrow('requires request.type');
    expect(() => resolve({ action: 'agent_signal', request: { action: 'invalid' } })).toThrow('requires request.action');
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
      dbPath: '/state/awareness.sqlite3',
      openDb,
      closeDb,
      run,
    });

    const result = await registry.get('awareness')!.execute(execution({
      action: 'workspace_status', request: { compact: true },
    }, { cwd: '/runtime-workspace', sessionId: 'session-native' }));

    expect(openDb).toHaveBeenCalledWith('/state/awareness.sqlite3');
    expect(run).toHaveBeenCalledWith(db, 'workspace_status', { compact: true }, {
      cwd: '/runtime-workspace', sessionId: 'session-native', agentId: 'native-agent',
    });
    expect(closeDb).toHaveBeenCalledWith('/state/awareness.sqlite3');
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
      dbPath: '/state/awareness.sqlite3',
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
    const run = vi.fn((_db: unknown, _operation: string, _request: unknown, _context: unknown) => ({ exitCode: 0, payload: {} }));
    registerNativeAwarenessTool(registry, {
      cwd: '/workspace', env: {}, openDb: () => ({} as never), closeDb: () => undefined, run,
    });

    await registry.get('awareness')!.execute(execution({ action: 'query', request: {} }, { sessionId: 'session-2' }));
    expect(run.mock.calls[0]?.[3]).toMatchObject({ agentId: 'native:session-2', sessionId: 'session-2' });
  });

  it('respects an explicitly selected repository storage policy', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'native-awareness-policy-'));
    mkdirSync(join(workspace, '.octocode'));
    writeFileSync(join(workspace, '.octocode', 'awareness.json'), JSON.stringify({
      version: 1, storage: { repository: 'repo', memory: 'repo' }, hooks: { profile: 'coordination' },
    }));
    try {
      const registry = new ToolRegistry();
      const openDb = vi.fn(() => ({} as never));
      registerNativeAwarenessTool(registry, {
        cwd: workspace,
        openDb,
        closeDb: () => undefined,
        run: () => ({ exitCode: 0, payload: {} }),
      });

      await registry.get('awareness')!.execute(execution({ action: 'query', request: {} }));

      expect(openDb).toHaveBeenCalledWith(join(workspace, '.octocode', 'awareness.sqlite3'));
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
