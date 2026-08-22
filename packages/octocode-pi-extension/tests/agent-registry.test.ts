import { describe, expect, it } from 'vitest';
import { buildWorkerRegistryArgs, withPeerCoordination } from '../src/tools/agent-tools.js';

describe('buildWorkerRegistryArgs', () => {
  it('builds a join with role worker + name', () => {
    expect(buildWorkerRegistryArgs('join', { agentId: 'octo-lead:worker:abc123', name: 'Researcher', workspace: '/repo' }))
      .toEqual(['agent', 'join', '--agent-id', 'octo-lead:worker:abc123', '--workspace', '/repo', '--role', 'worker', '--name', 'Researcher']);
  });

  it('omits --name on join when absent, and never adds role/name on leave', () => {
    expect(buildWorkerRegistryArgs('join', { agentId: 'w1', workspace: '/repo' }))
      .toEqual(['agent', 'join', '--agent-id', 'w1', '--workspace', '/repo', '--role', 'worker']);
    expect(buildWorkerRegistryArgs('leave', { agentId: 'w1', name: 'X', workspace: '/repo' }))
      .toEqual(['agent', 'leave', '--agent-id', 'w1', '--workspace', '/repo']);
  });
});

describe('withPeerCoordination', () => {
  it('appends self id and peer ids, excluding self and blanks', () => {
    const out = withPeerCoordination('do work', 'me', ['me', 'peer-a', '', 'peer-b']);
    expect(out).toContain('do work');
    expect(out).toContain('your agent id: me');
    expect(out).toContain('peers: peer-a, peer-b');
    expect(out).toContain('message inbox --agent-id me');
  });

  it('appends parent id and durable handback file when provided', () => {
    const out = withPeerCoordination('do work', 'worker-1', [], {
      parentId: 'parent-1',
      handbackPath: '/repo/.octocode/tmp/agents/abc/handback.md',
    });
    expect(out).toContain('parent agent id: parent-1');
    expect(out).toContain('durable handback file: /repo/.octocode/tmp/agents/abc/handback.md');
    expect(out).toContain('[ARTIFACT] <path>');
  });

  it('notes no peers when only self is present', () => {
    const out = withPeerCoordination('do work', 'me', ['me']);
    expect(out).toContain('peers: none yet');
  });

  it('is a no-op when there is no self id', () => {
    expect(withPeerCoordination('do work', undefined, ['peer-a'])).toBe('do work');
  });
});
