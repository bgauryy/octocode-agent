import { describe, expect, it, vi } from 'vitest';
import { createOctocodeToolRegistry, type OctocodeCatalog } from '../src/native-tools.js';

const catalog: OctocodeCatalog = {
  tools: [
    { name: 'localSearchCode', description: 'Search local code', category: 'Local Code' },
    { name: 'ghSearchCode', description: 'Search GitHub code', category: 'GitHub' },
  ],
};

describe('native Octocode tool registry', () => {
  it('registers the live catalog and executes through the Octocode CLI boundary', async () => {
    const execute = vi.fn(async (name: string, input: unknown) => ({ name, input, ok: true }));
    const registry = createOctocodeToolRegistry(catalog, execute);
    expect(registry.list().map((tool) => tool.name)).toEqual(['ghSearchCode', 'localSearchCode']);

    const tool = registry.get('localSearchCode')!;
    expect(tool.policy.effect).toBe('read');
    const result = await tool.execute({
      input: { path: '/tmp', searchText: 'x' },
      callId: 'call:1' as never,
      context: { sessionId: 's' as never, cwd: '/tmp', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, signal: new AbortController().signal },
      signal: new AbortController().signal,
      update: async () => undefined,
    });
    expect(result).toMatchObject({ ok: true, content: { ok: true, name: 'localSearchCode' } });
    expect(execute).toHaveBeenCalledWith('localSearchCode', { path: '/tmp', searchText: 'x' }, expect.any(AbortSignal));
  });

  it('classifies remote catalog tools as network effects', () => {
    const registry = createOctocodeToolRegistry(catalog, async () => ({}));
    expect(registry.get('ghSearchCode')?.policy.effect).toBe('network');
  });
});
