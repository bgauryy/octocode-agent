import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionId, type ToolExecutionInput } from '@octocodeai/agent-core';

import {
  createNativeRewindTool,
  parseNativeCheckpointRecovery,
  parseNativeCheckpointTransition,
  type NativeCheckpointFileSystemPort,
} from '../src/native-checkpoints.js';
import { createNativeFileTool, type NativeFileSystemPort } from '../src/native-file-tool.js';

const roots: string[] = [];
const beforeSha = 'a'.repeat(64);
const afterSha = 'b'.repeat(64);
const journalSha256 = 'c'.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-native-checkpoint-'));
  roots.push(root);
  return root;
}

function request(input: unknown, cwd: string): ToolExecutionInput {
  const signal = new AbortController().signal;
  return {
    input,
    callId: 'rewind-call' as never,
    context: {
      sessionId: sessionId('rewind-session'),
      cwd,
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

const transition = {
  schemaVersion: 1,
  attemptId: 'checkpoint-1',
  checkpointId: 'checkpoint-1',
  attemptKind: 'mutation',
  operation: 'edit',
  path: 'a.txt',
  before: { kind: 'present', sha256: beforeSha, bytes: 6, mode: 0o640 },
  after: { kind: 'present', sha256: afterSha, bytes: 5, mode: 0o640 },
  journalSha256,
} as const;

describe('native checkpoint and rewind adapter', () => {
  it('strictly validates Rust transition and recovery payloads', () => {
    expect(parseNativeCheckpointTransition(transition)).toBe(transition);
    const recovery = {
      schemaVersion: 1,
      attemptId: transition.attemptId,
      checkpointId: transition.checkpointId,
      attemptKind: transition.attemptKind,
      path: transition.path,
      state: 'partial',
      current: transition.before,
      journalSha256,
    } as const;
    expect(parseNativeCheckpointRecovery(recovery)).toBe(recovery);
    expect(() => parseNativeCheckpointTransition({ ...transition, extra: true })).toThrow('fields');
    expect(() => parseNativeCheckpointRecovery({ ...recovery, state: 'uncertain' })).toThrow('reason');
  });

  it('runs rewind as its own destructive tool effect and emits prepared/completed receipts', async () => {
    const root = await workspace();
    const events: unknown[] = [];
    const rewindTransition = {
      ...transition,
      attemptId: 'rewind-derived',
      attemptKind: 'rewind',
      operation: 'rewind',
      before: transition.after,
      after: transition.before,
    } as const;
    const complete = {
      schemaVersion: 1,
      attemptId: rewindTransition.attemptId,
      checkpointId: transition.checkpointId,
      attemptKind: 'rewind',
      path: transition.path,
      state: 'complete',
      current: transition.before,
      journalSha256,
    } as const;
    const fileSystem: NativeCheckpointFileSystemPort = {
      supportsCheckpoints: () => true,
      prepareCheckpointReplace: vi.fn(),
      prepareCheckpointDelete: vi.fn(),
      prepareRewind: vi.fn(async () => rewindTransition),
      applyCheckpointAttempt: vi.fn(async () => complete),
      recoverCheckpointAttempt: vi.fn(),
    };
    const tool = createNativeRewindTool({
      workspace: root,
      fileSystem,
      onEvent: async (event) => {
        events.push(event);
      },
    });

    expect(tool.policy.effects).toEqual(expect.arrayContaining(['write', 'destructive']));
    expect(tool.policy.approval).toBe('always');
    const result = await tool.execute(
      request(
        {
          checkpointId: transition.checkpointId,
          path: transition.path,
          expectedPostimageSha256: transition.after.sha256,
        },
        root,
      ),
    );

    expect(fileSystem.prepareRewind).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: transition.checkpointId,
        path: transition.path,
        expectedPostimageSha256: transition.after.sha256,
      }),
      expect.any(AbortSignal),
    );
    expect(fileSystem.applyCheckpointAttempt).toHaveBeenCalledWith(
      rewindTransition.attemptId,
      1024 * 1024,
      expect.any(AbortSignal),
    );
    expect(events).toEqual([
      { schemaVersion: 1, type: 'rewind.prepared', transition: rewindTransition },
      { schemaVersion: 1, type: 'rewind.completed', recovery: complete },
    ]);
    expect(result.content).toMatchObject({ operation: 'rewind', state: 'complete', checkpointId: 'checkpoint-1' });
  });

  it('lets production file mutations opt into the Rust journal before apply', async () => {
    const root = await workspace();
    const baseline = {
      path: 'a.txt',
      content: 'before',
      validUtf8: true,
      bytes: 6,
      sha256: beforeSha,
    };
    const complete = {
      schemaVersion: 1,
      attemptId: transition.attemptId,
      checkpointId: transition.checkpointId,
      attemptKind: 'mutation',
      path: transition.path,
      state: 'complete',
      current: transition.after,
      journalSha256,
    } as const;
    const fileSystem: NativeFileSystemPort & NativeCheckpointFileSystemPort = {
      supportsCheckpoints: () => true,
      authorizeExternalPath: vi.fn(),
      readBinary: vi.fn(),
      snapshot: vi.fn(async () => baseline),
      replace: vi.fn(),
      delete: vi.fn(),
      prepareCheckpointReplace: vi.fn(async (input) => ({
        ...transition,
        attemptId: input.checkpointId,
        checkpointId: input.checkpointId,
        operation: input.operation,
      })),
      prepareCheckpointDelete: vi.fn(),
      prepareRewind: vi.fn(),
      applyCheckpointAttempt: vi.fn(async (attemptId) => ({
        ...complete,
        attemptId,
        checkpointId: attemptId,
      })),
      recoverCheckpointAttempt: vi.fn(),
    };
    const events: unknown[] = [];
    const tool = createNativeFileTool({
      workspace: root,
      fileSystem,
      checkpoints: {
        onEvent: async (event) => {
          events.push(event);
        },
      },
    });

    const result = await tool.execute(
      request(
        {
          operation: 'edit',
          path: 'a.txt',
          oldText: 'before',
          newText: 'after',
          expectedSha256: beforeSha,
        },
        root,
      ),
    );

    expect(fileSystem.prepareCheckpointReplace).toHaveBeenCalledBefore(
      fileSystem.applyCheckpointAttempt as ReturnType<typeof vi.fn>,
    );
    expect(fileSystem.replace).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        schemaVersion: 1,
        type: 'checkpoint.prepared',
        transition: expect.objectContaining({ attemptKind: 'mutation', operation: 'edit' }),
      },
      {
        schemaVersion: 1,
        type: 'checkpoint.recovered',
        recovery: expect.objectContaining({ attemptKind: 'mutation', state: 'complete' }),
      },
    ]);
    expect(result.content).toMatchObject({ operation: 'edit', checkpointId: expect.stringMatching(/^checkpoint-/u) });
  });

  it('fails closed when apply returns a recovery receipt for a different journal transition', async () => {
    const root = await workspace();
    const fileSystem: NativeFileSystemPort & NativeCheckpointFileSystemPort = {
      supportsCheckpoints: () => true,
      authorizeExternalPath: vi.fn(),
      readBinary: vi.fn(),
      snapshot: vi.fn(async () => ({
        path: 'a.txt', content: 'before', validUtf8: true, bytes: 6, sha256: beforeSha,
      })),
      replace: vi.fn(),
      delete: vi.fn(),
      prepareCheckpointReplace: vi.fn(async (input) => ({
        ...transition,
        attemptId: input.checkpointId,
        checkpointId: input.checkpointId,
        operation: input.operation,
      })),
      prepareCheckpointDelete: vi.fn(),
      prepareRewind: vi.fn(),
      applyCheckpointAttempt: vi.fn(async (attemptId) => ({
        schemaVersion: 1,
        attemptId,
        checkpointId: attemptId,
        attemptKind: 'mutation',
        path: 'different.txt',
        state: 'complete',
        current: transition.after,
        journalSha256,
      } as const)),
      recoverCheckpointAttempt: vi.fn(),
    };
    const tool = createNativeFileTool({ workspace: root, fileSystem, checkpoints: {} });

    await expect(tool.execute(request({
      operation: 'edit',
      path: 'a.txt',
      oldText: 'before',
      newText: 'after',
      expectedSha256: beforeSha,
    }, root))).rejects.toThrow(/recovery receipt.*transition/i);
  });
});
