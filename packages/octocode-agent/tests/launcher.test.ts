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
  LEAN_EXCLUDE_TOOLS,
  launcherRoot,
} from '../src/launcher.js';
import type { LaunchDeps, PiBinInfo } from '../src/types.js';

// ── Constants ──────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('CORE_SPEC is the npm: spec for pi -e flag', () => {
    expect(CORE_SPEC).toBe(`npm:${CORE_PACKAGE}`);
    expect(CORE_SPEC).toContain('@octocodeai/pi-extension');
  });

  it('LEAN_EXCLUDE_TOOLS contains grep, find, ls', () => {
    expect(LEAN_EXCLUDE_TOOLS).toContain('grep');
    expect(LEAN_EXCLUDE_TOOLS).toContain('find');
    expect(LEAN_EXCLUDE_TOOLS).toContain('ls');
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
    expect(parseInvocation(['config']).command).toBe('config');
    expect(parseInvocation(['setup']).command).toBe('setup');
    expect(parseInvocation(['auth']).command).toBe('auth');
    expect(parseInvocation(['models']).command).toBe('models');
    expect(parseInvocation(['sessions']).command).toBe('sessions');
  });

  it('forwards everything else to Pi', () => {
    const inv = parseInvocation(['--model', 'claude-opus-4-5', 'do something']);
    expect(inv.command).toBe('run');
    expect(inv.rest).toEqual(['--model', 'claude-opus-4-5', 'do something']);
  });

  it('routes new info subcommands (config/setup/auth/models/sessions)', () => {
    expect(parseInvocation(['config', '--json']).command).toBe('config');
    expect(parseInvocation(['setup']).command).toBe('setup');
    expect(parseInvocation(['auth']).command).toBe('auth');
    expect(parseInvocation(['models']).command).toBe('models');
    expect(parseInvocation(['sessions']).command).toBe('sessions');
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

  it('sets PI_CACHE_RETENTION=long by default; never overrides an explicit value', () => {
    const defaultEnv = buildLaunchEnv({});
    expect(defaultEnv.PI_CACHE_RETENTION).toBe('long');

    const explicitEnv = buildLaunchEnv({ PI_CACHE_RETENTION: 'short' });
    expect(explicitEnv.PI_CACHE_RETENTION).toBe('short');
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
  });
});

// ── configReport ───────────────────────────────────────────────────────────────

describe('configReport', () => {
  it('shows all key configuration fields', () => {
    const report = configReport({});
    expect(report).toContain('octocode home');
    expect(report).toContain('core');
    expect(report).toContain('pi host');
    expect(report).toContain('launcher version');
    expect(report).toContain('OCTOCODE_HOME');
    expect(report).toContain('OCTOCODE_LAUNCHER_MODE');
    expect(report).toContain('api keys set');
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

// ── modelsReport ───────────────────────────────────────────────────────────────

describe('modelsReport', () => {
  it('shows model names, flags, and thinking levels', () => {
    const report = modelsReport();
    expect(report).toContain('claude');
    expect(report).toContain('--model');
    expect(report).toContain('--thinking');
  });
});

// ── sessionsReport ─────────────────────────────────────────────────────────────

describe('sessionsReport', () => {
  it('shows session storage path and management commands', () => {
    const report = sessionsReport();
    expect(report).toContain('sessions');
    expect(report).toContain('--continue');
    expect(report).toContain('--no-session');
  });
});

// ── buildPiArgs ────────────────────────────────────────────────────────────────

describe('buildPiArgs', () => {
  it('default includes --no-extensions and lean exclude while keeping context files', () => {
    const args = buildPiArgs('npm:@octocodeai/pi-extension', [], {});
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--exclude-tools');
    expect(args).not.toContain('--no-context-files');
  });

  it('supports npm: spec (recovery core delivery)', () => {
    const args = buildPiArgs('npm:@octocodeai/pi-extension', [], {});
    expect(args).toContain('-e');
    expect(args).toContain('npm:@octocodeai/pi-extension');
  });

  it('OCTOCODE_AGENT_NO_CONTEXT_FILES=1 suppresses AGENTS.md loading', () => {
    const args = buildPiArgs('spec', [], { OCTOCODE_AGENT_NO_CONTEXT_FILES: '1' });
    expect(args).toContain('--no-context-files');
  });

  it('FULL_TOOLS opts out of lean; CLEAN additionally suppresses user skills and context', () => {
    const fullArgs = buildPiArgs('spec', [], { OCTOCODE_AGENT_FULL_TOOLS: '1' });
    expect(fullArgs).not.toContain('--exclude-tools');

    const cleanArgs = buildPiArgs('spec', [], { OCTOCODE_AGENT_CLEAN: '1' });
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
    expect(lines.join('\n')).toContain('--continue');
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
