import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  parseSdkArgs,
  resolveOctocodeHome,
  migrateAuthIfNeeded,
  launchWithSdk,
} from '../src/sdk-launcher.js';
import type { SdkDeps } from '../src/types.js';

// ── resolveOctocodeHome ────────────────────────────────────────────────────────

describe('resolveOctocodeHome', () => {
  it('returns OCTOCODE_AGENT_DIR when set', () => {
    expect(resolveOctocodeHome({ OCTOCODE_AGENT_DIR: '/agent/dir' })).toBe('/agent/dir');
  });

  it('returns OCTOCODE_HOME when set (no OCTOCODE_AGENT_DIR)', () => {
    expect(resolveOctocodeHome({ OCTOCODE_HOME: '/home/dir' })).toBe('/home/dir');
  });

  it('prefers OCTOCODE_AGENT_DIR over OCTOCODE_HOME', () => {
    expect(
      resolveOctocodeHome({ OCTOCODE_AGENT_DIR: '/agent', OCTOCODE_HOME: '/home' }),
    ).toBe('/agent');
  });

  it('defaults to ~/.octocode', () => {
    expect(resolveOctocodeHome({})).toBe(path.join(os.homedir(), '.octocode'));
  });
});

// ── migrateAuthIfNeeded ────────────────────────────────────────────────────────

describe('migrateAuthIfNeeded', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-agent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when dest auth.json already exists', () => {
    const dest = path.join(tmpDir, 'auth.json');
    fs.writeFileSync(dest, '{}');
    const srcPath = path.join(tmpDir, 'src-auth.json');
    fs.writeFileSync(srcPath, '{"token":"x"}');
    expect(migrateAuthIfNeeded(tmpDir, undefined, srcPath)).toBe(false);
  });

  it('returns false when source does not exist', () => {
    expect(
      migrateAuthIfNeeded(tmpDir, undefined, path.join(tmpDir, 'nonexistent-auth.json')),
    ).toBe(false);
  });

  it('copies auth.json when dest missing and source exists', () => {
    const srcPath = path.join(tmpDir, 'src-auth.json');
    fs.writeFileSync(srcPath, '{"token":"secret"}');

    const destDir = path.join(tmpDir, 'new-home');
    const result = migrateAuthIfNeeded(destDir, undefined, srcPath);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(destDir, 'auth.json'))).toBe(true);
  });
});

// ── parseSdkArgs ───────────────────────────────────────────────────────────────

describe('parseSdkArgs', () => {
  it('defaults to interactive mode with no args', () => {
    const r = parseSdkArgs([]);
    expect(r.mode).toBe('interactive');
    expect(r.continue).toBe(false);
    expect(r.noSession).toBe(false);
    expect(r.rest).toEqual([]);
  });

  it('-p / --print sets print mode', () => {
    expect(parseSdkArgs(['-p']).mode).toBe('print');
    expect(parseSdkArgs(['--print']).mode).toBe('print');
  });

  it('--mode rpc sets rpc mode', () => {
    expect(parseSdkArgs(['--mode', 'rpc']).mode).toBe('rpc');
  });

  it('--mode json alone resolves to print mode with json output format (matches upstream pi: appMode "json" still routes through runPrintMode)', () => {
    const r = parseSdkArgs(['--mode', 'json']);
    expect(r.mode).toBe('print');
    expect(r.outputFormat).toBe('json');
  });

  it('--mode text alone does not force print mode (matches upstream pi: only json/rpc are mode-forcing, text is just the default format)', () => {
    const r = parseSdkArgs(['--mode', 'text']);
    expect(r.mode).toBe('interactive');
    expect(r.outputFormat).toBe('text');
  });

  it('--mode with unknown value preserves default mode and puts flag in rest', () => {
    const r = parseSdkArgs(['--mode', 'unknown']);
    expect(r.mode).toBe('interactive');
    expect(r.rest).toContain('--mode');
  });

  it('-p --mode json composes: print mode with json output (regression — previously --mode json silently overwrote and discarded the -p print request, falling through to interactive mode and hanging on stdin)', () => {
    const r = parseSdkArgs(['-p', '--mode', 'json']);
    expect(r.mode).toBe('print');
    expect(r.outputFormat).toBe('json');
  });

  it('--mode json -p composes the same regardless of flag order', () => {
    const r = parseSdkArgs(['--mode', 'json', '-p']);
    expect(r.mode).toBe('print');
    expect(r.outputFormat).toBe('json');
  });

  it('--mode rpc wins over -p (rpc is a persistent mode, not a print output format)', () => {
    const r = parseSdkArgs(['-p', '--mode', 'rpc']);
    expect(r.mode).toBe('rpc');
  });

  it('plain -p defaults to text output format', () => {
    const r = parseSdkArgs(['-p']);
    expect(r.mode).toBe('print');
    expect(r.outputFormat).toBe('text');
  });

  it('interactive mode (no flags) defaults to text output format', () => {
    const r = parseSdkArgs([]);
    expect(r.outputFormat).toBe('text');
  });

  it('-c / --continue sets continue flag', () => {
    expect(parseSdkArgs(['-c']).continue).toBe(true);
    expect(parseSdkArgs(['--continue']).continue).toBe(true);
  });

  it('--no-session sets noSession flag', () => {
    expect(parseSdkArgs(['--no-session']).noSession).toBe(true);
  });

  it('--name / -n sets the session name', () => {
    expect(parseSdkArgs(['--name', 'my session']).name).toBe('my session');
    expect(parseSdkArgs(['-n', 'other']).name).toBe('other');
  });

  it('--session sets sessionPath', () => {
    expect(parseSdkArgs(['--session', '/path/to/session']).sessionPath).toBe(
      '/path/to/session',
    );
  });

  it('first bare positional arg becomes initialMessage in interactive mode', () => {
    expect(parseSdkArgs(['hello world']).initialMessage).toBe('hello world');
  });

  it('flags and bare args are combined correctly', () => {
    const r = parseSdkArgs(['-c', 'write tests']);
    expect(r.continue).toBe(true);
    expect(r.initialMessage).toBe('write tests');
  });

  it('unknown flags go to rest', () => {
    const r = parseSdkArgs(['--unknown-flag', 'value']);
    expect(r.rest).toContain('--unknown-flag');
  });

  it('only first bare positional sets initialMessage; subsequent go to rest', () => {
    const r = parseSdkArgs(['first', 'second', 'third']);
    expect(r.initialMessage).toBe('first');
    expect(r.rest).toContain('second');
    expect(r.rest).toContain('third');
  });
});

