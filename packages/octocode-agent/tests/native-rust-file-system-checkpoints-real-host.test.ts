import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NativeRustFileSystemClient } from '../src/native-rust-file-system.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-checkpoint-real-host-'));
  roots.push(root);
  return root;
}

describe('Rust checkpoint journal real subprocess recovery', () => {
  const binary = path.resolve(
    import.meta.dirname,
    '../../octocode-agent-core-rust/target/debug/octocode-agent-fs',
  );

  it.skipIf(!fsSync.existsSync(binary))('recovers partial work after a process fault and complete work after restart', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'a.txt'), 'before');
    let child: ChildProcessWithoutNullStreams | undefined;
    const first = new NativeRustFileSystemClient({
      binaryPath: binary,
      workspace: root,
      spawn(binaryPath, args) {
        child = spawn(binaryPath, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
        return child;
      },
    });
    await first.ready();
    const prepared = await first.prepareCheckpointReplace(
      {
        checkpointId: 'fault-checkpoint-1',
        operation: 'edit',
        path: 'a.txt',
        content: 'after',
        expectedSha256: createHash('sha256').update('before').digest('hex'),
        maxBytes: 1024,
      },
      new AbortController().signal,
    );
    expect(prepared.after).toMatchObject({ kind: 'present', bytes: 5 });
    const closed = new Promise<void>((resolve) => child!.once('close', () => resolve()));
    child!.kill('SIGKILL');
    await closed;

    const restarted = new NativeRustFileSystemClient({ binaryPath: binary, workspace: root });
    try {
      await restarted.ready();
      await expect(
        restarted.recoverCheckpointAttempt('fault-checkpoint-1', 1024, new AbortController().signal),
      ).resolves.toMatchObject({ state: 'partial', current: { sha256: prepared.before.kind === 'present' ? prepared.before.sha256 : undefined } });
      const controller = new AbortController();
      controller.abort();
      await expect(
        restarted.applyCheckpointAttempt('fault-checkpoint-1', 1024, controller.signal),
      ).rejects.toMatchObject({ category: 'cancelled' });
      await expect(
        restarted.recoverCheckpointAttempt('fault-checkpoint-1', 1024, new AbortController().signal),
      ).resolves.toMatchObject({ state: 'partial' });
      await expect(
        restarted.applyCheckpointAttempt('fault-checkpoint-1', 1024, new AbortController().signal),
      ).resolves.toMatchObject({ state: 'complete' });
      expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('after');
    } finally {
      await restarted.close();
    }
  });
});
