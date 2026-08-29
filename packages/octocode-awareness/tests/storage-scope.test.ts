import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDbPath } from '../src/coordination/coordination-shared.js';
import { runCli } from '../src/coordination/cli.js';
import { resolveDbPath } from '../src/db-runtime.js';
import { parseStorageScope, repoDatabasePath } from '../src/storage-scope.js';
import { extractGlobalDb } from '../bin/cli-routing.js';

const originalMemoryHome = process.env.OCTOCODE_MEMORY_HOME;

afterEach(() => {
  if (originalMemoryHome === undefined) delete process.env.OCTOCODE_MEMORY_HOME;
  else process.env.OCTOCODE_MEMORY_HOME = originalMemoryHome;
});

describe('Awareness storage scope', () => {
  it('resolves repository databases under the workspace .octocode directory', () => {
    const workspace = resolve('/tmp/awareness-workspace');
    expect(repoDatabasePath(workspace, 'octocode.sqlite3'))
      .toBe(join(workspace, '.octocode', 'octocode.sqlite3'));
    expect(defaultDbPath(workspace, 'repo'))
      .toBe(join(workspace, '.octocode', 'octocode.sqlite3'));
    expect(resolveDbPath(null, { scope: 'repo', workspace }))
      .toBe(join(workspace, '.octocode', 'awareness.sqlite3'));
  });

  it('keeps the existing global defaults and explicit path precedence', () => {
    const memoryHome = mkdtempSync(join(tmpdir(), 'awareness-memory-home-'));
    process.env.OCTOCODE_MEMORY_HOME = memoryHome;
    try {
      expect(resolveDbPath(null, { scope: 'global', workspace: '/tmp/repo' }))
        .toBe(join(memoryHome, 'awareness.sqlite3'));
      expect(resolveDbPath('./explicit.sqlite3', { scope: 'repo', workspace: '/tmp/repo' }))
        .toBe(resolve('./explicit.sqlite3'));
    } finally {
      rmSync(memoryHome, { recursive: true, force: true });
    }
  });

  it('validates CLI storage scope values', () => {
    expect(parseStorageScope(undefined)).toBe('global');
    expect(parseStorageScope('repo')).toBe('repo');
    expect(parseStorageScope('global')).toBe('global');
    expect(() => parseStorageScope('workspace')).toThrow('--db-scope must be repo or global');
  });

  it('extracts database scope before root command routing', () => {
    expect(extractGlobalDb(['--db-scope', 'repo', 'maintenance', 'init']))
      .toEqual({ dbPath: null, dbScope: 'repo', filtered: ['maintenance', 'init'] });
  });

  it('routes coordination CLI state to a repository database', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'awareness-repo-scope-'));
    let stdout = '';
    try {
      expect(runCli(
        ['status', '--workspace', workspace],
        { write: (chunk) => { stdout += chunk; } },
      )).toBe(0);
      const dbPath = join(workspace, '.octocode', 'octocode.sqlite3');
      expect(existsSync(dbPath)).toBe(true);
      expect(JSON.parse(stdout)).toMatchObject({ dbPath, workspace });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('lets an explicit database path override repository scope', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'awareness-explicit-scope-'));
    const dbPath = join(workspace, 'explicit.sqlite3');
    let stdout = '';
    try {
      expect(runCli(
        ['status', '--workspace', workspace, '--db-scope', 'repo', '--db', dbPath],
        { write: (chunk) => { stdout += chunk; } },
      )).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ dbPath });
      expect(existsSync(join(workspace, '.octocode', 'octocode.sqlite3'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps hook installation on the single root CLI surface', () => {
    expect(() => runCli(['hooks', 'install', '--host', 'codex']))
      .toThrow('hooks installation is owned by the root hooks install command');
  });
});
