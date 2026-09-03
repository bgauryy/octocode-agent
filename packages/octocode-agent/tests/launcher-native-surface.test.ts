import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { workspaceAgentRoot } from '@octocodeai/octocode-shared/paths';
import { authData, authProvidersData, completionScript, discoveryData, doctorData, fatalErrorReport, helpReport, main, modelsData, modelsReport, parseInvocation, ROOT_OPTIONS, runModelsCheck, runSurface, sessionsData, updateCommand } from '../src/launcher.js';
import { FileSettingsStorage } from '../src/native-settings.js';

describe('native launcher public surface', () => {
  it('preserves the command inventory in help and parsing', () => {
    for (const command of ['setup', 'auth', 'models', 'discover', 'sessions', 'resume', 'session', 'update', 'config', 'doctor', 'completion', 'run', 'serve', 'acp', 'tools', 'skills', 'memory', 'awareness']) {
      expect(parseInvocation([command]).command).toBe(command);
      expect(helpReport()).toContain(command);
    }
    expect(parseInvocation(['--help'])).toMatchObject({ command: 'help', args: [] });
    expect(parseInvocation(['-h'])).toMatchObject({ command: 'help', args: [] });
    expect(parseInvocation(['--version'])).toMatchObject({ command: 'version', args: [] });
    expect(parseInvocation(['-v'])).toMatchObject({ command: 'version', args: [] });
  });

  it('lists every native runtime flag and alias in root help', () => {
    const help = helpReport();
    for (const option of ROOT_OPTIONS) {
      expect(help, option.usage).toContain(option.usage);
      for (const name of option.names) {
        expect(completionScript('bash'), name).toContain(name);
      }
    }
  });

  it.each([
    'setup',
    'auth',
    'models',
    'discover',
    'doctor',
    'update',
    'completion',
    'help',
    'version',
  ])('prints scoped %s help instead of executing the command', async (command) => {
    const out = vi.fn();
    await expect(main([command, '--help'], { out })).resolves.toBe(0);
    expect(out).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining(`Usage: octocode-agent ${command}`),
    );
  });

  it('supports the conventional help <command> form', async () => {
    const out = vi.fn();
    await expect(main(['help', 'run'], { out })).resolves.toBe(0);
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining('Usage: octocode-agent run'),
    );
  });

  it('delegates help for nested tool and coordination command trees', async () => {
    const spawn = vi.fn(() => ({ status: 0 } as never));
    await expect(main(['help', 'tools'], { spawn })).resolves.toBe(0);
    await expect(main(['help', 'awareness'], { spawn })).resolves.toBe(0);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'npx',
      ['octocode', 'tools', '--help'],
      expect.any(Object),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'npx',
      ['@octocodeai/octocode-awareness', '--help'],
      expect.any(Object),
    );
  });

  it.each([
    ['run', '--help'],
    ['run', '-h'],
    ['serve', '--help'],
    ['serve', '-h'],
    ['acp', '--help'],
    ['acp', '-h'],
  ])('prints scoped %s help for %s without starting the runtime', async (command, flag) => {
    const createRuntime = vi.fn(async () => {
      throw new Error('help must not start the runtime');
    });
    const out = vi.fn();

    await expect(main([command, flag], { createRuntime, out })).resolves.toBe(0);

    expect(out).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledWith(expect.stringContaining(`Usage: octocode-agent ${command}`));
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['sessions', '--help'],
    ['sessions', '-h'],
    ['resume', '--help'],
    ['resume', '-h'],
    ['session', '--help'],
    ['session', '-h'],
  ])('prints scoped %s help for %s without reading or starting a session', async (command, flag) => {
    const createRuntime = vi.fn(async () => {
      throw new Error('help must not start the runtime');
    });
    const out = vi.fn();

    await expect(main([command, flag], { createRuntime, out })).resolves.toBe(0);

    expect(out).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledWith(expect.stringContaining(`Usage: octocode-agent ${command}`));
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])('prints config help for %s without reading configuration', async (flag) => {
    const createRuntime = vi.fn(async () => {
      throw new Error('help must not start the runtime');
    });
    const out = vi.fn();

    await expect(main(['config', flag], { createRuntime, out })).resolves.toBe(0);

    expect(out).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledWith(expect.stringContaining('Usage: octocode-agent config'));
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('uses the public settings catalog in config help and persists typed values', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-config-cli-'));
    const env = { HOME: root, OCTOCODE_HOME: path.join(root, 'octocode') };
    const helpOut = vi.fn();

    await expect(main(['config', '--help'], { env, out: helpOut })).resolves.toBe(0);
    for (const key of [
      'theme',
      'reducedMotion',
      'compactionInputTokenThreshold',
      'defaultProvider',
      'defaultModel',
    ]) {
      expect(helpOut.mock.calls[0]?.[0], key).toContain(key);
    }

    await expect(main(['config', 'set', 'reducedMotion', 'false'], { env, out: vi.fn() })).resolves.toBe(0);
    await expect(main(['config', 'set', 'compactionInputTokenThreshold', '80000'], { env, out: vi.fn() })).resolves.toBe(0);

    const stored = new FileSettingsStorage(
      path.join(env.OCTOCODE_HOME, 'agent', 'settings.json'),
    ).read().values;
    expect(stored).toMatchObject({
      reducedMotion: false,
      compactionInputTokenThreshold: 80_000,
    });

    const invalidOut = vi.fn();
    await expect(main(['config', 'set', 'reducedMotion', 'yes'], { env, out: invalidOut })).resolves.toBe(2);
    expect(invalidOut).toHaveBeenCalledWith(expect.stringContaining('settings validation'));
    expect(new FileSettingsStorage(
      path.join(env.OCTOCODE_HOME, 'agent', 'settings.json'),
    ).read().values.reducedMotion).toBe(false);
  });

  it('keeps the settings reference aligned with the public config catalog', () => {
    const settingsReference = fs.readFileSync(
      new URL('../docs/SETTINGS.md', import.meta.url),
      'utf8',
    );
    for (const key of [
      'theme',
      'reducedMotion',
      'compactionInputTokenThreshold',
      'defaultProvider',
      'defaultModel',
    ]) {
      expect(settingsReference, key).toContain(`\`${key}\``);
    }
    expect(settingsReference).toContain('octocode-agent models --set openai/gpt-5');
  });

  it.each([
    ['run', '--model', 'fixture/model', '--help'],
    ['serve', '--allow-workers', '-h'],
  ])('prints scoped %s help when the flag follows command options', async (...args) => {
    const createRuntime = vi.fn(async () => {
      throw new Error('runtime must not start for help');
    });
    const out = vi.fn();

    await expect(main(args, { createRuntime, out })).resolves.toBe(0);
    expect(out).toHaveBeenCalledWith(expect.stringContaining(`Usage: octocode-agent ${args[0]}`));
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('preserves --help as literal run input after the option separator', async () => {
    const createRuntime = vi.fn(async () => {
      throw new Error('literal prompt reached the runtime');
    });

    await expect(main(['run', '--', '--help'], { createRuntime })).rejects.toThrow(
      'literal prompt reached the runtime',
    );
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it('keeps completion and platform update paths native', () => {
    expect(completionScript('zsh')).toContain('sessions');
    expect(completionScript('zsh')).toContain('completion');
    expect(completionScript('zsh')).toContain('--model');
    expect(completionScript('bash')).toContain('--continue');
    expect(completionScript('fish')).toContain('-l help');
    expect(updateCommand()).toEqual({ cmd: 'npm', args: ['install', '-g', 'octocode-agent@latest'] });
  });

  it('preserves literal --json prompt text after the option separator', () => {
    expect(parseInvocation(['run', '--json', '--', '--json'])).toEqual({
      command: 'run', args: ['--', '--json'], json: true,
    });
    expect(parseInvocation(['run', '--', '--json'])).toEqual({
      command: 'run', args: ['--', '--json'], json: false,
    });
  });

  it('turns OpenTUI FFI startup failures into an actionable one-line diagnostic', () => {
    expect(fatalErrorReport(
      new Error('Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet'),
      'v26.4.0',
    )).toBe('octocode-agent: OpenTUI is unavailable on v26.4.0. Use Node.js 26.4 or later, or use --print for non-interactive output.');
  });

  it('reports the exact native model protocol boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-model-boundary-'));
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const env = {
      HOME: path.join(root, 'home'),
      OCTOCODE_HOME: path.join(root, 'octocode'),
      OCTOCODE_MODEL_ENDPOINT: 'https://models.example/v1',
      OCTOCODE_MODEL_PROTOCOL: 'openai-chat-completions',
    };
    const data = modelsData(env, cwd);
    expect(data.protocol).toBe('openai-responses');
    expect(data.endpoint).toBe('https://api.openai.com/v1');
    expect(data.protocolSupport.filter((entry) => entry.supported)).toEqual([
      { protocol: 'openai-chat-completions', supported: true },
      { protocol: 'openai-responses', supported: true },
      { protocol: 'anthropic-messages', supported: true },
    ]);
    expect(data).toMatchObject({
      persistedSelection: null,
      effectiveSelection: { providerId: 'openai', modelId: 'gpt-5' },
      selectionSource: 'canonical',
      credential: expect.objectContaining({ configured: false }),
    });
    expect(data.catalog.sources.map(({ id }) => id)).not.toContain('native.environment');
    expect(modelsReport(env, cwd)).toContain('effective: openai/gpt-5 (canonical)');
    expect(modelsReport(env, cwd)).toContain('persisted: (not set)');
    expect(modelsReport(env, cwd)).not.toContain('anthropic-messages:');
  });

  it('checks the selected provider through an injected probe with stable JSON exit semantics', async () => {
    const out = vi.fn();
    const probe = vi.fn(async () => ({
      status: 'PASS' as const, protocol: 'openai-responses' as const, stop: 'complete' as const,
    }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-model-check-'));
    const cwd = path.join(root, 'workspace');
    const octocodeHome = path.join(root, 'octocode');
    const agentDir = path.join(octocodeHome, 'agent');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        custom: {
          baseUrl: 'https://models.example/v1', api: 'openai-responses', apiKey: '$OCTOCODE_MODEL_API_KEY',
          models: [{ id: 'selected-model' }],
        },
      },
    }));
    new FileSettingsStorage(path.join(agentDir, 'settings.json')).commit('0', {
      defaultProvider: 'custom', defaultModel: 'selected-model',
    });
    const env = { HOME: path.join(root, 'home'), OCTOCODE_HOME: octocodeHome, OCTOCODE_MODEL_API_KEY: 'api-key-value' };

    await expect(runModelsCheck({ env, cwd, out }, true, probe)).resolves.toBe(0);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'openai-responses', endpoint: 'https://models.example/v1', apiKey: 'api-key-value', model: 'selected-model',
    }));
    const result = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(result).toEqual({
      status: 'verified', configured: true, verified: true,
      providerId: 'custom', modelId: 'selected-model', protocol: 'openai-responses',
    });
    expect(JSON.stringify(result)).not.toContain('api-key-value');
  });

  it('does not treat a credential-gated live provider canary skip as a release pass', async () => {
    const out = vi.fn();
    const probe = vi.fn(async () => ({
      status: 'SKIP' as const, protocol: 'openai-responses' as const, capability: 'credentials-absent' as const,
    }));

    await expect(runModelsCheck({ env: {}, out }, true, probe)).resolves.toBe(1);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      status: 'unconfigured', configured: false, verified: false, reason: 'credentials-absent',
    });
  });

  it('reports an unhealthy provider without leaking credentials or response bodies', async () => {
    const out = vi.fn();
    const env = { OCTOCODE_MODEL_API_KEY: 'api-key-value' };
    const probe = vi.fn(async () => ({
      status: 'FAIL' as const, protocol: 'openai-responses' as const,
      category: 'provider-smoke' as const, reason: 'unauthorized' as const,
    }));

    await expect(runModelsCheck({ env, out }, false, probe)).resolves.toBe(1);
    expect(String(out.mock.calls[0]?.[0])).toContain('unhealthy');
    expect(String(out.mock.calls[0]?.[0])).toContain('unauthorized');
    expect(String(out.mock.calls[0]?.[0])).not.toContain('api-key-value');
    expect(String(out.mock.calls[0]?.[0])).not.toContain('response body');
  });

  it('routes config and model mutations through typed, atomic settings transactions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-settings-'));
    const env = { OCTOCODE_HOME: home };
    const dir = path.join(home, 'agent');
    const storage = new FileSettingsStorage(path.join(dir, 'settings.json'));
    storage.commit('0', { arbitrary: { preserved: true } });
    const out = vi.fn();

    await expect(main(['config', 'set', 'theme', 'plain-dark'], { env, out })).resolves.toBe(2);
    await expect(main(['models', '--set', 'anthropic/claude-custom'], { env, out })).resolves.toBe(0);
    fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
      providers: { local: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', apiKey: 'local', models: [{ id: 'qwen' }] } },
    }));
    await expect(main(['models', '--set', 'local/qwen'], { env, cwd: home, out })).resolves.toBe(0);

    expect(storage.read().values).toEqual({
      arbitrary: { preserved: true },
      defaultProvider: 'local',
      defaultModel: 'qwen',
    });
    expect(out).toHaveBeenCalledWith(expect.stringMatching(/validation/i));
  });

  it('reports discovery and configuration sources without model credentials', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-discovery-'));
    const env = { HOME: path.join(root, 'home'), OCTOCODE_HOME: path.join(root, 'octocode') };
    const cwd = path.join(root, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const out = vi.fn();
    try {
      await expect(main(['discover', '--json'], { env, cwd, out })).resolves.toBe(0);
      const discovery = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
      expect(discovery).toMatchObject({ schemaVersion: 1, workspace: cwd });
      expect(discovery.models.sources).toContainEqual(expect.objectContaining({ id: 'native.canonical' }));

      await expect(main(['discover', 'mcp'], { env, cwd, out })).resolves.toBe(0);
      expect(String(out.mock.calls.at(-1)?.[0])).toMatch(/^MCP servers/);
      expect(String(out.mock.calls.at(-1)?.[0])).not.toContain('Models (');

      await expect(main(['config', 'sources', '--json'], { env, cwd, out })).resolves.toBe(0);
      expect(JSON.parse(String(out.mock.calls.at(-1)?.[0]))).toMatchObject({ schemaVersion: 1, workspace: cwd });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('aligns readiness and auth choices with selected Pi model credentials', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-pi-credentials-'));
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode');
    const cwd = path.join(root, 'workspace');
    const env = { HOME: home, OCTOCODE_HOME: octocodeHome };
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        custom: {
          baseUrl: 'https://models.example/v1',
          api: 'openai-completions',
          apiKey: '$CUSTOM_PROVIDER_KEY',
          headers: { 'x-tenant': '${CUSTOM_TENANT_KEY}' },
          models: [{ id: 'custom-model' }],
        },
      },
    }));
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
      defaultProvider: 'custom',
      defaultModel: 'custom-model',
    }));

    try {
      const missing = doctorData(env, cwd);
      expect(missing.checks.find(({ name }) => name === 'credentials')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('CUSTOM_PROVIDER_KEY'),
      });
      expect(missing.checks.find(({ name }) => name === 'credentials')?.detail).toContain('CUSTOM_TENANT_KEY');
      expect(authData(env, cwd)).toMatchObject({
        configured: false,
        providerId: 'custom',
        environmentVariables: ['CUSTOM_PROVIDER_KEY', 'CUSTOM_TENANT_KEY'],
      });
      expect(authProvidersData(env, cwd)).toContainEqual(expect.objectContaining({
        keyVar: 'CUSTOM_PROVIDER_KEY',
        label: expect.stringContaining('custom'),
      }));

      const configuredEnv = { ...env, CUSTOM_PROVIDER_KEY: 'secret-value', CUSTOM_TENANT_KEY: 'tenant-value' };
      expect(doctorData(configuredEnv, cwd).checks.find(({ name }) => name === 'credentials')).toMatchObject({ ok: true });
      const discovery = discoveryData(configuredEnv, cwd);
      expect(discovery.models.credential).toMatchObject({
        providerId: 'custom',
        configured: true,
        source: 'environment',
        environmentVariables: ['CUSTOM_PROVIDER_KEY', 'CUSTOM_TENANT_KEY'],
        missingEnvironmentVariables: [],
      });
      expect(JSON.stringify(discovery)).not.toContain('secret-value');
      expect(JSON.stringify(discovery)).not.toContain('tenant-value');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows a uniquely matching Pi model when its configured provider name is stale', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-pi-provider-alias-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    const env = { HOME: home, OCTOCODE_HOME: path.join(root, 'octocode') };
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'renamed-provider': {
          baseUrl: 'https://models.example/v1',
          api: 'openai-completions',
          apiKey: '$RENAMED_PROVIDER_KEY',
          models: [{ id: 'stable-model-id' }],
        },
      },
    }));
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
      defaultProvider: 'old-provider-name',
      defaultModel: 'stable-model-id',
    }));

    try {
      expect(discoveryData(env, cwd).models).toMatchObject({
        selection: { providerId: 'renamed-provider', modelId: 'stable-model-id' },
        selectionSource: 'pi.user.settings',
        credential: {
          providerId: 'renamed-provider',
          configured: false,
          environmentVariables: ['RENAMED_PROVIDER_KEY'],
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats Pi credential commands as configured but deferred during discovery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-command-credentials-'));
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode');
    const cwd = path.join(root, 'workspace');
    const env = { HOME: home, OCTOCODE_HOME: octocodeHome };
    fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        delegated: {
          baseUrl: 'https://models.example/v1',
          api: 'openai-completions',
          apiKey: '!command-that-must-not-run-during-discovery',
          models: [{ id: 'delegated-model' }],
        },
      },
    }));
    fs.writeFileSync(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
      defaultProvider: 'delegated',
      defaultModel: 'delegated-model',
    }));

    try {
      expect(discoveryData(env, cwd).models.credential).toMatchObject({
        providerId: 'delegated',
        configured: true,
        source: 'command',
        verification: 'request-time',
      });
      expect(doctorData(env, cwd).checks.find(({ name }) => name === 'credentials')).toMatchObject({ ok: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes managed discovery configuration without overwriting existing files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-setup-'));
    const env = { OCTOCODE_HOME: path.join(root, 'octocode') };
    const out = vi.fn();
    try {
      await expect(main(['setup', '--fix'], { env, out })).resolves.toBe(0);
      const agent = path.join(env.OCTOCODE_HOME, 'agent');
      expect(JSON.parse(fs.readFileSync(path.join(agent, 'models.json'), 'utf8'))).toEqual({ providers: {} });
      expect(JSON.parse(fs.readFileSync(path.join(agent, 'mcp', 'servers.json'), 'utf8'))).toEqual({ mcpServers: {} });
      expect(fs.statSync(path.join(agent, 'skills')).isDirectory()).toBe(true);
      fs.writeFileSync(path.join(agent, 'models.json'), '{"providers":{"kept":{}}}\n');
      await expect(main(['setup', '--fix'], { env, out })).resolves.toBe(0);
      expect(fs.readFileSync(path.join(agent, 'models.json'), 'utf8')).toContain('kept');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes repository discovery configuration from a nested working directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-project-setup-'));
    const env = { OCTOCODE_HOME: path.join(root, 'octocode') };
    const repository = path.join(root, 'repository');
    const cwd = path.join(repository, 'packages', 'app');
    const out = vi.fn();
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    try {
      await expect(main(['setup', '--fix', '--scope', 'unknown'], { env, cwd, out })).resolves.toBe(2);
      expect(out).toHaveBeenLastCalledWith(
        'Usage: octocode-agent setup [--fix] [--scope global|project|all]',
      );
      await expect(main(['setup', '--fix', '--scope', 'project'], { env, cwd, out })).resolves.toBe(0);
      const agent = workspaceAgentRoot(repository, env.OCTOCODE_HOME);
      expect(JSON.parse(fs.readFileSync(path.join(agent, 'models.json'), 'utf8'))).toEqual({ providers: {} });
      expect(JSON.parse(fs.readFileSync(path.join(agent, 'mcp', 'servers.json'), 'utf8'))).toEqual({ mcpServers: {} });
      expect(fs.statSync(path.join(agent, 'skills')).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(env.OCTOCODE_HOME, 'agent', 'models.json'))).toBe(false);

      await expect(main(['setup', '--fix', '--scope', 'all'], { env, cwd, out })).resolves.toBe(0);
      expect(fs.existsSync(path.join(env.OCTOCODE_HOME, 'agent', 'models.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes resume into the native launcher composition', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('native composition reached'); });
    await expect(main(['resume', 's1'], { createRuntime })).rejects.toThrow('native composition reached');
    expect(createRuntime).toHaveBeenCalled();
  });

  it('allows resume options without misreading the first option as a session id', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('native composition reached'); });
    await expect(main(['resume', '--allow-workers'], { createRuntime })).rejects.toThrow(
      'native composition reached',
    );
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ continue: true, allowWorkers: true }),
      }),
    );
  });

  it('lists sessions from the Rust durability index and closes the owned client', async () => {
    const close = vi.fn(async () => undefined);
    const sessionList = vi.fn(async ({ cwd }: { cwd: string }) => [{
      sessionId: 'durable-session', revision: '4', cwd, parentSessionId: null, updatedAt: 42,
    }]);

    await expect(sessionsData({}, '/workspace', () => ({ sessionList, close }))).resolves.toEqual({
      storage: 'rust',
      sessions: [{ sessionId: 'durable-session', revision: '4', cwd: '/workspace', updatedAt: 42 }],
    });
    expect(sessionList).toHaveBeenCalledWith({ cwd: '/workspace', limit: 1_000 });
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the Rust session client when durable discovery fails', async () => {
    const failure = new Error('session index unavailable');
    const close = vi.fn(async () => undefined);
    const sessionList = vi.fn(async () => { throw failure; });

    await expect(sessionsData({}, '/workspace', () => ({ sessionList, close }))).rejects.toThrow(
      'Rust session operation failed',
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('maps the public plural skills command to the Octocode singular skill surface', () => {
    const spawn = vi.fn(() => ({ status: 0 } as never));
    expect(runSurface('skills', ['--help'], { spawn })).toBe(0);
    expect(spawn).toHaveBeenCalledWith('npx', ['octocode', 'skill', '--help'], expect.any(Object));
  });

  it('delegates Awareness root commands without repeating the public surface noun', () => {
    const spawn = vi.fn(() => ({ status: 0 } as never));
    expect(runSurface('awareness', ['attend', '--workspace', '/workspace'], { spawn })).toBe(0);
    expect(runSurface('memory', ['recall', '--query', 'task'], { spawn })).toBe(0);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      'npx',
      ['@octocodeai/octocode-awareness', 'attend', '--workspace', '/workspace'],
      expect.any(Object),
    );
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      'npx',
      ['@octocodeai/octocode-awareness', 'memory', 'recall', '--query', 'task'],
      expect.any(Object),
    );
  });

  it('forwards machine-readable output flags to delegated tool and skill surfaces', async () => {
    const spawn = vi.fn(() => ({ status: 0 } as never));
    await expect(main(['tools', '--json'], { spawn })).resolves.toBe(0);
    await expect(main(['skills', 'list', '--json'], { spawn })).resolves.toBe(0);
    expect(spawn).toHaveBeenNthCalledWith(1, 'npx', ['octocode', 'tools', '--json'], expect.any(Object));
    expect(spawn).toHaveBeenNthCalledWith(2, 'npx', ['octocode', 'skill', 'list', '--json'], expect.any(Object));
  });
});
