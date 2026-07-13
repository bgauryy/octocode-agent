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

  it('--mode json sets json mode', () => {
    expect(parseSdkArgs(['--mode', 'json']).mode).toBe('json');
  });

  it('--mode with unknown value preserves default mode and puts flag in rest', () => {
    const r = parseSdkArgs(['--mode', 'unknown']);
    expect(r.mode).toBe('interactive');
    expect(r.rest).toContain('--mode');
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
} = {}): SdkDeps['importPiSdk'] {
  return async () => {
    const makeInteractiveMode = () =>
      class {
        run() {
          if (sessionThrows) throw new Error('session error');
          return Promise.resolve();
        }
      };

    const makePrintMode = () => async () => {};
    const makeRpcMode = () => async () => {};

    return {
      createAgentSessionRuntime: async (factory: unknown) => {
        if (runtimeShouldThrow) throw new Error('runtime failed');
        return factory;
      },
      createAgentSessionFromServices: async () => ({}),
      createAgentSessionServices: async () => ({ diagnostics: null }),
      getAgentDir: () => '/fake/agent',
      InteractiveMode: makeInteractiveMode(),
      runPrintMode: makePrintMode(),
      runRpcMode: makeRpcMode(),
      SessionManager: {
        create: () => ({}),
        inMemory: () => ({}),
        continueRecent: () => ({}),
        open: () => ({}),
      },
      SettingsManager: {
        create: () => ({ applyOverrides: () => {} }),
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

  it('returns 0 on successful print mode run', async () => {
    const result = await launchWithSdk(['-p', 'write a test'], {
      importPiSdk: buildMockSdk(),
      importExtensionFactory: noopExtensionFactory,
      env: {},
    } satisfies SdkDeps);
    expect(result).toBe(0);
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
});
