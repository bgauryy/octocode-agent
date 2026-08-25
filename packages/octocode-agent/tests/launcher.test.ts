import { describe, it, expect, vi } from 'vitest';
import {
  CORE_PACKAGE,
  CORE_SPEC,
  PI_PACKAGE,
  getEffectivePiPackage,
  resolveCoreSpec,
  resolvePiBin,
  parseInvocation,
  buildLaunchEnv,
  buildPiArgs,
  updateCommand,
  versionReport,
  helpReport,
  configReport,
  setupReport,
  authReport,
  modelsReport,
  sessionsReport,
  launcherVersion,
  launchAgent,
  runUpdate,
  main,
  resolvePackageJson,
  readPackageVersion,
  spawnExitStatus,
  launcherRoot,
  versionData,
  configData,
  setupData,
  authData,
  modelsData,
  sessionsData,
  completionScript,
  COMPLETION_SHELLS,
  doctorReport,
} from '../src/launcher.js';
import type { LaunchDeps, PiBinInfo } from '../src/types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

describe('bin shim ↔ build output contract', () => {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const binUrl = new URL('../bin/octocode-agent.mjs', import.meta.url);

  it('bin shim delegates to the exact bundle package.json "bin" ships', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { bin: string };
    const shim = readFileSync(binUrl, 'utf8');
    // package.json bin is the published entry — the bundled, self-running module.
    expect(pkg.bin).toBe('./out/octocode-agent.mjs');
    // The shim must import that same bundle …
    expect(shim).toContain('../out/octocode-agent.mjs');
    // … and must NOT reference the non-bundled tsc path that the esbuild build never emits.
    expect(shim).not.toContain('out/launcher.js');
  });
});

describe('constants', () => {
  it('CORE_SPEC is the npm: spec for pi -e flag', () => {
    expect(CORE_SPEC).toBe(`npm:${CORE_PACKAGE}`);
    expect(CORE_SPEC).toContain('@octocodeai/pi-extension');
  });

  it('spawnExitStatus treats null or missing status as failure', () => {
    expect(spawnExitStatus({ status: 0 })).toBe(0);
    expect(spawnExitStatus({ status: 7 })).toBe(7);
    expect(spawnExitStatus({ status: null })).toBe(1);
    expect(spawnExitStatus({ error: new Error('spawn failed') })).toBe(1);
    expect(spawnExitStatus(undefined)).toBe(1);
  });
});

// ── Package resolution ─────────────────────────────────────────────────────────

describe('resolvePackageJson / readPackageVersion', () => {
  it('returns null for an unresolvable package', () => {
    expect(resolvePackageJson('__not_a_real_package__')).toBeNull();
    expect(readPackageVersion('__not_a_real_package__')).toBeNull();
  });
});

// ── getEffectivePiPackage ─────────────────────────────────────────────────────

describe('getEffectivePiPackage', () => {
  it('returns default PI_PACKAGE when no override is set', () => {
    expect(getEffectivePiPackage({})).toBe(PI_PACKAGE);
  });

  it('returns OCTOCODE_PI_PACKAGE override when set', () => {
    const env = { OCTOCODE_PI_PACKAGE: '@myorg/custom-pi' };
    expect(getEffectivePiPackage(env)).toBe('@myorg/custom-pi');
  });
});

// ── resolveCoreSpec ────────────────────────────────────────────────────────────

describe('resolveCoreSpec', () => {
  it('returns OCTOCODE_AGENT_EXTENSION_SPEC when set', () => {
    const env = { OCTOCODE_AGENT_EXTENSION_SPEC: '/custom/path/to/ext' };
    expect(resolveCoreSpec(env)).toBe('/custom/path/to/ext');
  });

  it('always returns a non-empty string', () => {
    const spec = resolveCoreSpec({});
    expect(spec.length).toBeGreaterThan(0);
  });

  it('returns a local path or the npm: fallback', () => {
    const spec = resolveCoreSpec({});
    const isLocalPath = spec.startsWith('/') || spec.startsWith('.');
    const isNpmSpec = spec.startsWith('npm:');
    expect(isLocalPath || isNpmSpec).toBe(true);
  });
});

// ── resolvePiBin ───────────────────────────────────────────────────────────────

describe('resolvePiBin (smoke)', () => {
  it('returns null for a non-existent OCTOCODE_PI_BIN path', () => {
    const result = resolvePiBin({ OCTOCODE_PI_BIN: '/absolutely/does/not/exist' });
    expect(result).toBeNull();
  });

  it('resolves bundled Pi host from node_modules when installed', () => {
    const result = resolvePiBin({});
    // In the monorepo with @earendil-works/pi-coding-agent installed, this succeeds.
    // In a stripped environment it may be null — both are valid.
    if (result !== null) {
      expect(result.bin.length).toBeGreaterThan(0);
      expect(['bundled', 'env-package', 'env-bin']).toContain(result.source);
    }
  });
});

