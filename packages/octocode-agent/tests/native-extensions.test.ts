import { describe, expect, it, vi } from 'vitest';
import {
  createEffectSet,
  pluginId,
  revision,
  ToolRegistry,
  type CodexHookConfiguration,
  type HookSourceDescriptor,
  type PluginCapabilityGrant,
  type PluginManifest,
} from '@octocodeai/agent-core';

import {
  NativeExtensionsController,
  type NativeDiscoveredHook,
  type NativeDiscoveredPlugin,
} from '../src/native-extensions.js';

const hookConfiguration: CodexHookConfiguration = {
  schemaVersion: 1,
  hooks: {
    PreToolUse: [{ matcher: '^edit$', handlers: [], declarationOrder: 0 }],
  },
  unsupported: [],
};

function hook(
  id: string,
  overrides: Partial<HookSourceDescriptor> = {},
  reviewedHash?: string,
): NativeDiscoveredHook {
  const source: HookSourceDescriptor = {
    id,
    scope: 'workspace',
    provenance: `test:${id}`,
    managed: false,
    rawHash: `${id}-raw`,
    normalizedHash: `${id}-normalized`,
    trust: 'trusted',
    revision: revision('1'),
    discoveryOrder: 0,
    ...overrides,
  };
  return { source, configuration: hookConfiguration, enabled: true, reviewedHash };
}

function plugin(id: string, overrides: Partial<NativeDiscoveredPlugin> = {}): NativeDiscoveredPlugin {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: pluginId(id),
    version: '1.0.0',
    apiVersion: '1',
    activationEvents: ['onSessionStart'],
    permissions: ['tools.register'],
    contributions: [{ kind: 'tool', path: './tool.js' }],
  };
  const grant: PluginCapabilityGrant = {
    requested: ['tools.register'],
    granted: ['tools.register'],
    denied: [],
    revision: revision('1'),
  };
  return {
    manifest,
    grant,
    trust: 'trusted',
    manifestHash: `${id}-hash`,
    reviewedHash: `${id}-hash`,
    ...overrides,
  };
}

