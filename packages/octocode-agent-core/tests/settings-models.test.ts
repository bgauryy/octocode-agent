import { describe, expect, it } from 'vitest';
import { ModelCatalog, SettingsRegistry, SettingsService, revision, type SettingDefinition } from '../src/index.js';

const definition: SettingDefinition = {
  key: 'runtime.mode', schemaVersion: 1, section: 'Runtime', order: 1,
  kind: { type: 'enum', values: ['safe', 'fast'] }, scopes: ['workspace', 'global'],
  defaultValue: 'safe', mutability: 'editable', application: 'immediate', visibility: 'public', owner: 'core', documentation: 'https://octocode.ai',
};

describe('SettingsService', () => {
  it('applies precedence and rejects stale writes', async () => {
    const registry = new SettingsRegistry();
    registry.register(definition);
    const service = new SettingsService(registry);
    const before = service.snapshot();
    const result = await service.mutate({ protocolVersion: 1, requestId: 'r1', action: 'set', scope: 'workspace', expectedRevision: before.revision, payload: { key: 'runtime.mode', value: 'fast' } });
    expect(result.ok && result.effectiveValue?.value).toBe('fast');
    const stale = await service.mutate({ protocolVersion: 1, requestId: 'r2', action: 'set', scope: 'workspace', expectedRevision: before.revision, payload: { key: 'runtime.mode', value: 'safe' } });
    expect(stale).toMatchObject({ ok: false, error: { category: 'conflict' } });
  });

  it('redacts secret references by construction', async () => {
    const registry = new SettingsRegistry();
    registry.register({ ...definition, key: 'provider.credential', kind: { type: 'secret-reference' }, visibility: 'secret-reference', defaultValue: null });
    const service = new SettingsService(registry);
    await service.mutate({ protocolVersion: 1, requestId: 'r', action: 'set', scope: 'global', expectedRevision: service.snapshot().revision, payload: { key: 'provider.credential', value: 'env:TOP_SECRET' } });
    expect(JSON.stringify(service.snapshot())).not.toContain('TOP_SECRET');
  });
});

describe('ModelCatalog', () => {
  it('merges sources deterministically and validates the default pair', () => {
    const catalog = new ModelCatalog();
    catalog.replaceSource({ id: 'global', kind: 'canonical', scope: 'global', precedence: 10, writable: true, revision: revision('g1'), parseState: 'valid', redaction: 'public' }, {
      providers: [{ id: 'openai', apiFamily: 'responses', enabled: true, scope: 'global', sourceId: 'global', credential: { type: 'environment', name: 'OPENAI_API_KEY' } }],
      models: [{ providerId: 'openai', id: 'gpt', displayName: 'GPT', enabled: true, limits: { context: null, output: null }, modalities: ['text'], tools: 'supported', thinking: { supported: true, levels: ['high'] }, cost: null, sourceId: 'global', scope: 'global', warnings: [] }],
    });
    catalog.selectDefault('openai', 'gpt');
    expect(catalog.snapshot().defaultModel).toEqual({ providerId: 'openai', modelId: 'gpt' });
    expect(() => catalog.selectDefault('openai', 'missing')).toThrow(/unknown model/i);
  });
});