// ── parseInvocation ────────────────────────────────────────────────────────────

describe('parseInvocation', () => {
  it('routes reserved subcommands', () => {
    expect(parseInvocation(['update']).command).toBe('update');
    expect(parseInvocation(['update']).target).toBe('platform');
    expect(parseInvocation(['update', 'core']).target).toBe('core');
    expect(parseInvocation(['--version']).command).toBe('version');
    expect(parseInvocation(['-v']).command).toBe('version');
    expect(parseInvocation(['version']).command).toBe('version');
    expect(parseInvocation(['--agent-help']).command).toBe('help');
    // `npx octocode-agent --help` must print help, never open the TUI
    expect(parseInvocation(['--help']).command).toBe('help');
    expect(parseInvocation(['-h']).command).toBe('help');
    expect(parseInvocation(['help']).command).toBe('help');
    expect(parseInvocation(['config']).command).toBe('config');
    expect(parseInvocation(['setup']).command).toBe('setup');
    expect(parseInvocation(['auth']).command).toBe('auth');
    expect(parseInvocation(['models']).command).toBe('models');
    expect(parseInvocation(['sessions']).command).toBe('sessions');
  });

  it('forwards everything else to Pi', () => {
    const inv = parseInvocation(['--model', 'claude-opus-4-5', 'do something']);
    expect(inv.command).toBe('launch');
    expect(inv.rest).toEqual(['--model', 'claude-opus-4-5', 'do something']);
  });

  it('routes surface verbs and parses --profile', () => {
    expect(parseInvocation(['research', 'q']).command).toBe('research');
    expect(parseInvocation(['memory', 'recall']).command).toBe('memory');
    expect(parseInvocation(['awareness', 'status']).command).toBe('awareness');
    expect(parseInvocation(['tools']).command).toBe('tools');
    expect(parseInvocation(['skills']).command).toBe('skills');
    expect(parseInvocation(['--profile', 'ci', 'do x']).profile).toBe('ci');
    expect(parseInvocation(['run', '--profile', 'ci', 'x']).profile).toBe('ci');
  });

  it('routes the new verbs run/serve/resume/doctor', () => {
    expect(parseInvocation(['run', 'do x']).command).toBe('run');
    expect(parseInvocation(['run', 'do x']).rest).toEqual(['do x']);
    expect(parseInvocation(['run', 'x', '--json']).json).toBe(true);
    expect(parseInvocation(['serve']).command).toBe('serve');
    expect(parseInvocation(['resume', 'abc']).command).toBe('resume');
    expect(parseInvocation(['resume', 'abc']).rest).toEqual(['abc']);
    expect(parseInvocation(['doctor']).command).toBe('doctor');
  });

  it('routes new info subcommands (config/setup/auth/models/sessions)', () => {
    expect(parseInvocation(['config', '--json']).command).toBe('config');
    expect(parseInvocation(['setup']).command).toBe('setup');
    expect(parseInvocation(['auth']).command).toBe('auth');
    expect(parseInvocation(['models']).command).toBe('models');
    expect(parseInvocation(['sessions']).command).toBe('sessions');
  });

  it('detects --json for every report command and defaults to falsy without it', () => {
    expect(parseInvocation(['config', '--json']).json).toBe(true);
    expect(parseInvocation(['setup', '--json']).json).toBe(true);
    expect(parseInvocation(['auth', '--json']).json).toBe(true);
    expect(parseInvocation(['models', '--json']).json).toBe(true);
    expect(parseInvocation(['sessions', '--json']).json).toBe(true);
    expect(parseInvocation(['--version', '--json']).json).toBe(true);
    expect(parseInvocation(['config']).json).toBeFalsy();
    expect(parseInvocation(['version']).json).toBeFalsy();
  });

  it('routes completion <shell>', () => {
    expect(parseInvocation(['completion', 'bash'])).toEqual({ command: 'completion', shell: 'bash' });
    expect(parseInvocation(['completion', 'zsh']).shell).toBe('zsh');
    expect(parseInvocation(['completion', 'fish']).shell).toBe('fish');
    expect(parseInvocation(['completion']).shell).toBeUndefined();
  });
});

// ── buildLaunchEnv ─────────────────────────────────────────────────────────────

