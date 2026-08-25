import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSurfaceSpec,
  loadProfile,
  profileToPiArgs,
} from '../src/surfaces.js';
import { getAwarenessCLIPath, resolveAwarenessLiteCliPath } from '../src/assets.js';

const selfPath = fileURLToPath(import.meta.url);

function expectCommand(spec: ReturnType<typeof buildSurfaceSpec>): { cmd: string; args: string[] } {
  if ('error' in spec) throw new Error(spec.error);
  return spec;
}

describe('buildSurfaceSpec — external octocode CLI', () => {
  it('research maps to `npx octocode search`', () => {
    expect(buildSurfaceSpec('research', ['auth flow'])).toEqual({
      cmd: 'npx',
      args: ['octocode', 'search', 'auth flow'],
    });
  });

  it('tools maps to `npx octocode tools`', () => {
    expect(buildSurfaceSpec('tools', ['--json'])).toEqual({
      cmd: 'npx',
      args: ['octocode', 'tools', '--json'],
    });
  });

  it('skills maps to `npx octocode skill`', () => {
    expect(buildSurfaceSpec('skills', ['--list'])).toEqual({
      cmd: 'npx',
      args: ['octocode', 'skill', '--list'],
    });
  });
});

describe('buildSurfaceSpec — installed awareness-lite CLI', () => {
  it('memory prefixes the memory noun through the local scoped package CLI', () => {
    const spec = expectCommand(buildSurfaceSpec('memory', ['recall', 'x'], { OCTOCODE_AWARENESS_CLI: selfPath }));
    expect(spec.cmd).toBe(process.execPath);
    expect(spec.args.at(-3)).toBe('memory');
    expect(spec.args.slice(-2)).toEqual(['recall', 'x']);
    expect(spec.args[0]).toBe(resolveAwarenessLiteCliPath());
  });

  it('awareness passes through raw args through the local scoped package CLI', () => {
    const spec = expectCommand(buildSurfaceSpec('awareness', ['status']));
    expect(spec.cmd).toBe(process.execPath);
    expect(spec.args.slice(-1)).toEqual(['status']);
    expect(spec.args[0]).toBe(resolveAwarenessLiteCliPath());
  });
});

describe('getAwarenessCLIPath', () => {
  it('returns the installed Awareness Lite command regardless of stale env file paths', () => {
    const prev = process.env.OCTOCODE_AWARENESS_CLI;
    try {
      process.env.OCTOCODE_AWARENESS_CLI = selfPath;
      expect(getAwarenessCLIPath()).toBe(`${process.execPath} ${resolveAwarenessLiteCliPath()}`);
      process.env.OCTOCODE_AWARENESS_CLI = '/no/such/file.js';
      expect(getAwarenessCLIPath()).toBe(`${process.execPath} ${resolveAwarenessLiteCliPath()}`);
    } finally {
      if (prev === undefined) delete process.env.OCTOCODE_AWARENESS_CLI;
      else process.env.OCTOCODE_AWARENESS_CLI = prev;
    }
  });
});

describe('profiles', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oca-prof-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loads a named profile and translates it to Pi flags', () => {
    fs.writeFileSync(
      path.join(home, 'profiles.json'),
      JSON.stringify({
        ci: {
          model: 'anthropic/claude-sonnet-4-5',
          excludeTools: 'spawnAgent',
          approve: 'always',
        },
      }),
    );
    const profile = loadProfile('ci', home);
    expect(profile).not.toBeNull();
    expect(profileToPiArgs(profile!)).toEqual([
      '--model',
      'anthropic/claude-sonnet-4-5',
      '--exclude-tools',
      'spawnAgent',
      '-a',
    ]);
  });

  it('returns null for a missing file or unknown profile', () => {
    expect(loadProfile('x', home)).toBeNull();
    fs.writeFileSync(path.join(home, 'profiles.json'), JSON.stringify({ fast: {} }));
    expect(loadProfile('missing', home)).toBeNull();
  });

  it('maps approve:never to -na', () => {
    expect(profileToPiArgs({ approve: 'never' })).toEqual(['-na']);
  });
});
