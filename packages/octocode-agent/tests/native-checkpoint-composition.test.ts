import { describe, expect, it, vi } from 'vitest';
import { sessionId, type ToolExecutionInput } from '@octocodeai/agent-core';

import { createDefaultOctocodeToolRegistry } from '../src/native-tools.js';
import type { NativeFileSystemPort } from '../src/native-file-tool.js';
import type { NativeCheckpointFileSystemPort } from '../src/native-checkpoints.js';

describe('native checkpoint production composition', () => {
  it('registers rewind only with the Rust checkpoint filesystem capability', async () => {
    const fileSystem: NativeFileSystemPort & NativeCheckpointFileSystemPort = {
      supportsCheckpoints: () => true,
      authorizeExternalPath: vi.fn(), readBinary: vi.fn(), snapshot: vi.fn(), replace: vi.fn(), delete: vi.fn(),
      prepareCheckpointReplace: vi.fn(), prepareCheckpointDelete: vi.fn(), prepareRewind: vi.fn(),
      applyCheckpointAttempt: vi.fn(), recoverCheckpointAttempt: vi.fn(),
    };
    const registry = await createDefaultOctocodeToolRegistry({
      cwd: process.cwd(),
      run: async () => JSON.stringify({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] }),
      allowedTools: new Set(['file', 'rewind']),
      file: { fileSystem },
    });
    expect(registry.list().map(({ name }) => name)).toEqual(['file', 'rewind']);
  });

  it('fails closed when rewind is explicitly delegated without checkpoint durability', async () => {
    const fileSystem: NativeFileSystemPort = {
      authorizeExternalPath: vi.fn(), readBinary: vi.fn(), snapshot: vi.fn(), replace: vi.fn(), delete: vi.fn(),
    };
    await expect(createDefaultOctocodeToolRegistry({
      cwd: process.cwd(),
      run: async () => JSON.stringify({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] }),
      allowedTools: new Set(['rewind']),
      file: { fileSystem },
    })).rejects.toThrow(/checkpoint filesystem/i);
  });

  it('forwards one ordered checkpoint event sink to the rewind tool', async () => {
    const before = { kind: 'present' as const, sha256: 'a'.repeat(64), bytes: 5, mode: 0o640 };
    const after = { kind: 'present' as const, sha256: 'b'.repeat(64), bytes: 4, mode: 0o640 };
    const transition = {
      schemaVersion: 1 as const,
      attemptId: 'rewind-1',
      checkpointId: 'checkpoint-1',
      attemptKind: 'rewind' as const,
      operation: 'rewind' as const,
      path: 'package.json',
      before,
      after,
      journalSha256: 'c'.repeat(64),
    };
    const recovery = {
      schemaVersion: 1 as const,
      attemptId: transition.attemptId,
      checkpointId: transition.checkpointId,
      attemptKind: transition.attemptKind,
      path: transition.path,
      state: 'complete' as const,
      current: after,
      journalSha256: transition.journalSha256,
    };
    const fileSystem: NativeFileSystemPort & NativeCheckpointFileSystemPort = {
      supportsCheckpoints: () => true,
      authorizeExternalPath: vi.fn(), readBinary: vi.fn(), snapshot: vi.fn(), replace: vi.fn(), delete: vi.fn(),
      prepareCheckpointReplace: vi.fn(), prepareCheckpointDelete: vi.fn(),
      prepareRewind: vi.fn(async () => transition),
      applyCheckpointAttempt: vi.fn(async () => recovery),
      recoverCheckpointAttempt: vi.fn(),
    };
    const events: unknown[] = [];
    const registry = await createDefaultOctocodeToolRegistry({
      cwd: process.cwd(),
      run: async () => JSON.stringify({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] }),
      allowedTools: new Set(['rewind']),
      file: { fileSystem, checkpoints: { onEvent: async (event) => { events.push(event); } } },
    });
    const signal = new AbortController().signal;
    const request: ToolExecutionInput = {
      input: { checkpointId: 'checkpoint-1', path: 'package.json', expectedPostimageSha256: before.sha256 },
      callId: 'rewind-call' as never,
      context: {
        sessionId: sessionId('session-1'), cwd: process.cwd(), mode: 'headless',
        trust: { workspace: 'trusted', managedOnly: false }, signal,
      },
      signal,
      update: vi.fn(async () => undefined),
    };

    await registry.get('rewind')!.execute(request);
    expect(events.map((event) => (event as { type: string }).type)).toEqual(['rewind.prepared', 'rewind.completed']);
  });
});