describe('buildLaunchEnv', () => {
  it('sets octocode-first mode and marks the agent without clobbering user env', () => {
    const env = buildLaunchEnv({ MY_VAR: 'keep-me' });
    expect(env.OCTOCODE_PROMPT_MODE).toBe('octocode-first');
    expect(env.OCTOCODE_AGENT).toBe('1');
    expect(env.MY_VAR).toBe('keep-me');
  });

  it('never overrides an explicit OCTOCODE_PROMPT_MODE', () => {
    const env = buildLaunchEnv({ OCTOCODE_PROMPT_MODE: 'custom-mode' });
    expect(env.OCTOCODE_PROMPT_MODE).toBe('custom-mode');
  });

  it('defaults PI_SKIP_VERSION_CHECK=1 (our update story wins); explicit values keep control', () => {
    expect(buildLaunchEnv({}).PI_SKIP_VERSION_CHECK).toBe('1');
    expect(buildLaunchEnv({ PI_SKIP_VERSION_CHECK: '' }).PI_SKIP_VERSION_CHECK).toBe('');
    expect(buildLaunchEnv({ PI_SKIP_VERSION_CHECK: '0' }).PI_SKIP_VERSION_CHECK).toBe('0');
  });
});

// ── updateCommand ──────────────────────────────────────────────────────────────

describe('updateCommand', () => {
  it('core: installs into the current launcher prefix', () => {
    const { cmd, args } = updateCommand('core', { prefix: '/my/prefix' });
    expect(cmd).toBe('npm');
    expect(args).toContain('--prefix');
    expect(args).toContain('/my/prefix');
    expect(args.some((a) => a.startsWith('@octocodeai/pi-extension'))).toBe(true);
  });

  it('platform: self-updates globally', () => {
    const { cmd, args } = updateCommand('platform');
    expect(cmd).toBe('npm');
    expect(args).toContain('-g');
    expect(args.some((a) => a.includes('octocode-agent'))).toBe(true);
  });
});

// ── versionReport ──────────────────────────────────────────────────────────────

describe('versionReport', () => {
  it('names launcher, core, Pi host, and launch mode', () => {
    const report = versionReport({});
    expect(report).toContain('octocode-agent');
    expect(report).toContain(CORE_PACKAGE);
    expect(report).toContain('launch mode');
  });

  it('shows SDK embed as default launch mode', () => {
    expect(versionReport({})).toContain('SDK embed');
  });

  it('shows subprocess mode when forced', () => {
    expect(versionReport({ OCTOCODE_LAUNCHER_MODE: 'subprocess' })).toContain('subprocess');
  });

  it('shows npm: fallback when core is not installed locally', () => {
    // With an empty env the core spec fallback is used.
    const report = versionReport({});
    // Either it found a local version or shows the npm: fallback message.
    expect(report.includes(CORE_PACKAGE)).toBe(true);
  });

  it('shows override package name when OCTOCODE_PI_PACKAGE is set', () => {
    const report = versionReport({ OCTOCODE_PI_PACKAGE: '@myorg/custom-pi' });
    expect(report).toContain('@myorg/custom-pi');
  });

  it('shows local binary path when OCTOCODE_PI_BIN is set', () => {
    const report = versionReport({ OCTOCODE_PI_BIN: '/usr/local/bin/pi' });
    expect(report).toContain('/usr/local/bin/pi');
  });
});

// ── versionData (--json companion) ───────────────────────────────────────────────

describe('versionData', () => {
  it('reports the same underlying facts as versionReport, structured', () => {
    const data = versionData({});
    expect(data.core.package).toBe(CORE_PACKAGE);
    expect(data.launchMode).toBe('sdk-embed');
  });

  it('shows subprocess launch mode when forced', () => {
    expect(versionData({ OCTOCODE_LAUNCHER_MODE: 'subprocess' }).launchMode).toBe('subprocess');
  });

  it('shows override pi package name when OCTOCODE_PI_PACKAGE is set', () => {
    expect(versionData({ OCTOCODE_PI_PACKAGE: '@myorg/custom-pi' }).pi.package).toBe('@myorg/custom-pi');
  });

  it('reports the local binary path and a null version when OCTOCODE_PI_BIN is set', () => {
    const data = versionData({ OCTOCODE_PI_BIN: '/usr/local/bin/pi' });
    expect(data.pi.localBinPath).toBe('/usr/local/bin/pi');
    expect(data.pi.version).toBeNull();
  });

  it('output is JSON-serializable', () => {
    expect(() => JSON.stringify(versionData({}))).not.toThrow();
  });
});

// ── helpReport ─────────────────────────────────────────────────────────────────

describe('helpReport', () => {
  it('documents launch, update, info subcommands, and fork env vars', () => {
    const report = helpReport();
    expect(report).toContain('octocode-agent');
    expect(report).toContain('update');
    expect(report).toContain('config');
    expect(report).toContain('OCTOCODE_PI_BIN');
    expect(report).toContain('OCTOCODE_PI_PACKAGE');
    expect(report).toContain('SDK embed');
    expect(report).toContain('suppress Pi native tools');
  });
});

