import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execCli } from '../../src/lite/cli.js';

const workspaces: string[] = [];

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), 'aw-lite-no-legacy-'));
  workspaces.push(value);
  return value;
}

afterEach(() => {
  for (const value of workspaces.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('Awareness Lite no-legacy contract', () => {
  it.each([
    [['awarenessPlan', 'list'], /unknown command: awarenessPlan/],
    [['verify', 'audit'], /unknown command: verify/],
    [['awarenessAgents', 'list'], /unknown command: awarenessAgents/],
    [['memory', 'delete', '--memory-id', 'missing'], /memory action must(?!.*delete)/],
    [['lock', 'wait', '--file', 'src/a.ts', '--wait-seconds', '1ms'], /unknown flag: --wait-seconds/],
    [['memory', 'recall', '--smart'], /unknown flag: --smart/],
  ] as const)('rejects removed form %j without forwarding', (args, errorPattern) => {
    const result = execCli([...args, '--workspace', workspace()]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(errorPattern);
  });

  it('does not export the obsolete Pi hook adapter', async () => {
    const api = await import('../../src/index.js');
    expect('wirePiAwarenessHooks' in api).toBe(false);
    expect('createPiAwarenessBridge' in api).toBe(false);
  });
});
