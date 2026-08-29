import { describe, expect, it, vi } from 'vitest';
import {
  createOctocodeToolRegistry,
  executeOctocodeTool,
  loadOctocodeCatalog,
  OctocodeFacadeError,
  resetOctocodeCatalogCacheForTests,
  type OctocodeCatalog,
} from '../src/native-tools.js';

const catalog: OctocodeCatalog = {
  kind: 'octocode.toolCatalog.full',
  version: 1,
  toolCount: 2,
  tools: [
    { name: 'localSearchCode', description: 'Search local code', category: 'Local Code', inputSchema: { type: 'object' } },
    { name: 'ghSearchCode', description: 'Search GitHub code', category: 'GitHub', inputSchema: { type: 'object' } },
  ],
};

describe('native Octocode tool registry', () => {
  it('loads the complete catalog in one process call and reuses the bounded cache', async () => {
    resetOctocodeCatalogCacheForTests();
    const run = vi.fn(async () => JSON.stringify({
      kind: 'octocode.toolCatalog.full',
      version: 1,
      toolCount: 2,
      tools: [
        { name: 'zeta', description: 'Zeta', inputSchema: { type: 'object' } },
        { name: 'alpha', description: 'Alpha', inputSchema: { type: 'object' } },
      ],
    }));

    const first = await loadOctocodeCatalog({ run, cacheKey: 'test' });
    const second = await loadOctocodeCatalog({ run, cacheKey: 'test' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(['tools', '--json', '--full'], expect.anything());
    expect(first).toBe(second);
    expect(first.tools.map((tool) => tool.name)).toEqual(['alpha', 'zeta']);
  });

  it('isolates cached catalogs by runner, workspace, and catalog-affecting environment', async () => {
    resetOctocodeCatalogCacheForTests();
    const run = vi.fn(async (_args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => JSON.stringify({
      kind: 'octocode.toolCatalog.full', version: 1, toolCount: 1,
      tools: [{ name: `${options?.cwd}:${options?.env?.ENABLE_LOCAL}:${options?.env?.ENABLE_DISCUSSIONS}`, description: 'Scoped', inputSchema: { type: 'object' } }],
    }));

    const first = await loadOctocodeCatalog({ cwd: '/workspace/a', env: { ENABLE_LOCAL: 'true' }, run });
    const repeated = await loadOctocodeCatalog({ cwd: '/workspace/a', env: { ENABLE_LOCAL: 'true' }, run });
    const second = await loadOctocodeCatalog({ cwd: '/workspace/b', env: { ENABLE_LOCAL: 'false' }, run });
    const discussions = await loadOctocodeCatalog({ cwd: '/workspace/a', env: { ENABLE_LOCAL: 'true', ENABLE_DISCUSSIONS: 'true' }, run });

    expect(run).toHaveBeenCalledTimes(3);
    expect(repeated).toBe(first);
    expect(first.tools[0]?.name).not.toBe(second.tools[0]?.name);
    expect(first.tools[0]?.name).not.toBe(discussions.tools[0]?.name);
  });

  it.each([
    [{ kind: 'wrong', version: 1, toolCount: 0, tools: [] }, 'protocol kind'],
    [{ kind: 'octocode.toolCatalog.full', version: 2, toolCount: 0, tools: [] }, 'protocol version'],
    [{ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 2, tools: [] }, 'tool count'],
    [{ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 1, tools: [{ name: 'unsafe', description: 'Unsafe' }] }, 'invalid schema'],
  ])('rejects catalog authority mismatches before registration: %s', async (payload, expected) => {
    resetOctocodeCatalogCacheForTests();
    const run = vi.fn(async () => JSON.stringify(payload));

    await expect(loadOctocodeCatalog({ run, cacheKey: `invalid:${expected}` })).rejects.toMatchObject({
      name: 'OctocodeFacadeError',
      code: 'catalog-invalid',
    });
    expect(() => createOctocodeToolRegistry(payload as never, vi.fn())).toThrow(OctocodeFacadeError);
  });

  it('normalizes the exact empty legacy catalog as a fail-closed no-capability sentinel', async () => {
    resetOctocodeCatalogCacheForTests();
    const loaded = await loadOctocodeCatalog({ run: async () => JSON.stringify({ tools: [] }), cacheKey: 'empty-sentinel' });

    expect(loaded).toEqual({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] });
  });

  it('registers the live catalog and executes through the Octocode CLI boundary', async () => {
    const execute = vi.fn(async (name: string, input: unknown) => ({ name, input, ok: true }));
    const update = vi.fn(async () => undefined);
    const registry = createOctocodeToolRegistry(catalog, execute);
    expect(registry.list().map((tool) => tool.name)).toEqual(['awareness', 'ghSearchCode', 'localSearchCode', 'plan']);

    const tool = registry.get('localSearchCode')!;
    expect(tool.policy.effects).toEqual(['read']);
    const result = await tool.execute({
      input: { path: '/tmp', searchText: 'x' },
      callId: 'call:1' as never,
      context: { sessionId: 's' as never, cwd: '/tmp', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal: new AbortController().signal },
      signal: new AbortController().signal,
      update,
    });
    expect(result).toMatchObject({ ok: true, content: { ok: true, name: 'localSearchCode' } });
    expect(execute).toHaveBeenCalledWith('localSearchCode', { path: '/tmp', searchText: 'x' }, expect.any(AbortSignal));
    expect(update.mock.calls.map(([event]) => event)).toEqual([
      { version: 1, kind: 'status', message: 'Running localSearchCode' },
      { version: 1, kind: 'status', message: 'Completed localSearchCode' },
    ]);
  });

  it('registers only the explicitly delegated worker capabilities', () => {
    const registry = createOctocodeToolRegistry(catalog, vi.fn(), {
      allowedTools: new Set(['localSearchCode']),
    });

    expect(registry.list().map((tool) => tool.name)).toEqual(['localSearchCode']);
  });

  it('emits a terminal status update when native execution fails or is cancelled', async () => {
    const controller = new AbortController();
    const update = vi.fn(async () => undefined);
    const registry = createOctocodeToolRegistry(catalog, async () => {
      controller.abort();
      throw new Error('stopped');
    });

    await expect(registry.get('localSearchCode')!.execute({
      input: {}, callId: 'call:1' as never,
      context: { sessionId: 's' as never, cwd: '/tmp', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal: controller.signal },
      signal: controller.signal,
      update,
    })).rejects.toMatchObject({ code: 'execution-cancelled' });
    expect(update).toHaveBeenLastCalledWith({ version: 1, kind: 'status', message: 'Cancelled localSearchCode' });
  });

  it('validates authoritative output schemas before returning tool content', async () => {
    const registry = createOctocodeToolRegistry({
      kind: 'octocode.toolCatalog.full', version: 1, toolCount: 1,
      tools: [{
        name: 'validated', description: 'Validated output', inputSchema: { type: 'object' },
        outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
      }],
    }, async () => ({ answer: 42 }));
    const signal = new AbortController().signal;

    await expect(registry.get('validated')!.execute({
      input: {}, callId: 'call:output' as never,
      context: { sessionId: 's' as never, cwd: '/tmp', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal },
      signal, update: async () => undefined,
    })).rejects.toMatchObject({ code: 'output-invalid' });
  });

  it('returns typed failures without leaking sensitive executor details', async () => {
    const registry = createOctocodeToolRegistry(catalog, async () => {
      throw new Error('request failed token=super-secret Bearer bearer-secret');
    });
    const signal = new AbortController().signal;

    await expect(registry.get('localSearchCode')!.execute({
      input: {}, callId: 'call:redaction' as never,
      context: { sessionId: 's' as never, cwd: '/tmp', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal },
      signal, update: async () => undefined,
    })).rejects.toSatisfy((error: unknown) => error instanceof OctocodeFacadeError
      && error.code === 'execution-failed'
      && !error.message.includes('super-secret')
      && !error.message.includes('bearer-secret')
      && error.message.includes('[REDACTED]'));
  });

  it('fails closed on invalid execution JSON and forwards cancellation to the runner', async () => {
    const invalidRun = vi.fn(async () => 'not-json token=must-not-leak');
    await expect(executeOctocodeTool('localSearchCode', {}, new AbortController().signal, { run: invalidRun }))
      .rejects.toMatchObject({ code: 'execution-invalid' });

    const controller = new AbortController();
    controller.abort();
    const cancelledRun = vi.fn(async () => '{}');
    await expect(executeOctocodeTool('localSearchCode', {}, controller.signal, { run: cancelledRun }))
      .rejects.toMatchObject({ code: 'execution-cancelled' });
    expect(cancelledRun).not.toHaveBeenCalled();
  });

  it('classifies remote catalog tools as network effects', () => {
    const registry = createOctocodeToolRegistry(catalog, async () => ({}));
    expect(registry.get('ghSearchCode')?.policy.effects).toEqual(['network']);
  });

  it('classifies clone as network, process, and write effects because it creates a checkout', () => {
    const registry = createOctocodeToolRegistry({
      kind: 'octocode.toolCatalog.full', version: 1, toolCount: 1,
      tools: [{ name: 'ghCloneRepo', description: 'Clone a GitHub repository', category: 'GitHub', inputSchema: { type: 'object' } }],
    }, async () => ({}));
    expect(registry.get('ghCloneRepo')?.policy).toMatchObject({
      effects: ['network', 'process', 'write'],
      trust: 'workspace',
      approval: 'on-request',
    });
  });

  it('registers the native plan facade from the default native registry composition', async () => {
    const registry = createOctocodeToolRegistry(catalog, async () => ({}));
    expect(registry.get('plan')).toMatchObject({
      name: 'plan',
      policy: { effects: ['read', 'write'], trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    });
  });

  it('registers the unified Awareness facade from native registry composition', () => {
    const registry = createOctocodeToolRegistry(catalog, async () => ({}));
    expect(registry.get('awareness')).toMatchObject({
      name: 'awareness',
      policy: { effects: ['read', 'write'], trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    });
  });

  it('forwards the native plan snapshot sink through registry composition', async () => {
    const snapshots: unknown[] = [];
    const registry = createOctocodeToolRegistry(catalog, async () => ({}), {
      plan: { onSnapshot: (snapshot) => snapshots.push(snapshot) },
    });
    const signal = new AbortController().signal;

    await registry.get('plan')!.execute({
      input: { action: 'set', steps: ['Project runtime state'] },
      callId: 'plan:1' as never,
      context: { sessionId: 'session-1' as never, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal },
      signal,
      update: async () => undefined,
    });

    expect(snapshots).toEqual([expect.objectContaining({
      authority: 'runtime',
      scope: { sessionId: 'session-1', workspace: '/workspace' },
      revision: 1,
      steps: [expect.objectContaining({ id: 'step:1:1', text: 'Project runtime state' })],
    })]);
  });
});