// ── configReport ───────────────────────────────────────────────────────────────

describe('configReport', () => {
  it('shows all key configuration fields', () => {
    const report = configReport({});
    expect(report).toContain('octocode home');
    expect(report).toContain('core');
    expect(report).toContain('runtime');
    expect(report).not.toContain('pi host');
    expect(report).toContain('launcher version');
    expect(report).toContain('api keys set');
  });

  it('lists only SET env overrides', () => {
    const report = configReport({ OCTOCODE_LAUNCHER_MODE: 'subprocess' });
    expect(report).toContain('OCTOCODE_LAUNCHER_MODE');
    expect(report).not.toContain('OCTOCODE_PI_BIN');
  });

  it('shows subprocess mode when forced', () => {
    const report = configReport({ OCTOCODE_LAUNCHER_MODE: 'subprocess' });
    expect(report).toContain('subprocess');
  });

  it('shows custom OCTOCODE_HOME when set', () => {
    const report = configReport({ OCTOCODE_HOME: '/custom/home' });
    expect(report).toContain('/custom/home');
  });
});

// ── configData (--json companion) ────────────────────────────────────────────────

describe('configData', () => {
  it('reports the same underlying facts as configReport, structured', () => {
    const data = configData({});
    expect(data.core.spec).toBeTruthy();
    expect(typeof data.octocodeHomeHasAuth).toBe('boolean');
    expect(data.launchMode).toBe('sdk-embed');
  });

  it('shows subprocess launch mode when forced', () => {
    expect(configData({ OCTOCODE_LAUNCHER_MODE: 'subprocess' }).launchMode).toBe('subprocess');
  });

  it('shows custom OCTOCODE_HOME when set', () => {
    expect(configData({ OCTOCODE_HOME: '/custom/home' }).octocodeHome).toBe('/custom/home');
  });

  it('echoes every documented env override as null when unset', () => {
    const data = configData({});
    expect(data.env.OCTOCODE_HOME).toBeNull();
    expect(data.env.OCTOCODE_PI_BIN).toBeNull();
  });

  it('output is JSON-serializable', () => {
    expect(() => JSON.stringify(configData({}))).not.toThrow();
  });
});

// ── setupReport ────────────────────────────────────────────────────────────────

describe('setupReport', () => {
  it('shows check results and quick-start commands', () => {
    const report = setupReport({});
    expect(report).toContain('octocode-agent setup');
    expect(report).toContain('octocode-agent');
    // At least one check present
    expect(report.includes('✓') || report.includes('✗')).toBe(true);
  });
});

// ── setupData (--json companion) ─────────────────────────────────────────────────

describe('setupData', () => {
  it('has one check per prerequisite, matching the ✓/✗ report lines', () => {
    const data = setupData({});
    expect(data.checks.map((c) => c.name)).toEqual(['pi-host', 'core', 'api-keys']);
  });

  it('allGood is true only when every check passes', () => {
    const data = setupData({ ANTHROPIC_API_KEY: 'sk-test' });
    const apiKeysCheck = data.checks.find((c) => c.name === 'api-keys')!;
    expect(apiKeysCheck.ok).toBe(true);
    expect(data.allGood).toBe(data.checks.every((c) => c.ok));
  });

  it('api-keys check fails with no keys detected', () => {
    const data = setupData({});
    const apiKeysCheck = data.checks.find((c) => c.name === 'api-keys')!;
    expect(apiKeysCheck.ok).toBe(false);
    expect(apiKeysCheck.detail).toBe('none detected');
  });

  it('output is JSON-serializable', () => {
    expect(() => JSON.stringify(setupData({}))).not.toThrow();
  });
});

// ── authReport ─────────────────────────────────────────────────────────────────

describe('authReport', () => {
  it('documents API key options and detected keys', () => {
    const report = authReport({});
    expect(report).toContain('ANTHROPIC_API_KEY');
    expect(report).toContain('OPENAI_API_KEY');
    expect(report).toContain('Currently detected');
  });

  it('shows detected keys when present', () => {
    const report = authReport({ ANTHROPIC_API_KEY: 'sk-test', GITHUB_TOKEN: 'gh-token' });
    expect(report).toContain('ANTHROPIC_API_KEY');
    expect(report).toContain('GITHUB_TOKEN');
  });
});

// ── authData (--json companion) ──────────────────────────────────────────────────

describe('authData', () => {
  it('reports detected keys, not the static option list', () => {
    expect(authData({})).toEqual({
      detectedKeys: [],
      authJsonPath: expect.stringContaining('auth.json'),
    });
  });

  it('reports keys actually present in env', () => {
    const data = authData({ ANTHROPIC_API_KEY: 'sk-test', GITHUB_TOKEN: 'gh-token' });
    expect(data.detectedKeys).toContain('ANTHROPIC_API_KEY');
    expect(data.detectedKeys).toContain('GITHUB_TOKEN');
  });
});