// ── launchWithSdk ──────────────────────────────────────────────────────────────

function buildMockSdk({
  runtimeShouldThrow = false,
  sessionThrows = false,
  onCreateServices,
  onApplyOverrides,
  onPrintMode,
  onInteractiveMode,
  settingsThrows = false,
  sessionSelectedThrows = false,
}: {
  runtimeShouldThrow?: boolean;
  sessionThrows?: boolean;
  onCreateServices?: (opts: unknown) => void;
  onApplyOverrides?: (overrides: unknown) => void;
  onPrintMode?: (opts: unknown) => void;
  onInteractiveMode?: (opts: unknown) => void;
  settingsThrows?: boolean;
  sessionSelectedThrows?: boolean;
} = {}): SdkDeps['importPiSdk'] {
  return async () => {
    let lastSettingsManager: { applyOverrides: (o: unknown) => void } | undefined;
    const makeInteractiveMode = () =>
      class {
        constructor(_runtime: unknown, opts: unknown) {
          onInteractiveMode?.(opts);
        }
        run() {
          if (sessionThrows) throw new Error('session error');
          return Promise.resolve();
        }
      };

    const makePrintMode = () => async (_runtime: unknown, opts: unknown) => {
      onPrintMode?.(opts);
    };
    const makeRpcMode = () => async () => {};

    return {
      createAgentSessionRuntime: async (factory: unknown, opts: Record<string, unknown>) => {
        if (runtimeShouldThrow) throw new Error('runtime failed');
        return (factory as (args: Record<string, unknown>) => Promise<unknown>)({
          cwd: '/fake/cwd',
          sessionManager: opts['sessionManager'],
          sessionStartEvent: {},
        });
      },
      createAgentSessionFromServices: async () => ({}),
      createAgentSessionServices: async (opts: unknown) => {
        onCreateServices?.(opts);
        // Mirror production: services.settingsManager is the SAME instance the
        // launcher created — exercising the post-creation override re-apply.
        return { diagnostics: null, settingsManager: lastSettingsManager };
      },
      getAgentDir: () => '/fake/agent',
      InteractiveMode: makeInteractiveMode(),
      runPrintMode: makePrintMode(),
      runRpcMode: makeRpcMode(),
      SessionManager: {
        create: () => ({}),
        // The primary (selected) methods throw when sessionSelectedThrows so the
        // launcher falls back to create() inside the catch block.
        inMemory: () => { if (sessionSelectedThrows) throw new Error('inMemory failed'); return {}; },
        continueRecent: () => { if (sessionSelectedThrows) throw new Error('continueRecent failed'); return {}; },
        open: () => { if (sessionSelectedThrows) throw new Error('open failed'); return {}; },
      },
      SettingsManager: {
        create: () => {
          if (settingsThrows) throw new Error('settings failed');
          lastSettingsManager = { applyOverrides: (o: unknown) => onApplyOverrides?.(o) };
          return lastSettingsManager;
        },
      },
      DefaultResourceLoader: class {
        reload() {
          return Promise.resolve();
        }
      },
    };
  };
}

