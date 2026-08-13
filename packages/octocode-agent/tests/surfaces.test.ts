import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSurfaceSpec,
  resolveAwarenessCli,
  loadProfile,
  profileToPiArgs,
} from '../src/surfaces.js';

const selfPath = fileURLToPath(import.meta.url); // an existing file to stand in for a CLI

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

describe('buildSurfaceSpec — bundled awareness CLI', () => {
  it('memory prefixes the memory noun when the CLI resolves', () => {
    const spec = buildSurfaceSpec('memory', ['recall', 'x'], { OCTOCODE_AWARENESS_CLI: selfPath });
    expect(spec).toEqual({ cmd: 'node', args: [selfPath, 'memory', 'recall', 'x'] });
  });
  it('awareness passes through raw when the CLI resolves', () => {
    const spec = buildSurfaceSpec('awareness', ['attend'], { OCTOCODE_AWARENESS_CLI: selfPath });
    expect(spec).toEqual({ cmd: 'node', args: [selfPath, 'attend'] });
  });
});

describe('resolveAwarenessCli', () => {
  it('prefers an existing OCTOCODE_AWARENESS_CLI env path', () => {
    expect(resolveAwarenessCli({ OCTOCODE_AWARENESS_CLI: selfPath })).toBe(selfPath);
  });
  it('ignores a non-existent env path', () => {
    expect(resolveAwarenessCli({ OCTOCODE_AWARENESS_CLI: '/no/such/file.js' })).not.toBe(
      '/no/such/file.js',
    );
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
      JSON.stringify({ ci: { model: 'anthropic/claude-sonnet-4-5', excludeTools: 'spawnAgent', approve: 'always' } }),
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