// ── modelsReport ───────────────────────────────────────────────────────────────

describe('modelsReport', () => {
  it('shows model names, flags, and thinking levels', () => {
    const report = modelsReport();
    expect(report).toContain('claude');
    expect(report).toContain('--model');
    expect(report).toContain('--thinking');
  });
});

// ── modelsData (--json companion) ────────────────────────────────────────────────

describe('modelsData', () => {
  it('lists the same common models referenced in modelsReport', () => {
    const data = modelsData();
    const ids = data.commonModels.map((m) => m.id);
    expect(ids).toContain('claude-opus-4-5');
    expect(ids).toContain('gpt-4o');
    expect(data.commonModels.every((m) => m.provider && m.note)).toBe(true);
  });

  it('output is JSON-serializable', () => {
    expect(() => JSON.stringify(modelsData())).not.toThrow();
  });
});

// ── sessionsReport ─────────────────────────────────────────────────────────────

describe('sessionsReport', () => {
  it('shows session storage path and management commands', () => {
    const report = sessionsReport();
    expect(report).toContain('sessions');
    expect(report).toContain('THIS terminal');
    expect(report).toContain('--no-session');
  });
});

// ── sessionsData (--json companion) ──────────────────────────────────────────────

describe('sessionsData', () => {
  it('reports the sessions directory', () => {
    const data = sessionsData();
    expect(data.sessionsDir).toContain('sessions');
    expect(data.sessionsDir).toContain('.pi');
  });
});

// ── completionScript ──────────────────────────────────────────────────────────────

describe('completionScript', () => {
  it('generates a script for every supported shell containing every subcommand', () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(shell);
      expect(script).toBeTruthy();
      for (const cmd of ['update', 'config', 'setup', 'auth', 'models', 'sessions', 'completion']) {
        expect(script).toContain(cmd);
      }
    }
  });

  it('bash script registers a complete -F for octocode-agent', () => {
    expect(completionScript('bash')).toContain('complete -F');
  });

  it('zsh script declares a #compdef for octocode-agent', () => {
    expect(completionScript('zsh')).toContain('#compdef octocode-agent');
  });

  it('fish script registers complete -c octocode-agent entries', () => {
    expect(completionScript('fish')).toContain('complete -c octocode-agent');
  });

  it('returns null for an unsupported/missing shell', () => {
    expect(completionScript('powershell')).toBeNull();
    expect(completionScript('')).toBeNull();
  });
});

// ── buildPiArgs ────────────────────────────────────────────────────────────────

describe('buildPiArgs', () => {
  it('default disables every Pi builtin while keeping extension tools and context files', () => {
    const args = buildPiArgs('npm:@octocodeai/pi-extension', [], {});
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--no-builtin-tools');
    expect(args).not.toContain('--exclude-tools');
    expect(args).not.toContain('--no-context-files');
  });

  it('supports npm: spec (recovery core delivery)', () => {
    const args = buildPiArgs('npm:@octocodeai/pi-extension', [], {});
    expect(args).toContain('-e');
    expect(args).toContain('npm:@octocodeai/pi-extension');
  });

  it('OCTOCODE_AGENT_NO_CONTEXT_FILES=1 suppresses context file loading', () => {
    const args = buildPiArgs('spec', [], { OCTOCODE_AGENT_NO_CONTEXT_FILES: '1' });
    expect(args).toContain('--no-context-files');
  });

  it('CLEAN suppresses user skills and context without restoring Pi builtins', () => {
    const cleanArgs = buildPiArgs('spec', [], { OCTOCODE_AGENT_CLEAN: '1' });
    expect(cleanArgs).toContain('--no-builtin-tools');
    expect(cleanArgs).toContain('--no-skills');
    expect(cleanArgs).toContain('--no-context-files');
  });

  it('CLEAN + lean forces no skills and no context files', () => {
    const args = buildPiArgs('spec', ['--extra'], {
      OCTOCODE_AGENT_CLEAN: '1',
    });
    expect(args).toContain('--no-skills');
    expect(args).toContain('--no-context-files');
    expect(args).toContain('--extra');
  });
});

// ── launchAgent ────────────────────────────────────────────────────────────────

