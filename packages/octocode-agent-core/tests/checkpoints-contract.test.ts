import { describe, expect, it } from 'vitest';

import {
  assertCheckpointImageV1,
  assertCheckpointRecoveryV1,
  assertCheckpointTransitionV1,
} from '../src/contracts/checkpoints.js';
import { assertCheckpointEventV1 } from '../src/events/checkpoints.js';

const digest = 'a'.repeat(64);
const journalSha256 = 'b'.repeat(64);
const transition = {
  schemaVersion: 1,
  attemptId: 'checkpoint-1',
  checkpointId: 'checkpoint-1',
  attemptKind: 'mutation',
  operation: 'edit',
  path: 'src/index.ts',
  before: { kind: 'present', sha256: digest, bytes: 4, mode: 0o640 },
  after: { kind: 'present', sha256: 'c'.repeat(64), bytes: 5, mode: 0o640 },
  journalSha256,
} as const;

describe('checkpoint contracts', () => {
  it('strictly accepts immutable preimage, mode, postimage, and journal digests', () => {
    expect(assertCheckpointTransitionV1(transition)).toBe(transition);
    expect(assertCheckpointImageV1({ kind: 'absent' })).toEqual({ kind: 'absent' });
  });

  it.each([
    [{ ...transition, extra: true }, 'fields'],
    [{ ...transition, attemptId: 'other' }, 'attemptId'],
    [{ ...transition, before: { kind: 'absent', mode: 0o600 } }, 'image.absent'],
    [{ ...transition, before: { kind: 'present', sha256: digest, bytes: 4, mode: 0o10000 } }, 'image.mode'],
    [{ ...transition, operation: 'delete', after: transition.after }, 'transition.after'],
  ])('rejects malformed or semantically impossible transitions', (candidate, field) => {
    expect(() => assertCheckpointTransitionV1(candidate)).toThrow(field);
  });

  it('represents complete, partial, and uncertain recovery without authorizing replay', () => {
    for (const state of ['complete', 'partial'] as const) {
      const recovery = {
        schemaVersion: 1,
        attemptId: transition.attemptId,
        checkpointId: transition.checkpointId,
        attemptKind: transition.attemptKind,
        path: transition.path,
        state,
        current: state === 'complete' ? transition.after : transition.before,
        journalSha256,
      } as const;
      expect(assertCheckpointRecoveryV1(recovery)).toBe(recovery);
    }
    const uncertain = {
      schemaVersion: 1,
      attemptId: transition.attemptId,
      checkpointId: transition.checkpointId,
      attemptKind: transition.attemptKind,
      path: transition.path,
      state: 'uncertain',
      current: { kind: 'unknown' },
      journalSha256,
      reason: 'current file exceeds the bounded observation limit',
    } as const;
    expect(assertCheckpointRecoveryV1(uncertain)).toBe(uncertain);
    expect(() => assertCheckpointRecoveryV1({ ...uncertain, state: 'partial' })).toThrow('current');
    expect(() => assertCheckpointRecoveryV1({ ...uncertain, extra: true })).toThrow('fields');
  });

  it('strictly decodes standalone checkpoint lifecycle events', () => {
    expect(assertCheckpointEventV1({ schemaVersion: 1, type: 'checkpoint.prepared', transition })).toEqual({
      schemaVersion: 1,
      type: 'checkpoint.prepared',
      transition,
    });
    const rewind = { ...transition, attemptId: 'rewind-1', attemptKind: 'rewind', operation: 'rewind' } as const;
    expect(assertCheckpointEventV1({ schemaVersion: 1, type: 'rewind.prepared', transition: rewind })).toBeTruthy();
    expect(() => assertCheckpointEventV1({ schemaVersion: 1, type: 'checkpoint.prepared', transition: rewind })).toThrow(
      'attemptKind',
    );
  });

  it('keeps public lifecycle paths workspace-relative and rejects unsafe payload fields', () => {
    for (const unsafePath of [
      '/Users/example/secret.txt',
      'C:\\Users\\example\\secret.txt',
      '../secret.txt',
      'src/../../secret.txt',
      'src//index.ts',
    ]) {
      expect(() =>
        assertCheckpointEventV1({
          schemaVersion: 1,
          type: 'checkpoint.prepared',
          transition: { ...transition, path: unsafePath },
        }),
      ).toThrow('path');
    }
    expect(() =>
      assertCheckpointEventV1({
        schemaVersion: 1,
        type: 'checkpoint.prepared',
        transition,
        content: 'must never cross the event boundary',
      }),
    ).toThrow('fields');
  });
});
