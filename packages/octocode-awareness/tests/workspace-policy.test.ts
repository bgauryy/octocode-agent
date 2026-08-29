import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { selectCommand } from '../bin/cli-routing.js';
import {
  DEFAULT_WORKSPACE_POLICY,
  hookCommandEnabled,
  loadWorkspacePolicy,
  storageScopeForCommand,
  workspacePolicyPath,
  writeWorkspacePolicy,
} from '../src/workspace-policy.js';

describe('workspace Awareness policy', () => {
  it('defaults repository state to the repository, memory to global, and hooks to coordination', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'awareness-policy-'));
    try {
      expect(loadWorkspacePolicy(workspace)).toEqual({
        path: workspacePolicyPath(workspace),
        exists: false,
        policy: DEFAULT_WORKSPACE_POLICY,
      });
      expect(storageScopeForCommand('work-command', workspace)).toBe('repo');
      expect(storageScopeForCommand('tell-memory', workspace)).toBe('global');
      expect(storageScopeForCommand('work-command', workspace, 'global')).toBe('global');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('persists and reloads explicit repository policy', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'awareness-policy-'));
    try {
      const policy = {
        version: 1 as const,
        storage: { repository: 'global' as const, memory: 'repo' as const },
        hooks: { profile: 'full' as const },
      };
      expect(writeWorkspacePolicy(workspace, policy)).toBe(workspacePolicyPath(workspace));
      expect(loadWorkspacePolicy(workspace)).toEqual({
        path: workspacePolicyPath(workspace),
        exists: true,
        policy,
      });
      expect(storageScopeForCommand('work-command', workspace)).toBe('global');
      expect(storageScopeForCommand('tell-memory', workspace)).toBe('repo');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('maps hook profiles to the minimum required lifecycle surface', () => {
    expect(hookCommandEnabled('guard', 'pre-edit')).toBe(true);
    expect(hookCommandEnabled('guard', 'post-edit')).toBe(true);
    expect(hookCommandEnabled('guard', 'stop-verify')).toBe(true);
    expect(hookCommandEnabled('guard', 'notify-deliver')).toBe(false);
    expect(hookCommandEnabled('coordination', 'notify-deliver')).toBe(false);
    expect(hookCommandEnabled('full', 'notify-deliver')).toBe(true);
    expect(hookCommandEnabled('full', 'session-end')).toBe(true);
  });
});

describe('unified CLI facade', () => {
  it('routes the small user-facing vocabulary to existing command owners', () => {
    expect(selectCommand(['next'])).toEqual({ command: 'attend', rest: ['--compact'] });
    expect(selectCommand(['inspect', 'workboard'])).toEqual({
      command: 'query',
      rest: ['--view', 'workboard', '--compact'],
    });
    expect(selectCommand(['verify'])).toEqual({ command: 'audit-unverified', rest: ['--compact'] });
    expect(selectCommand(['verify', '--workspace', '/repo'])).toEqual({
      command: 'audit-unverified',
      rest: ['--workspace', '/repo', '--compact'],
    });
    expect(selectCommand(['close', '--run-id', 'run-1'])).toEqual({
      command: 'work-command',
      rest: ['--action', 'end', '--run-id', 'run-1', '--compact'],
    });
    expect(selectCommand(['setup'])).toEqual({ command: 'workspace-policy', rest: [] });
  });
});