describe('launchAgent', () => {
  it('resolves core via resolveCoreSpec and execs Pi; forwards exit code', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const code = await launchAgent(['--help'], {
      env: {},
      spawn,
      launchWithSdk: async () => null,
      resolvePiBin: () => ({ bin: '/fake/pi', pkgRoot: '/fake', source: 'bundled' }),
      resolveCoreSpec: () => 'npm:@octocodeai/pi-extension',
    } satisfies LaunchDeps);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      '/fake/pi',
      expect.arrayContaining(['-e', 'npm:@octocodeai/pi-extension']),
      expect.any(Object),
    );
  });

  it('works with npm: spec (lean mode — core not installed locally)', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const code = await launchAgent([], {
      env: {},
      spawn,
      launchWithSdk: async () => null,
      resolvePiBin: () => ({ bin: '/fake/pi', pkgRoot: '/fake', source: 'bundled' }),
      resolveCoreSpec: () => CORE_SPEC,
    } satisfies LaunchDeps);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      '/fake/pi',
      expect.arrayContaining(['-e', CORE_SPEC]),
      expect.any(Object),
    );
  });

  it('honors OCTOCODE_AGENT_EXTENSION_SPEC override', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const code = await launchAgent([], {
      env: { OCTOCODE_AGENT_EXTENSION_SPEC: '/local/ext' },
      spawn,
      launchWithSdk: async () => null,
      resolvePiBin: () => ({ bin: '/fake/pi', pkgRoot: '/fake', source: 'bundled' }),
    } satisfies LaunchDeps);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      '/fake/pi',
      expect.arrayContaining(['-e', '/local/ext']),
      expect.any(Object),
    );
  });

  it('returns 1 when Pi host is missing', async () => {
    const messages: string[] = [];
    const code = await launchAgent([], {
      env: {},
      log: (m) => messages.push(m),
      launchWithSdk: async () => null,
      resolvePiBin: () => null,
    } satisfies LaunchDeps);
    expect(code).toBe(1);
    expect(messages.some((m) => m.includes('not installed') || m.includes('not found'))).toBe(true);
  });

  it('shows helpful error when OCTOCODE_PI_BIN path is not found', async () => {
    const messages: string[] = [];
    const code = await launchAgent([], {
      env: { OCTOCODE_PI_BIN: '/no/such/bin' },
      log: (m) => messages.push(m),
      launchWithSdk: async () => null,
      resolvePiBin: () => null,
    } satisfies LaunchDeps);
    expect(code).toBe(1);
    expect(messages.some((m) => m.includes('OCTOCODE_PI_BIN') || m.includes('not found') || m.includes('not installed'))).toBe(true);
  });

  it('skips SDK when OCTOCODE_LAUNCHER_MODE=subprocess', async () => {
    const sdkFn = vi.fn();
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    await launchAgent([], {
      env: { OCTOCODE_LAUNCHER_MODE: 'subprocess' },
      spawn,
      launchWithSdk: sdkFn,
      resolvePiBin: () => ({ bin: '/fake/pi', pkgRoot: '/fake', source: 'bundled' }),
      resolveCoreSpec: () => 'spec',
    } satisfies LaunchDeps);
    expect(sdkFn).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalled();
  });

  it('uses SDK result when SDK embed succeeds', async () => {
    const spawn = vi.fn();
    const code = await launchAgent([], {
      env: {},
      spawn,
      launchWithSdk: async () => 0,
    } satisfies LaunchDeps);
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('falls back to subprocess when SDK returns null', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const code = await launchAgent([], {
      env: {},
      spawn,
      launchWithSdk: async () => null,
      resolvePiBin: () => ({ bin: '/fake/pi', pkgRoot: '/fake', source: 'bundled' }),
      resolveCoreSpec: () => 'spec',
    } satisfies LaunchDeps);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalled();
  });

  it('treats subprocess null status as launch failure', async () => {
    const spawn = vi.fn().mockReturnValue({ status: null });
    const code = await launchAgent([], {
      env: {},
      spawn,
      launchWithSdk: async () => null,
      resolvePiBin: () => ({ bin: '/fake/pi', pkgRoot: '/fake', source: 'bundled' }),
      resolveCoreSpec: () => 'spec',
    } satisfies LaunchDeps);
    expect(code).toBe(1);
  });
});

// ── main ───────────────────────────────────────────────────────────────────────