describe('native extensions controller', () => {
  it('discovers through injected boundaries and projects trust-aware hooks truthfully', async () => {
    const managed = hook('managed', { scope: 'managed', managed: true, normalizedHash: 'managed-hash' });
    const workspace = hook('workspace', {}, 'workspace-normalized');
    const stale = hook('stale', {}, 'previous-hash');
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [workspace, stale, managed],
      discoverPlugins: async () => [plugin('reviewed')],
      activatePlugin: async () => undefined,
    });

    await controller.discover();

    expect(controller.effectiveHooks({ workspaceTrusted: false, managedOnly: false }).map((entry) => entry.source.id)).toEqual(['managed']);
    expect(controller.effectiveHooks({ workspaceTrusted: true, managedOnly: true }).map((entry) => entry.source.id)).toEqual(['managed']);
    expect(controller.effectiveHooks({ workspaceTrusted: true, managedOnly: false }).map((entry) => entry.source.id)).toEqual(['managed', 'workspace']);
    expect(controller.snapshot()).toMatchObject({
      discovered: true,
      hooks: { entries: [
        { source: { id: 'managed' }, executable: true },
        { source: { id: 'stale' }, executable: false },
        { source: { id: 'workspace' }, executable: true },
      ] },
      plugins: [{ id: 'reviewed', active: false, review: 'approved' }],
      contributions: [],
      activeLeases: [],
    });
  });

  it('activates reviewed trusted plugins transactionally and rolls back failures', async () => {
    const execute = vi.fn(async (candidate: NativeDiscoveredPlugin, transaction: { add(value: { kind: 'tool'; id: string; value: unknown }): void }) => {
      transaction.add({ kind: 'tool', id: `${candidate.manifest.id}-tool`, value: { safe: true } });
      if (candidate.manifest.id === 'broken') throw new Error('activation exploded');
    });
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [plugin('ready'), plugin('broken')],
      activatePlugin: execute,
    });
    await controller.discover();

    await controller.activate('ready');
    await expect(controller.activate('broken')).rejects.toThrow('activation exploded');

    expect(controller.snapshot().plugins).toEqual([
      expect.objectContaining({ id: 'broken', active: false, lifecycle: 'failed' }),
      expect.objectContaining({ id: 'ready', active: true, lifecycle: 'ready' }),
    ]);
    expect(controller.snapshot().contributions).toEqual([
      expect.objectContaining({ id: 'ready-tool', owner: 'ready' }),
    ]);
  });

  it('rejects plugins whose trust is absent or whose reviewed hash is stale before execution', async () => {
    const execute = vi.fn(async () => undefined);
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [
        plugin('untrusted', { trust: 'review-required', reviewedHash: undefined }),
        plugin('changed', { reviewedHash: 'old-hash' }),
      ],
      activatePlugin: execute,
    });
    await controller.discover();

    await expect(controller.activate('untrusted')).rejects.toThrow(/reviewed and trusted/);
    await expect(controller.activate('changed')).rejects.toThrow(/reviewed and trusted/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('prevents unload with an active lease and removes owned contributions after release', async () => {
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [plugin('leased')],
      activatePlugin: async (candidate, transaction) => {
        transaction.add({ kind: 'tool', id: 'leased-tool', value: { plugin: candidate.manifest.id } });
      },
    });
    await controller.discover();
    await controller.activate('leased');
    controller.acquireLease({
      pluginId: pluginId('leased'), version: '1.0.0', hash: 'leased-hash', contributionId: 'leased-tool',
      operationId: 'operation-1', acquiredAt: 10, cancelled: false,
    });

    expect(() => controller.deactivate('leased')).toThrow(/active lease/);
    expect(controller.snapshot().contributions).toHaveLength(1);
    controller.releaseLease('operation-1', 20);
    controller.deactivate('leased');

    expect(controller.snapshot()).toMatchObject({
      plugins: [{ id: 'leased', active: false, lifecycle: 'stopped' }],
      contributions: [],
      activeLeases: [],
    });
  });

  it('registers executable custom tools through the activation API with namespaced identity', async () => {
    const execute = vi.fn(async () => ({ ok: true, content: { echoed: true }, detailsVersion: 1 }));
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [plugin('api-tools')],
      activatePlugin: async (_candidate, writer) => {
        writer.addTool('echo', {
          name: 'ignored-untrusted-name',
          label: 'Echo',
          description: 'Echo input',
          schemaVersion: 1,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          outputVersion: 1,
          policy: { effects: createEffectSet('read'), trust: 'none', approval: 'never', plan: 'allowed' },
          execute,
        });
      },
    });
    await controller.discover();
    await controller.activate('api-tools');
    const registry = new ToolRegistry();

    expect(controller.registerTools(registry)).toEqual(['api-tools:echo']);
    expect(registry.list().map(({ name, owner }) => ({ name, owner }))).toEqual([
      { name: 'api-tools:echo', owner: 'plugin:api-tools' },
    ]);
    const signal = new AbortController().signal;
    await expect(registry.get('api-tools:echo')!.execute({
      input: {},
      callId: 'call-1' as never,
      context: {
        sessionId: 'session-1' as never,
        cwd: process.cwd(),
        mode: 'headless',
        trust: { workspace: 'trusted', managedOnly: false },
        signal,
      },
      signal,
      update: async () => undefined,
    })).resolves.toMatchObject({ ok: true, content: { echoed: true } });
    expect(execute).toHaveBeenCalledOnce();
    expect(controller.snapshot().activeLeases).toEqual([]);
  });

  it('removes published tools on disable and exposes reverse-order unload lifecycle', async () => {
    const lifecycle: string[] = [];
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [plugin('first'), plugin('second')],
      activatePlugin: async (candidate, writer) => {
        writer.addTool('echo', {
          name: 'ignored',
          label: 'Echo',
          description: 'Echo input',
          schemaVersion: 1,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          outputVersion: 1,
          policy: { effects: createEffectSet('read'), trust: 'none', approval: 'never', plan: 'allowed' },
          execute: async () => ({ ok: true, content: { plugin: candidate.manifest.id }, detailsVersion: 1 }),
        });
      },
      onLifecycle: (event) => lifecycle.push(`${event.pluginId}:${event.state}`),
    });
    await controller.discover();
    await controller.activate('first');
    await controller.activate('second');
    const registry = new ToolRegistry();
    controller.registerTools(registry);

    controller.deactivateAll();

    expect(registry.list()).toEqual([]);
    expect(lifecycle.filter((entry) => entry.endsWith(':deactivating'))).toEqual([
      'second:deactivating',
      'first:deactivating',
    ]);
  });

  it('fails closed when a declared plugin tool has no executable API implementation', async () => {
    const controller = new NativeExtensionsController({
      discoverHooks: async () => [],
      discoverPlugins: async () => [plugin('inert')],
      activatePlugin: async (_candidate, writer) => writer.add({ kind: 'tool', id: 'inert:tool', value: { label: 'Inert' } }),
    });
    await controller.discover();
    await controller.activate('inert');

    expect(() => controller.registerTools(new ToolRegistry())).toThrow(/requires an executor provided through the activation API/);
  });

  it('keeps discovery transactional so a failed catalog build can be retried cleanly', async () => {
    let attempt = 0;
    const controller = new NativeExtensionsController({
      discoverHooks: async () => {
        attempt += 1;
        return attempt === 1
          ? [hook('duplicate'), hook('duplicate')]
          : [hook('recovered')];
      },
      discoverPlugins: async () => [plugin('ready')],
      activatePlugin: async () => undefined,
    });

    await expect(controller.discover()).rejects.toThrow(/duplicate discovered hook source/i);
    expect(controller.snapshot()).toMatchObject({ discovered: false, hooks: { entries: [] }, plugins: [] });

    await controller.discover();
    expect(controller.snapshot()).toMatchObject({
      discovered: true,
      hooks: { entries: [{ source: { id: 'recovered' } }] },
      plugins: [{ id: 'ready' }],
    });
  });
});
