import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectNativeCheckpointRuntimeEvent } from '../src/native-checkpoint-events.js';
import type { NativeCheckpointEvent } from '../src/native-checkpoints.js';

const workspace = path.resolve('/tmp/octocode-checkpoint-workspace');
const transition = {
  schemaVersion: 1,
  attemptId: 'checkpoint-1',
  checkpointId: 'checkpoint-1',
  attemptKind: 'mutation',
  operation: 'edit',
  path: path.join(workspace, 'src', 'index.ts'),
  before: { kind: 'present', sha256: 'a'.repeat(64), bytes: 4, mode: 0o640 },
  after: { kind: 'present', sha256: 'b'.repeat(64), bytes: 5, mode: 0o640 },
  journalSha256: 'c'.repeat(64),
} as const;

describe('native checkpoint runtime event projection', () => {
  it('canonicalizes paths without exposing the workspace root or file content', () => {
    const projected = projectNativeCheckpointRuntimeEvent(
      { schemaVersion: 1, type: 'checkpoint.prepared', transition },
      workspace,
    );

    expect(projected).toEqual({
      type: 'checkpoint.prepared',
      payload: {
        schemaVersion: 1,
        transition: { ...transition, path: 'src/index.ts' },
      },
    });
    expect(JSON.stringify(projected)).not.toContain(workspace);
    expect(JSON.stringify(projected)).not.toContain('source text');
  });

  it('redacts uncertain recovery reasons and rejects paths outside the workspace', () => {
    const recovery = {
      schemaVersion: 1,
      attemptId: transition.attemptId,
      checkpointId: transition.checkpointId,
      attemptKind: transition.attemptKind,
      path: transition.path,
      state: 'uncertain',
      current: { kind: 'unknown' },
      journalSha256: transition.journalSha256,
      reason: `failed while inspecting ${transition.path}: source text`,
    } as const;
    const projected = projectNativeCheckpointRuntimeEvent(
      { schemaVersion: 1, type: 'checkpoint.recovered', recovery },
      workspace,
    );
    expect(projected.payload).toMatchObject({
      recovery: {
        path: 'src/index.ts',
        reason: 'filesystem state could not be proven',
      },
    });
    expect(JSON.stringify(projected)).not.toContain(workspace);
    expect(JSON.stringify(projected)).not.toContain('source text');

    expect(() =>
      projectNativeCheckpointRuntimeEvent(
        {
          schemaVersion: 1,
          type: 'checkpoint.prepared',
          transition: { ...transition, path: path.resolve(workspace, '..', 'secret.ts') },
        },
        workspace,
      ),
    ).toThrow(/outside the workspace/i);
  });

  it('fails closed on extra event fields instead of persisting them', () => {
    expect(() =>
      projectNativeCheckpointRuntimeEvent(
        {
          schemaVersion: 1,
          type: 'checkpoint.prepared',
          transition,
          content: 'source text',
        } as unknown as NativeCheckpointEvent,
        workspace,
      ),
    ).toThrow(/checkpoint event/i);
  });
});
