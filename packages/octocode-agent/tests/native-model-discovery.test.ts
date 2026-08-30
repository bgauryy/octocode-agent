import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceAgentRoot } from '@octocodeai/octocode-shared/paths';

import { discoverNativeModelSources, discoverPiModelSelection, resolvePiModelConfigValue } from '../src/native-model-discovery.js';
import { resolveNativeModelConfiguration } from '../src/native-provider-registry.js';

function fixture(): { root: string; home: string; octocodeHome: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-model-discovery-'));
  const home = path.join(root, 'home');
  const octocodeHome = path.join(root, 'octocode');
  const cwd = path.join(root, 'workspace', 'nested');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(octocodeHome, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { root, home, octocodeHome, cwd };
}

function write(file: string, value: unknown): string {
  const content = JSON.stringify(value, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return content;
}

describe('native filesystem model discovery', () => {
  it('discovers Pi global selection and lets only trusted workspace settings override it', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(home, '.pi', 'agent', 'settings.json'), {
      defaultProvider: 'global-provider',
      defaultModel: 'global-model',
    });
    write(path.join(path.dirname(cwd), '.pi', 'settings.json'), {
      defaultProvider: 'workspace-provider',
      defaultModel: 'workspace-model',
    });

    expect(discoverPiModelSelection({ cwd, home, octocodeHome, workspaceTrusted: true })).toEqual({
      providerId: 'workspace-provider',
      modelId: 'workspace-model',
      sourceId: 'pi.workspace.settings',
    });
    expect(discoverPiModelSelection({ cwd, home, octocodeHome, workspaceTrusted: false })).toEqual({
      providerId: 'global-provider',
      modelId: 'global-model',
      sourceId: 'pi.user.settings',
    });
  });

  it('loads native and Pi sources with exact paths, hashes, precedence, and redacted credentials', () => {
    const { home, octocodeHome, cwd } = fixture();
    const piUser = path.join(home, '.pi', 'agent', 'models.json');
    const nativeGlobal = path.join(octocodeHome, 'agent', 'models.json');
    const workspaceRoot = path.dirname(cwd);
    const piWorkspace = path.join(workspaceRoot, '.pi', 'models.json');
    const nativeWorkspace = path.join(workspaceAgentRoot(cwd, octocodeHome), 'models.json');
    write(piUser, { providers: { ollama: { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'literal-secret', models: [{ id: 'llama', contextWindow: 8192 }] } } });
    write(nativeGlobal, { providers: { responses: { baseUrl: 'https://responses.example/v1', api: 'openai-responses', apiKey: '$RESPONSES_KEY', headers: { 'x-safe': '${SAFE_HEADER}', 'x-secret': 'literal-secret' }, models: [{ id: 'reasoner', name: 'Reasoner', reasoning: true, input: ['text', 'image'], maxTokens: 4096 }] } } });
    write(piWorkspace, { providers: { anthropic: { baseUrl: 'https://anthropic.example/v1', api: 'anthropic-messages', apiKey: '${ANTHROPIC_TOKEN}', models: [{ id: 'claude-work' }] } } });
    const nativeContent = write(nativeWorkspace, { providers: { google: { baseUrl: 'https://google.example/v1', api: 'google-generative-ai', apiKey: '$GOOGLE_KEY', models: [{ id: 'gemini-work' }] } } });

    const discovered = discoverNativeModelSources({ cwd, home, octocodeHome });

    expect(discovered.map(({ descriptor }) => ({ id: descriptor.id, precedence: descriptor.precedence, path: descriptor.path, scope: descriptor.scope }))).toEqual([
      { id: 'pi.user', precedence: 20, path: piUser, scope: 'global' },
      { id: 'native.global', precedence: 30, path: nativeGlobal, scope: 'global' },
      { id: 'pi.workspace', precedence: 40, path: piWorkspace, scope: 'workspace' },
      { id: 'native.workspace', precedence: 50, path: nativeWorkspace, scope: 'workspace' },
    ]);
    expect(discovered[3]!.descriptor.revision).toBe(createHash('sha256').update(nativeContent).digest('hex'));
    expect(discovered[0]!.contribution.providers[0]!.credential).toBeNull();
    expect(discovered[1]!.contribution.providers[0]).toMatchObject({
      credential: { type: 'environment', name: 'RESPONSES_KEY' },
      headers: { 'x-safe': { environment: 'SAFE_HEADER' } },
    });
    expect(JSON.stringify(discovered)).not.toContain('literal-secret');
    expect(discovered[1]!.contribution.models[0]).toMatchObject({
      displayName: 'Reasoner', enabled: true, limits: { context: null, output: 4096 }, modalities: ['text', 'image'], thinking: { supported: true, levels: [] },
    });
    expect(discovered[3]!.contribution.providers[0]).toMatchObject({ enabled: false, apiFamily: 'google-generative-ai' });
    expect(discovered[3]!.contribution.models[0]).toMatchObject({ enabled: false, warnings: expect.arrayContaining([expect.stringMatching(/unsupported/i)]) });

    const selected = resolveNativeModelConfiguration({
      env: { SAFE_HEADER: 'safe', PREFIX: 'pre', SUFFIX: 'post' },
      cwd,
      home,
      octocodeHome,
      configuredProvider: 'ollama',
      configuredModel: 'llama',
    });
    expect(selected.resolveRuntimeAuth?.()).toEqual({ apiKey: 'literal-secret', headers: {} });
  });

  it('resolves Pi command, environment interpolation, literal, and escape value forms', () => {
    const command = (value: string): string => value === 'credential-helper' ? 'command-secret\n' : '';
    const env = { PREFIX: 'pre', SUFFIX: 'post' };

    expect(resolvePiModelConfigValue('!credential-helper', env, command)).toBe('command-secret');
    expect(resolvePiModelConfigValue('${PREFIX}_$SUFFIX', env, command)).toBe('pre_post');
    expect(resolvePiModelConfigValue('literal-key', env, command)).toBe('literal-key');
    expect(resolvePiModelConfigValue('$$cash-$!bang', env, command)).toBe('$cash-!bang');
    expect(() => resolvePiModelConfigValue('$MISSING', env, command)).toThrow(/MISSING/);
  });

  it('bridges the exact Pi api_key credential with Pi precedence and config-value semantics', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(home, '.pi', 'agent', 'models.json'), {
      providers: {
        custom: {
          baseUrl: 'http://127.0.0.1:43123/v1', api: 'openai-completions', apiKey: 'models-secret',
          models: [{ id: 'custom-model' }],
        },
      },
    });
    write(path.join(home, '.pi', 'agent', 'auth.json'), {
      custom: { type: 'api_key', key: '${PI_CUSTOM_KEY}', env: { PI_CUSTOM_KEY: 'auth-secret' } },
      other: { type: 'api_key', key: 'other-secret' },
    });

    const selected = resolveNativeModelConfiguration({
      env: {}, cwd, home, octocodeHome, configuredProvider: 'custom', configuredModel: 'custom-model',
    });

    expect(selected.credential).toMatchObject({ configured: true, source: 'environment', missingEnvironmentVariables: [] });
    expect(selected.resolveRuntimeAuth?.()).toEqual({ apiKey: 'auth-secret', headers: {} });
    expect(JSON.stringify(selected)).not.toMatch(/auth-secret|models-secret|other-secret/);

    write(path.join(home, '.pi', 'agent', 'auth.json'), {
      other: { type: 'api_key', key: 'other-secret' },
    });
    const exactProvider = resolveNativeModelConfiguration({
      env: {}, cwd, home, octocodeHome, configuredProvider: 'custom', configuredModel: 'custom-model',
    });
    expect(exactProvider.resolveRuntimeAuth?.()).toEqual({ apiKey: 'models-secret', headers: {} });
  });

  it('ignores symlinked and oversized Pi auth files', () => {
    for (const unsafe of ['symlink', 'oversized'] as const) {
      const { home, octocodeHome, cwd } = fixture();
      write(path.join(home, '.pi', 'agent', 'models.json'), {
        providers: { custom: { baseUrl: 'http://127.0.0.1:43123/v1', api: 'openai-completions', apiKey: 'models-secret', models: [{ id: 'custom-model' }] } },
      });
      const authFile = path.join(home, '.pi', 'agent', 'auth.json');
      if (unsafe === 'symlink') {
        const outside = write(path.join(home, 'outside-auth.json'), { custom: { type: 'api_key', key: 'unsafe-secret' } });
        expect(outside).toContain('unsafe-secret');
        fs.mkdirSync(path.dirname(authFile), { recursive: true });
        fs.symlinkSync(path.join(home, 'outside-auth.json'), authFile);
      } else {
        fs.mkdirSync(path.dirname(authFile), { recursive: true });
        fs.writeFileSync(authFile, ' '.repeat((1024 * 1024) + 1));
      }

      const selected = resolveNativeModelConfiguration({
        env: {}, cwd, home, octocodeHome, configuredProvider: 'custom', configuredModel: 'custom-model',
      });
      expect(selected.resolveRuntimeAuth?.()).toEqual({ apiKey: 'models-secret', headers: {} });
    }
  });

  it('fails honestly without exposing Pi OAuth credentials', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(home, '.pi', 'agent', 'models.json'), {
      providers: { custom: { baseUrl: 'http://127.0.0.1:43123/v1', api: 'openai-completions', models: [{ id: 'custom-model' }] } },
    });
    write(path.join(home, '.pi', 'agent', 'auth.json'), {
      custom: { type: 'oauth', access: 'oauth-access-secret', refresh: 'oauth-refresh-secret', expires: Date.now() + 60_000 },
    });

    const selected = resolveNativeModelConfiguration({
      env: {}, cwd, home, octocodeHome, configuredProvider: 'custom', configuredModel: 'custom-model',
    });
    expect(selected.credential).toMatchObject({ configured: false, source: 'unsupported' });
    expect(() => selected.resolveRuntimeAuth?.()).toThrow('Pi OAuth credentials are unsupported by the native provider runtime');
    expect(JSON.stringify(selected)).not.toMatch(/oauth-access-secret|oauth-refresh-secret/);
  });

  it('fails closed for a malformed exact-provider Pi credential', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(home, '.pi', 'agent', 'models.json'), {
      providers: { custom: { baseUrl: 'http://127.0.0.1:43123/v1', api: 'openai-completions', apiKey: 'models-fallback-must-not-win', models: [{ id: 'custom-model' }] } },
    });
    write(path.join(home, '.pi', 'agent', 'auth.json'), {
      custom: { type: 'api_key', key: { secret: 'malformed-secret' } },
    });

    const selected = resolveNativeModelConfiguration({
      env: {}, cwd, home, octocodeHome, configuredProvider: 'custom', configuredModel: 'custom-model',
    });
    expect(selected.credential).toMatchObject({ configured: false, source: 'unsupported' });
    expect(() => selected.resolveRuntimeAuth?.()).toThrow('The selected Pi credential is malformed');
    expect(JSON.stringify(selected)).not.toMatch(/malformed-secret|models-fallback-must-not-win/);
  });

  it('rejects credential-bearing provider URLs so discovery output cannot leak URL secrets', () => {
    const { home, octocodeHome, cwd } = fixture();
    const file = path.join(octocodeHome, 'agent', 'models.json');
    write(file, { providers: { unsafe: { baseUrl: 'https://user:password@example.test/v1?api_key=query-secret', api: 'openai-completions', models: [{ id: 'unsafe-model' }] } } });

    const [source] = discoverNativeModelSources({ cwd, home, octocodeHome });
    const provider = source!.contribution.providers[0]!;
    expect(provider).toMatchObject({ id: 'unsafe', enabled: false });
    expect(provider.endpoint).toBeUndefined();
    expect(provider.warnings).toContain('Provider baseUrl must not contain credentials, query parameters, or a fragment');
    expect(JSON.stringify(source)).not.toContain('password');
    expect(JSON.stringify(source)).not.toContain('query-secret');
  });

  it('retains symlinked and oversized model sources only as invalid provenance', () => {
    const { home, octocodeHome, cwd } = fixture();
    const outside = path.join(home, 'outside-models.json');
    const linked = path.join(octocodeHome, 'agent', 'models.json');
    const oversized = path.join(home, '.pi', 'agent', 'models.json');
    write(outside, { providers: { escaped: { baseUrl: 'https://escaped.example/v1', api: 'openai-completions', models: [{ id: 'escaped' }] } } });
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked);
    fs.mkdirSync(path.dirname(oversized), { recursive: true });
    fs.writeFileSync(oversized, ' '.repeat((1024 * 1024) + 1));

    const discovered = discoverNativeModelSources({ cwd, home, octocodeHome });
    expect(discovered).toHaveLength(2);
    expect(discovered.every(({ descriptor }) => descriptor.parseState === 'invalid')).toBe(true);
    expect(discovered.every(({ contribution }) => contribution.providers.length === 0 && contribution.models.length === 0)).toBe(true);
  });

  it('uses the nearest workspace ancestor and retains malformed sources as invalid provenance', () => {
    const { home, octocodeHome, cwd } = fixture();
    const farther = path.join(path.dirname(path.dirname(cwd)), '.pi', 'models.json');
    const nearer = path.join(path.dirname(cwd), '.pi', 'models.json');
    write(farther, { providers: { farther: { baseUrl: 'http://farther.test/v1', api: 'openai-completions', models: [{ id: 'farther' }] } } });
    write(nearer, { providers: { nearer: { baseUrl: 'http://nearer.test/v1', api: 'openai-completions', models: [{ id: 'nearer' }] } } });
    const invalid = path.join(octocodeHome, 'agent', 'models.json');
    fs.mkdirSync(path.dirname(invalid), { recursive: true });
    fs.writeFileSync(invalid, '{ invalid');

    const discovered = discoverNativeModelSources({ cwd, home, octocodeHome });
    const pi = discovered.find(({ descriptor }) => descriptor.id === 'pi.workspace')!;
    const native = discovered.find(({ descriptor }) => descriptor.id === 'native.global')!;
    expect(pi.descriptor.path).toBe(nearer);
    expect(pi.contribution.models.map(({ id }) => id)).toEqual(['nearer']);
    expect(native.descriptor).toMatchObject({ path: invalid, parseState: 'invalid' });
    expect(native.contribution).toEqual({ providers: [], models: [] });
  });

  it('keeps untrusted workspace model sources visible but ineffective', () => {
    const { home, octocodeHome, cwd } = fixture();
    const workspaceModel = path.join(workspaceAgentRoot(cwd, octocodeHome), 'models.json');
    write(workspaceModel, { providers: { redirected: { baseUrl: 'https://redirect.example/v1', api: 'openai-completions', models: [{ id: 'redirected-model' }] } } });

    const resolved = resolveNativeModelConfiguration({ env: {}, cwd, home, octocodeHome, workspaceTrusted: false });
    expect(resolved.selection).toEqual({ providerId: 'openai', modelId: 'gpt-5' });
    expect(resolved.catalog.sources).toContainEqual(expect.objectContaining({ id: 'native.workspace', parseState: 'warning' }));
    expect(resolved.catalog.providers).toContainEqual(expect.objectContaining({ id: 'redirected', enabled: false }));
    expect(resolved.catalog.models).toContainEqual(expect.objectContaining({ providerId: 'redirected', id: 'redirected-model', enabled: false }));
  });

  it('discovers prompt-cache policy and cache-specific model pricing without inventing defaults', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(octocodeHome, 'agent', 'models.json'), {
      providers: {
        cached: {
          baseUrl: 'https://cached.example/v1',
          api: 'openai-responses',
          promptCaching: { mode: 'disabled' },
          models: [{ id: 'priced', cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } }],
        },
        automatic: {
          baseUrl: 'https://auto.example/v1',
          api: 'anthropic-messages',
          models: [{ id: 'unknown-price' }],
        },
      },
    });

    const [source] = discoverNativeModelSources({ cwd, home, octocodeHome });
    expect(source!.contribution.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cached', promptCaching: { mode: 'disabled' } }),
      expect.objectContaining({ id: 'automatic', promptCaching: { mode: 'auto' } }),
    ]));
    expect(source!.contribution.models).toContainEqual(expect.objectContaining({
      providerId: 'cached',
      cost: { currency: 'USD', inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 },
    }));
    expect(source!.contribution.models.find((model) => model.id === 'unknown-price')?.cost).toBeNull();
  });

  it('selects a Pi Anthropic model with session affinity and a supported thinking map', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(home, '.pi', 'agent', 'models.json'), {
      providers: {
        'selected-provider-x': {
          baseUrl: 'https://anthropic-compatible.example/v1',
          api: 'anthropic-messages',
          apiKey: 'literal-secret',
          compat: { sendSessionAffinityHeaders: true },
          models: [{
            id: 'selected-model', reasoning: true, maxTokens: 32_000,
            thinkingLevelMap: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
          }],
        },
      },
    });
    write(path.join(home, '.pi', 'agent', 'settings.json'), {
      defaultProvider: 'selected-provider',
      defaultModel: 'selected-model',
    });
    write(path.join(home, '.pi', 'agent', 'auth.json'), {
      'selected-provider': { type: 'api_key', key: 'selected-auth-secret' },
    });

    const selected = resolveNativeModelConfiguration({ env: {}, cwd, home, octocodeHome });

    expect(selected.selection).toEqual({ providerId: 'selected-provider-x', modelId: 'selected-model' });
    expect(selected.selectionSource).toBe('pi.user.settings');
    expect(selected.protocol).toBe('anthropic-messages');
    expect(selected.sendSessionAffinityHeaders).toBe(true);
    expect(selected.maxOutputTokens).toBe(32_000);
    expect(selected.credential).toMatchObject({ configured: true, missingEnvironmentVariables: [] });
    const selectedProvider = selected.catalog.providers.find(({ id }) => id === 'selected-provider-x');
    expect(selectedProvider).toMatchObject({ id: 'selected-provider-x', enabled: true });
    expect(selectedProvider?.warnings ?? []).toEqual([]);
    expect(selected.catalog.models).toContainEqual(expect.objectContaining({
      providerId: 'selected-provider-x', id: 'selected-model', enabled: true,
      thinking: { supported: true, levels: ['high', 'low', 'medium', 'minimal', 'xhigh'] },
    }));
    expect(selected.resolveRuntimeAuth?.()).toEqual({ apiKey: 'selected-auth-secret', headers: {} });
    expect(JSON.stringify(selected)).not.toMatch(/literal-secret|selected-auth-secret/);
  });

  it('fails closed when Pi compatibility semantics cannot be preserved by the native adapters', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(octocodeHome, 'agent', 'models.json'), {
      providers: {
        incompatible: {
          baseUrl: 'https://compatible.example/v1',
          api: 'openai-completions',
          compat: { unknownWireFormat: true },
          models: [{ id: 'custom', samplingParams: { temperature: 0.2 } }],
        },
      },
    });

    const [source] = discoverNativeModelSources({ cwd, home, octocodeHome });
    expect(source!.contribution.providers).toContainEqual(expect.objectContaining({
      id: 'incompatible', enabled: false,
      warnings: expect.arrayContaining([expect.stringContaining('Unsupported Pi provider semantics: compat')]),
    }));
    expect(source!.contribution.models).toContainEqual(expect.objectContaining({
      providerId: 'incompatible', id: 'custom', enabled: false, tools: 'unknown',
      warnings: expect.arrayContaining([expect.stringContaining('Unsupported Pi model semantics: samplingParams')]),
    }));
  });

  it('keeps compatible OpenAI transport hints enabled', () => {
    const { home, octocodeHome, cwd } = fixture();
    write(path.join(octocodeHome, 'agent', 'models.json'), {
      providers: {
        compatible: {
          baseUrl: 'https://compatible.example/v1',
          api: 'openai-completions',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
          models: [{ id: 'custom', maxTokens: 32_000 }],
        },
      },
    });

    const [source] = discoverNativeModelSources({ cwd, home, octocodeHome });
    expect(source!.contribution.providers).toContainEqual(expect.objectContaining({ id: 'compatible', enabled: true }));
    expect(source!.contribution.models).toContainEqual(expect.objectContaining({ providerId: 'compatible', id: 'custom', enabled: true }));
  });
});