const noopExtensionFactory: SdkDeps['importExtensionFactory'] = async () =>
  (_opts?: Record<string, unknown>) => ({});

describe('launchWithSdk', () => {
  it('forces quietStartup so only the octocode banner shows (never the pi header)', async () => {
    const overrides: unknown[] = [];
    await launchWithSdk([], {
      importPiSdk: buildMockSdk({ onApplyOverrides: (o) => overrides.push(o) }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    // Pi's setProjectTrusted()/reload() inside service creation REBUILDS
    // settings and wipes applyOverrides — the launcher must apply overrides
    // once before services and RE-APPLY after: expect exactly two identical
    // applications, both carrying quietStartup.
    expect(overrides).toHaveLength(2);
    for (const o of overrides) expect(o).toMatchObject({ quietStartup: true });
  });

  it('returns null when Pi SDK is unavailable', async () => {
    const result = await launchWithSdk([], {
      importPiSdk: async () => null,
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBeNull();
  });

  it('returns null when extension factory is unavailable', async () => {
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: async () => null,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBeNull();
  });

  it('returns null when runtime creation throws', async () => {
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ runtimeShouldThrow: true }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBeNull();
  });

  it('returns 0 on successful interactive run', async () => {
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('passes the Octocode extension factory into Pi service resource loading', async () => {
    const serviceOptions: unknown[] = [];
    const extensionFactory = { kind: 'octocode-extension' };
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ onCreateServices: (opts) => serviceOptions.push(opts) }),
      importExtensionFactory: async () => (opts?: Record<string, unknown>) => {
        expect(opts).toEqual({ promptMode: 'octocode-first' });
        return extensionFactory;
      },
      env: {},
    } satisfies SdkDeps);

    expect(result).toBe(0);
    expect(serviceOptions).toHaveLength(1);
    expect(serviceOptions[0]).toMatchObject({
      cwd: '/fake/cwd',
      agentDir: '/fake/agent',
      resourceLoaderOptions: {
        extensionFactories: [extensionFactory],
      },
    });
  });

  it('passes noExtensions: true so a discovered @octocodeai/pi-extension package does not double-load the inline factory', async () => {
    const serviceOptions: unknown[] = [];
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ onCreateServices: (opts) => serviceOptions.push(opts) }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);

    expect(result).toBe(0);
    expect(serviceOptions).toHaveLength(1);
    expect(
      (serviceOptions[0] as { resourceLoaderOptions: Record<string, unknown> }).resourceLoaderOptions,
    ).toMatchObject({
      noExtensions: true,
      extensionFactories: expect.any(Array),
    });
  });

  it('returns 0 on successful print mode run', async () => {
    const result = await launchWithSdk(['-p', 'write a test'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('-p --mode json dispatches to print mode with json output — not interactive mode (regression for the SDK-embed hang: unrecognized "json" run-mode previously fell through to InteractiveMode, which blocks on stdin and never exits in non-interactive/piped invocations)', async () => {
    const printCalls: unknown[] = [];
    const interactiveCalls: unknown[] = [];
    const result = await launchWithSdk(['-p', '--mode', 'json', 'describe this file'], {
      importPiSdk: buildMockSdk({
        onPrintMode: (opts) => printCalls.push(opts),
        onInteractiveMode: (opts) => interactiveCalls.push(opts),
      }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);

    expect(result).toBe(0);
    expect(interactiveCalls).toHaveLength(0);
    expect(printCalls).toHaveLength(1);
    expect(printCalls[0]).toMatchObject({ mode: 'json' });
  });

  it('--mode json alone (no -p) also dispatches to print mode, not interactive — matches upstream pi appMode resolution', async () => {
    const printCalls: unknown[] = [];
    const interactiveCalls: unknown[] = [];
    const result = await launchWithSdk(['--mode', 'json', 'describe this file'], {
      importPiSdk: buildMockSdk({
        onPrintMode: (opts) => printCalls.push(opts),
        onInteractiveMode: (opts) => interactiveCalls.push(opts),
      }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);

    expect(result).toBe(0);
    expect(interactiveCalls).toHaveLength(0);
    expect(printCalls).toHaveLength(1);
    expect(printCalls[0]).toMatchObject({ mode: 'json' });
  });

  it('plain -p still dispatches print mode with text output (no regression on the common case)', async () => {
    const printCalls: unknown[] = [];
    const result = await launchWithSdk(['-p', 'hello'], {
      importPiSdk: buildMockSdk({ onPrintMode: (opts) => printCalls.push(opts) }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);

    expect(result).toBe(0);
    expect(printCalls).toHaveLength(1);
    expect(printCalls[0]).toMatchObject({ mode: 'text', initialMessage: 'hello' });
  });

  it('returns 0 on successful rpc mode run', async () => {
    const result = await launchWithSdk(['--mode', 'rpc'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('returns 1 when InteractiveMode.run throws', async () => {
    const logs: string[] = [];
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ sessionThrows: true }),
      importExtensionFactory: noopExtensionFactory,
      log: (m) => logs.push(m),
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(1);
    expect(logs.some((m) => m.includes('session error'))).toBe(true);
  });

  it('accepts --no-session flag', async () => {
    const result = await launchWithSdk(['--no-session'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('accepts --continue flag', async () => {
    const result = await launchWithSdk(['-c'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('accepts --session flag', async () => {
    const result = await launchWithSdk(['--session', '/path/to/session'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('uses the in-memory session manager for --no-session', async () => {
    const result = await launchWithSdk(['--no-session'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('uses continueRecent for --continue', async () => {
    const result = await launchWithSdk(['--continue'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('falls back to create() when the selected session method throws', async () => {
    const result = await launchWithSdk(['--no-session'], {
      importPiSdk: buildMockSdk({ sessionSelectedThrows: true }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('tolerates SettingsManager.create throwing (non-critical)', async () => {
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ settingsThrows: true }),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
  });

  it('mirrors PI_CACHE_RETENTION from deps.env into process.env', async () => {
    const prev = process.env.PI_CACHE_RETENTION;
    delete process.env.PI_CACHE_RETENTION;
    try {
      await launchWithSdk([], {
        importPiSdk: buildMockSdk(),
        importExtensionFactory: noopExtensionFactory,
        env: { PI_CACHE_RETENTION: 'long' },
      } satisfies SdkDeps);
      expect(process.env.PI_CACHE_RETENTION).toBe('long');
    } finally {
      if (prev === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = prev;
    }
  });

  it('mirrors PI_SKIP_VERSION_CHECK from deps.env into process.env (in-process version check reads it)', async () => {
    const prev = process.env.PI_SKIP_VERSION_CHECK;
    delete process.env.PI_SKIP_VERSION_CHECK;
    try {
      await launchWithSdk([], {
        importPiSdk: buildMockSdk(),
        importExtensionFactory: noopExtensionFactory,
        env: { PI_SKIP_VERSION_CHECK: '1' },
      } satisfies SdkDeps);
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe('1');
    } finally {
      if (prev === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = prev;
    }
  });
});

describe('OCTOCODE_SHELL', () => {
  it('runs createOctocodeShell and returns its exit code instead of InteractiveMode when OCTOCODE_SHELL=1', async () => {
    const shellCalls: unknown[] = [];
    const interactiveCalls: unknown[] = [];
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ onInteractiveMode: (o) => interactiveCalls.push(o) }),
      importExtensionFactory: noopExtensionFactory,
      createOctocodeShell: async (runtime: unknown) => {
        shellCalls.push(runtime);
        return { run: async () => 0 };
      },
      env: { OCTOCODE_SHELL: '1' },
    } satisfies SdkDeps);
    expect(result).toBe(0);
    expect(shellCalls).toHaveLength(1);
    expect(interactiveCalls).toHaveLength(0);
  });

  it('falls back to InteractiveMode when the shell factory throws', async () => {
    const logs: string[] = [];
    const interactiveCalls: unknown[] = [];
    const result = await launchWithSdk([], {
      importPiSdk: buildMockSdk({ onInteractiveMode: (o) => interactiveCalls.push(o) }),
      importExtensionFactory: noopExtensionFactory,
      createOctocodeShell: async () => {
        throw new Error('boom');
      },
      log: (m) => logs.push(m),
      env: { OCTOCODE_SHELL: '1' },
    } satisfies SdkDeps);
    expect(result).toBe(0);
    expect(interactiveCalls).toHaveLength(1);
    expect(logs.some((m) => m.includes('shell failed (boom); falling back to InteractiveMode'))).toBe(true);
  });

  it('ignores the shell flag in print mode', async () => {
    const shellCalls: unknown[] = [];
    const printCalls: unknown[] = [];
    const result = await launchWithSdk(['-p', 'hello'], {
      importPiSdk: buildMockSdk({ onPrintMode: (o) => printCalls.push(o) }),
      importExtensionFactory: noopExtensionFactory,
      createOctocodeShell: async (runtime: unknown) => {
        shellCalls.push(runtime);
        return { run: async () => 0 };
      },
      env: { OCTOCODE_SHELL: '1' },
    } satisfies SdkDeps);
    expect(result).toBe(0);
    expect(printCalls).toHaveLength(1);
    expect(shellCalls).toHaveLength(0);
  });
});
