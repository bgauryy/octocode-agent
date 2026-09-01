import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { revision } from '@octocodeai/agent-core';
import type { NativeRustCoreObject } from '../src/native-rust-core.js';

import {
  createNativeSettingsService,
  NATIVE_SETTING_DEFINITIONS,
} from '../src/native-settings-service.js';
import {
  FileSettingsStorage,
  NativeRustSettingsStorage,
} from '../src/native-settings.js';

async function harness(values: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-settings-service-'));
  const storage = new FileSettingsStorage(path.join(dir, 'settings.json'));
  if (Object.keys(values).length > 0) storage.commit('0', values);
  return { storage, settings: await createNativeSettingsService(storage) };
}

describe('native settings service bridge', () => {
  it('uses the Rust CAS owner and imports legacy JSON only into an empty store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-rust-settings-'));
    const legacy = new FileSettingsStorage(path.join(dir, 'settings.json'));
    legacy.commit('0', { theme: 'octocode-light' });
    let record: { revision: string; values: NativeRustCoreObject } = {
      revision: '0',
      values: {},
    };
    const core = {
      settingsGet: async () => structuredClone(record),
      settingsCompareAndSet: async (
        _scope: string,
        expectedRevision: string,
        values: NativeRustCoreObject,
      ) => {
        if (record.revision !== expectedRevision) throw new Error('conflict');
        record = {
          revision: String(Number(record.revision) + 1),
          values: structuredClone(values),
        };
        return structuredClone(record);
      },
    };
    const storage = new NativeRustSettingsStorage(core, legacy);
    const first = await storage.read();
    expect(first).toEqual({
      schemaVersion: 1,
      revision: '1',
      values: { theme: 'octocode-light' },
    });

    legacy.commit(legacy.read().revision, { theme: 'octocode-dark' });
    expect(await storage.read()).toEqual(first);
    await expect(storage.commit('0', {})).rejects.toThrow('conflict');

    const settings = await createNativeSettingsService(storage);
    const result = await settings.mutate({
      protocolVersion: 1,
      requestId: 'rust-theme',
      action: 'set',
      scope: 'global',
      expectedRevision: settings.snapshot().revision,
      payload: { key: 'theme', value: 'octocode-dark' },
    });
    expect(result.ok).toBe(true);
    expect(record).toEqual({ revision: '2', values: { theme: 'octocode-dark' } });
  });

  it('owns one typed registry with scope, validation, provenance, and application timing', async () => {
    expect(NATIVE_SETTING_DEFINITIONS.map((definition) => definition.key)).toEqual([
      'theme',
      'reducedMotion',
      'compactionInputTokenThreshold',
      'defaultProvider',
      'defaultModel',
      'nativeExtensions',
    ]);
    expect(NATIVE_SETTING_DEFINITIONS).toEqual([
      expect.objectContaining({
        key: 'theme',
        scopes: ['global'],
        kind: { type: 'enum', values: ['octocode-dark', 'octocode-light'] },
        application: 'next-session',
        visibility: 'public',
      }),
      expect.objectContaining({
        key: 'reducedMotion',
        scopes: ['global'],
        kind: { type: 'boolean' },
        defaultValue: true,
        application: 'next-session',
        visibility: 'public',
      }),
      expect.objectContaining({
        key: 'compactionInputTokenThreshold',
        scopes: ['global'],
        kind: { type: 'integer', minimum: 4096, maximum: 2_000_000 },
        defaultValue: 64_000,
        application: 'next-session',
        visibility: 'public',
      }),
      expect.objectContaining({
        key: 'defaultProvider',
        scopes: ['global'],
        kind: { type: 'string' },
        application: 'next-session',
        visibility: 'public',
      }),
      expect.objectContaining({
        key: 'defaultModel',
        scopes: ['global'],
        kind: { type: 'string' },
        application: 'next-session',
        visibility: 'public',
      }),
      expect.objectContaining({ key: 'nativeExtensions', kind: { type: 'object' }, visibility: 'never-render' }),
    ]);

    const { settings } = await harness({ theme: 'octocode-light', reducedMotion: false, defaultModel: 'gpt-5.6' });
    expect(settings.snapshot().values).toEqual([
      expect.objectContaining({ key: 'compactionInputTokenThreshold', value: 64_000, provenance: 'default', application: 'next-session' }),
      expect.objectContaining({ key: 'theme', value: 'octocode-light', provenance: 'global', application: 'next-session' }),
      expect.objectContaining({ key: 'reducedMotion', value: false, provenance: 'global', application: 'next-session' }),
      expect.objectContaining({ key: 'nativeExtensions', value: null, provenance: 'default', application: 'next-session' }),
      expect.objectContaining({ key: 'defaultProvider', value: null, provenance: 'default', application: 'next-session' }),
      expect.objectContaining({ key: 'defaultModel', value: 'gpt-5.6', provenance: 'global', application: 'next-session' }),
    ]);
  });

  it('reviews hashes and grants capabilities through typed redacted transactions', async () => {
    const { storage, settings } = await harness();
    const reviewed = await settings.reviewExtension({ requestId: 'review', expectedRevision: settings.snapshot().revision, id: 'plugin:demo', hash: 'a'.repeat(64), workspaceTrusted: true });
    expect(reviewed).toMatchObject({ ok: true, redactedImpact: expect.arrayContaining(['nativeExtensions:set']) });
    expect(JSON.stringify(settings.snapshot())).not.toContain('a'.repeat(64));
    const granted = await settings.grantPluginCapability({ requestId: 'grant', expectedRevision: settings.snapshot().revision, pluginId: 'demo', permission: 'tools.register', workspaceTrusted: true });
    expect(granted.ok).toBe(true);
    expect(storage.read().values).toMatchObject({ nativeExtensions: { reviewedHashes: { 'plugin:demo': 'a'.repeat(64) }, pluginGrants: { demo: ['tools.register'] } } });
    const revoked = await settings.revokePluginCapability({ requestId: 'revoke', expectedRevision: settings.snapshot().revision, pluginId: 'demo', permission: 'tools.register', workspaceTrusted: true });
    expect(revoked.ok).toBe(true);
    const unreviewed = await settings.unreviewExtension({ requestId: 'unreview', expectedRevision: settings.snapshot().revision, id: 'plugin:demo', workspaceTrusted: true });
    expect(unreviewed.ok).toBe(true);
    expect(storage.read().values).toEqual({ nativeExtensions: { reviewedHashes: {}, pluginGrants: { demo: [] } } });
  });

  it('rejects untrusted, malformed, and stale extension policy mutations', async () => {
    const { storage, settings } = await harness();
    const revision = settings.snapshot().revision;
    await expect(settings.reviewExtension({ requestId: 'bad-hash', expectedRevision: revision, id: 'demo', hash: 'bad', workspaceTrusted: true })).resolves.toMatchObject({ ok: false, error: { category: 'validation' } });
    await expect(settings.grantPluginCapability({ requestId: 'untrusted', expectedRevision: revision, pluginId: 'demo', permission: 'secrets.read', workspaceTrusted: false })).resolves.toMatchObject({ ok: false, error: { category: 'policy' } });
    expect(storage.read().values).toEqual({});
  });

  it('commits provider and model as one typed transaction', async () => {
    const { storage, settings } = await harness({ arbitrary: { preserved: true } });
    const result = await settings.setDefaultModel({
      requestId: 'select-model',
      expectedRevision: settings.snapshot().revision,
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });

    expect(result).toMatchObject({ ok: true, requestId: 'select-model' });
    expect(storage.read().values).toEqual({
      arbitrary: { preserved: true },
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
    });
    expect(settings.snapshot().values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'defaultProvider', value: 'anthropic', stored: true }),
      expect.objectContaining({ key: 'defaultModel', value: 'claude-sonnet-4-5', stored: true }),
    ]));
  });

  it('publishes neither half of a model selection when storage conflicts', async () => {
    const { storage, settings } = await harness({ arbitrary: 'before' });
    const before = settings.snapshot();
    const external = storage.read();
    storage.commit(external.revision, { ...external.values, arbitrary: 'external' });

    const result = await settings.setDefaultModel({
      requestId: 'conflicting-selection',
      expectedRevision: before.revision,
      providerId: 'openai',
      modelId: 'gpt-5',
    });

    expect(result).toMatchObject({ ok: false, error: { category: 'persistence' } });
    expect(settings.snapshot()).toEqual(before);
    expect(storage.read().values).toEqual({ arbitrary: 'external' });
  });

  it('hydrates only valid allowlisted values and never projects unrelated or secret storage', async () => {
    const { settings } = await harness({
      theme: 'plain-dark',
      defaultModel: '  gpt-5.6  ',
      apiKey: 'must-never-render',
      arbitrary: { nested: 'must-never-render-either' },
    });

    const snapshot = settings.snapshot();
    expect(snapshot.definitions.map((definition) => definition.key)).toEqual(['compactionInputTokenThreshold', 'theme', 'reducedMotion', 'nativeExtensions', 'defaultProvider', 'defaultModel']);
    expect(snapshot.values).toEqual([
      expect.objectContaining({ key: 'compactionInputTokenThreshold', value: 64_000, stored: false, provenance: 'default' }),
      expect.objectContaining({ key: 'theme', value: 'octocode-dark', stored: false, provenance: 'default' }),
      expect.objectContaining({ key: 'reducedMotion', value: true, stored: false, provenance: 'default' }),
      expect.objectContaining({ key: 'nativeExtensions', value: null, stored: false, provenance: 'default' }),
      expect.objectContaining({ key: 'defaultProvider', value: null, stored: false, provenance: 'default' }),
      expect.objectContaining({ key: 'defaultModel', value: 'gpt-5.6', stored: true, provenance: 'global' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('must-never-render');
    expect(JSON.stringify(snapshot)).not.toContain('apiKey');
    expect(JSON.stringify(snapshot)).not.toContain('arbitrary');
  });

  it('uses the core expected revision and atomically persists while preserving unrelated storage', async () => {
    const { storage, settings } = await harness({ arbitrary: { preserved: true } });
    const before = settings.snapshot();
    const result = await settings.mutate({
      protocolVersion: 1,
      requestId: 'set-theme',
      action: 'set',
      scope: 'global',
      expectedRevision: before.revision,
      payload: { key: 'theme', value: 'octocode-light' },
    });

    expect(result).toMatchObject({
      ok: true,
      application: 'next-session',
      effectiveValue: { key: 'theme', value: 'octocode-light', provenance: 'global' },
    });
    expect(storage.read().values).toEqual({ arbitrary: { preserved: true }, theme: 'octocode-light' });
    expect((await createNativeSettingsService(storage)).snapshot().values).toContainEqual(
      expect.objectContaining({ key: 'theme', value: 'octocode-light', stored: true }),
    );

    const stale = await settings.mutate({
      protocolVersion: 1,
      requestId: 'stale',
      action: 'set',
      scope: 'global',
      expectedRevision: before.revision,
      payload: { key: 'theme', value: 'octocode-dark' },
    });
    expect(stale).toMatchObject({ ok: false, error: { category: 'conflict' } });
    expect(storage.read().values.theme).toBe('octocode-light');
  });

  it('does not publish a candidate mutation when atomic storage commit conflicts', async () => {
    const { storage, settings } = await harness({ theme: 'octocode-dark' });
    const before = settings.snapshot();
    const external = storage.read();
    storage.commit(external.revision, { ...external.values, workspaceTrust: { '/tmp/example': 'trusted' } });

    const result = await settings.mutate({
      protocolVersion: 1,
      requestId: 'storage-conflict',
      action: 'set',
      scope: 'global',
      expectedRevision: before.revision,
      payload: { key: 'theme', value: 'octocode-light' },
    });

    expect(result).toMatchObject({ ok: false, error: { category: 'persistence' } });
    expect(settings.snapshot()).toEqual(before);
    expect(storage.read().values).toMatchObject({
      theme: 'octocode-dark',
      workspaceTrust: { '/tmp/example': 'trusted' },
    });
  });

  it('allows only one concurrent mutation from the same expected revision', async () => {
    const { storage, settings } = await harness();
    const expectedRevision = settings.snapshot().revision;
    const [theme, model] = await Promise.all([
      settings.mutate({
        protocolVersion: 1,
        requestId: 'concurrent-theme',
        action: 'set',
        scope: 'global',
        expectedRevision,
        payload: { key: 'theme', value: 'octocode-light' },
      }),
      settings.mutate({
        protocolVersion: 1,
        requestId: 'concurrent-model',
        action: 'set',
        scope: 'global',
        expectedRevision,
        payload: { key: 'defaultModel', value: 'gpt-5.6' },
      }),
    ]);

    expect([theme.ok, model.ok].filter(Boolean)).toHaveLength(1);
    expect(Object.keys(storage.read().values)).toHaveLength(1);
    const effective = settings.snapshot().values.filter((value) => value.stored);
    expect(effective).toHaveLength(1);
  });

  it('rejects invalid values without changing memory or disk', async () => {
    const { storage, settings } = await harness();
    const before = settings.snapshot();
    const result = await settings.mutate({
      protocolVersion: 1,
      requestId: 'invalid-model',
      action: 'set',
      scope: 'global',
      expectedRevision: revision(String(before.revision)),
      payload: { key: 'defaultModel', value: '   ' },
    });

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(settings.snapshot()).toEqual(before);
    expect(storage.read().values).toEqual({});
  });

  it('enforces the same default-model length bound as the settings page', async () => {
    const { storage, settings } = await harness();
    const before = settings.snapshot();
    const result = await settings.mutate({
      protocolVersion: 1,
      requestId: 'oversized-model',
      action: 'set',
      scope: 'global',
      expectedRevision: before.revision,
      payload: { key: 'defaultModel', value: 'm'.repeat(201) },
    });

    expect(result).toMatchObject({ ok: false, error: { category: 'validation' } });
    expect(settings.snapshot()).toEqual(before);
    expect(storage.read().values).toEqual({});
  });

  it('exports only portable public values and imports them transactionally', async () => {
    const { storage, settings } = await harness({
      theme: 'octocode-light', defaultProvider: 'openai', defaultModel: 'gpt-5.6',
      nativeExtensions: { reviewedHashes: { secret: 'a'.repeat(64) }, pluginGrants: {} },
      apiKey: 'must-never-export', arbitrary: { private: true },
    });
    expect(settings.exportPortable()).toEqual({
      schemaVersion: 1,
      values: { theme: 'octocode-light', defaultProvider: 'openai', defaultModel: 'gpt-5.6' },
    });
    expect(JSON.stringify(settings.exportPortable())).not.toContain('must-never-export');
    expect(JSON.stringify(settings.exportPortable())).not.toContain('nativeExtensions');

    const imported = await settings.importPortable({
      requestId: 'import', expectedRevision: settings.snapshot().revision,
      document: { schemaVersion: 1, values: { theme: 'octocode-dark', defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5' } },
    });
    expect(imported.ok).toBe(true);
    expect(storage.read().values).toMatchObject({ theme: 'octocode-dark', defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-5', arbitrary: { private: true } });
  });

  it('rejects unknown import keys and resets registered settings atomically', async () => {
    const { storage, settings } = await harness({ theme: 'octocode-light', defaultModel: 'gpt-5.6', arbitrary: 'preserved' });
    const rejected = await settings.importPortable({
      requestId: 'bad-import', expectedRevision: settings.snapshot().revision,
      document: { schemaVersion: 1, values: { apiKey: 'secret' } },
    });
    expect(rejected).toMatchObject({ ok: false, error: { category: 'validation' } });
    const reset = await settings.reset({ requestId: 'reset', expectedRevision: settings.snapshot().revision });
    expect(reset.ok).toBe(true);
    expect(storage.read().values).toEqual({ arbitrary: 'preserved' });
  });
});