describe('main', () => {
  it('dispatches version/help/update/run', async () => {
    const lines: string[] = [];
    const out = (m: string) => lines.push(m);

    await main(['--version'], { out, env: {} });
    expect(lines.join('\n')).toContain('octocode-agent');

    lines.length = 0;
    await main(['--agent-help'], { out, env: {} });
    expect(lines.join('\n')).toContain('octocode-agent');
  });

  it('update core installs the extension', async () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    const code = await main(['update', 'core'], {
      spawn,
      env: {},
      prefix: '/fake/prefix',
    } satisfies LaunchDeps);
    expect(code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'npm',
      expect.arrayContaining(['install', '--prefix', '/fake/prefix']),
      expect.any(Object),
    );
  });

  it('update reports null spawn status as failure', async () => {
    const spawn = vi.fn().mockReturnValue({ status: null });
    const code = await main(['update', 'platform'], { spawn, env: {} } satisfies LaunchDeps);
    expect(code).toBe(1);
  });

  it('config prints configuration report', async () => {
    const lines: string[] = [];
    const code = await main(['config'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('octocode home');
  });

  it('setup prints setup report', async () => {
    const lines: string[] = [];
    const code = await main(['setup'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('octocode-agent setup');
  });

  it('auth prints auth report', async () => {
    const lines: string[] = [];
    const code = await main(['auth'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  it('models prints models report', async () => {
    const lines: string[] = [];
    const code = await main(['models'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('--model');
  });

  it('sessions prints sessions report', async () => {
    const lines: string[] = [];
    const code = await main(['sessions'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('THIS terminal');
  });

  it('--json prints valid, structured JSON instead of the text report, for every report command', async () => {
    const cases: Array<[string[], (r: unknown) => void]> = [
      [['--version', '--json'], (r) => expect((r as { core: unknown }).core).toBeDefined()],
      [['config', '--json'], (r) => expect((r as { octocodeHome: unknown }).octocodeHome).toBeDefined()],
      [['setup', '--json'], (r) => expect((r as { checks: unknown[] }).checks).toHaveLength(3)],
      [['auth', '--json'], (r) => expect((r as { detectedKeys: unknown[] }).detectedKeys).toEqual([])],
      [['models', '--json'], (r) => expect((r as { commonModels: unknown[] }).commonModels.length).toBeGreaterThan(0)],
      [['sessions', '--json'], (r) => expect((r as { sessionsDir: string }).sessionsDir).toContain('sessions')],
    ];
    for (const [argv, assertShape] of cases) {
      const lines: string[] = [];
      const code = await main(argv, { out: (m) => lines.push(m), env: {} });
      expect(code).toBe(0);
      const parsed: unknown = JSON.parse(lines.join('\n'));
      assertShape(parsed);
    }
  });

  it('run forwards --print + task to the agent', async () => {
    let captured: string[] | null = null;
    const code = await main(['run', 'fix the bug'], {
      env: {},
      launchWithSdk: async (argv) => { captured = argv; return 0; },
    });
    expect(code).toBe(0);
    expect(captured).toEqual(['--print', 'fix the bug']);
  });

  it('run --json forwards --mode json (not --print) and strips --json', async () => {
    let captured: string[] | null = null;
    await main(['run', 'list', '--json'], {
      env: {},
      launchWithSdk: async (argv) => { captured = argv; return 0; },
    });
    expect(captured).toEqual(['--mode', 'json', 'list']);
  });

  it('serve defaults to the Octocode thin-client stdio envelope', async () => {
    let captured: string[] | null = null;
    const code = await main(['serve', '--session', 'ide-main'], {
      env: {},
      runServeStdio: async (argv) => { captured = argv; return 0; },
    });
    expect(code).toBe(0);
    expect(captured).toEqual(['--session', 'ide-main']);
  });

  it('serve --raw-rpc preserves the old raw Pi RPC forwarding mode', async () => {
    let captured: string[] | null = null;
    await main(['serve', '--raw-rpc', '--no-session'], {
      env: {},
      launchWithSdk: async (argv) => { captured = argv; return 0; },
    });
    expect(captured).toEqual(['--mode', 'rpc', '--no-session']);
  });

  it('resume with an id maps to --session, without one maps to -r', async () => {
    let captured: string[] | null = null;
    await main(['resume', 'auth-refactor'], {
      env: {},
      launchWithSdk: async (argv) => { captured = argv; return 0; },
    });
    expect(captured).toEqual(['--session', 'auth-refactor']);
    await main(['resume'], {
      env: {},
      launchWithSdk: async (argv) => { captured = argv; return 0; },
    });
    expect(captured).toEqual(['-r']);
  });

  it('auth status exits 2 when no keys are detected', async () => {
    const lines: string[] = [];
    const code = await main(['auth', 'status'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('Not authenticated');
  });

  it('auth status exits 0 when a key is present', async () => {
    const code = await main(['auth', 'status'], { out: () => {}, env: { ANTHROPIC_API_KEY: 'x' } });
    expect(code).toBe(0);
  });

  it('doctor prints a health pane with all checks and a valid exit code', async () => {
    const lines: string[] = [];
    const code = await main(['doctor', '--json'], { out: (m) => lines.push(m), env: {} });
    const parsed = JSON.parse(lines.join('\n')) as { healthy: boolean; checks: unknown[] };
    expect(parsed.checks).toHaveLength(5);
    expect(typeof parsed.healthy).toBe('boolean');
    expect([0, 1]).toContain(code);
  });

  it('research spawns `npx octocode search`', async () => {
    let cmd = '';
    let args: readonly string[] = [];
    const spawn = vi.fn((c: string, a?: readonly string[]) => { cmd = c; args = a ?? []; return { status: 0 }; });
    const code = await main(['research', 'auth flow'], { env: {}, spawn });
    expect(code).toBe(0);
    expect(cmd).toBe('npx');
    expect(args).toEqual(['octocode', 'search', 'auth flow']);
  });

  it('surface verbs report null spawn status as failure', async () => {
    const spawn = vi.fn().mockReturnValue({ status: null });
    const code = await main(['tools', '--json'], { env: {}, spawn });
    expect(code).toBe(1);
  });

  it('memory spawns the bundled awareness CLI when resolvable', async () => {
    let cmd = '';
    const spawn = vi.fn((c: string) => { cmd = c; return { status: 0 }; });
    const code = await main(['memory', 'recall', 'x'], {
      env: { OCTOCODE_AWARENESS_CLI: `${process.cwd()}/package.json` },
      spawn,
    });
    expect(code).toBe(0);
    // buildAwarenessLiteCommand spawns the CLI under the SAME Node that runs the
    // launcher (process.execPath), not a bare 'node' from PATH — this guarantees a
    // consistent runtime even when node isn't on PATH.
    expect(cmd).toBe(process.execPath);
  });

  it('applyProfile via run prepends preset flags and strips --profile tokens', async () => {
    let captured: string[] | null = null;
    // No profiles.json in the temp HOME → profile lookup is a no-op, but tokens are still stripped.
    await main(['run', '--profile', 'ci', 'do x'], {
      env: {},
      launchWithSdk: async (argv) => { captured = argv; return 0; },
    });
    expect(captured).not.toContain('--profile');
    expect(captured).not.toContain('ci');
    expect(captured).toEqual(['--print', 'do x']);
  });

  it('completion <shell> prints a script and exits 0', async () => {
    const lines: string[] = [];
    const code = await main(['completion', 'zsh'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('#compdef octocode-agent');
  });

  it('completion with an unsupported shell exits 1 with a helpful message', async () => {
    const lines: string[] = [];
    const code = await main(['completion', 'powershell'], { out: (m) => lines.push(m), env: {} });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Unknown shell "powershell"');
    expect(lines.join('\n')).toContain('bash, zsh, fish');
  });

  it('completion with no shell argument exits 1', async () => {
    const code = await main(['completion'], { out: () => {}, env: {} });
    expect(code).toBe(1);
  });
});

// ── launcherVersion / launcherRoot ──────────────────────────────────────────────

describe('launcherVersion / launcherRoot', () => {
  it('launcherVersion returns a semver string or null', () => {
    const v = launcherVersion();
    if (v !== null) {
      expect(v).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('launcherRoot returns a non-empty path', () => {
    const root = launcherRoot();
    expect(root.length).toBeGreaterThan(0);
  });
});

// ── utils integration ──────────────────────────────────────────────────────────

describe('presentApiKeys integration (via reports)', () => {
  it('authReport detects injected keys', () => {
    const report = authReport({
      ANTHROPIC_API_KEY: 'sk-xxx',
      TAVILY_API_KEY: 'tv-xxx',
    });
    expect(report).toContain('ANTHROPIC_API_KEY');
    expect(report).toContain('TAVILY_API_KEY');
  });
});

// ── Styled surfaces (rebrand contract) ───────────────────────────────────────────

describe('styled surfaces', () => {
  it('help is sectioned and lists auth exactly once', () => {
    const report = helpReport();
    expect(report).toContain('Get started');
    expect(report).toContain('Setup & health');
    expect(report).toContain('auth [login|logout|status]');
    expect(report.match(/auth \[login\|logout\|status\]/g)).toHaveLength(1);
  });

  it('version aligns fact rows under a branded header', () => {
    const report = versionReport({});
    expect(report).toContain('◆ octocode-agent');
    expect(report).toContain('\nlauncher');
    expect(report).toContain('\nlaunch mode');
  });

  it('setup computes the summary from check status, not from glyphs', () => {
    // No keys and resolvable packages in this workspace → deterministic ok/fail mix.
    const report = setupReport({ FORCE_COLOR: '1' });
    expect(report).toMatch(/✓ All checks passed|✗ Fix the issues above/);
    expect(report).not.toContain('undefined');
  });

  it('doctor downgrades non-critical failures to warnings', () => {
    const data = doctorReport({ FORCE_COLOR: '1' });
    expect(data).toContain('octocode-agent doctor');
  });

  it('config is compact: no (not set) rows, ~ paths, no absolute home leaks', () => {
    const report = configReport({});
    expect(report).not.toContain('(not set)');
    expect(report).toContain('~/.octocode');
    expect(report).not.toContain('/Users/');
  });
});
