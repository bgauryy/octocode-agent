import { vi } from 'vitest';

// Unit and contract tests must be hermetic even when the invoking shell enables
// a developer's live-integration flags. Live checks belong in explicit smoke
// commands, never in the default Vitest process.
for (const key of [
  'OCTOCODE_CHROME_DEBUG_E2E',
  'RUN_CHROME_LIVE',
  'RUN_MCP_LIVE',
]) {
  delete process.env[key];
}

function targetUrl(input: string | URL | Request): URL | undefined {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);
    return new URL(input.url);
  } catch {
    return undefined;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized.startsWith('127.');
}

const nativeFetch = globalThis.fetch.bind(globalThis);
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = targetUrl(input);
  if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !isLoopback(url.hostname)) {
    throw new Error(
      `[TEST_EXTERNAL_EFFECT_BLOCKED] outbound fetch to ${url.origin}; inject a fetch mock instead.`,
    );
  }
  return nativeFetch(input, init);
});

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const blockedExecutables = new Set([
    'chrome',
    'chromium',
    'chromium-browser',
    'google chrome',
    'google-chrome',
    'curl',
    'gh',
    'npm',
    'npx',
    'open',
    'pnpm',
    'start',
    'wget',
    'xdg-open',
    'yarn',
  ]);

  const executableName = (command: unknown): string => {
    const normalized = String(command ?? '').replaceAll('\\', '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return basename.replace(/\.exe$/i, '').toLowerCase();
  };

  const assertSafeExecutable = (command: unknown, args: unknown = []): void => {
    const executable = executableName(command);
    const argv = Array.isArray(args) ? args.map(String) : [];
    const windowsStart = executable === 'cmd'
      && argv.some((arg) => arg.toLowerCase() === 'start');
    if (blockedExecutables.has(executable) || windowsStart) {
      throw new Error(
        `[TEST_EXTERNAL_EFFECT_BLOCKED] attempted to launch ${String(command)}; inject a process/browser mock instead.`,
      );
    }
  };

  const spawn = ((command: unknown, ...args: unknown[]) => {
    assertSafeExecutable(command, args[0]);
    return (original.spawn as (...values: unknown[]) => unknown)(command, ...args);
  }) as typeof original.spawn;
  const spawnSync = ((command: unknown, ...args: unknown[]) => {
    assertSafeExecutable(command, args[0]);
    return (original.spawnSync as (...values: unknown[]) => unknown)(command, ...args);
  }) as typeof original.spawnSync;
  return {
    ...original,
    spawn,
    spawnSync,
  };
});
