import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNodeNativeProcessContainmentPort,
  sameNativeProcessContainment,
  type NativeProcessContainmentIdentity,
} from '../src/native-worker-containment.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function firstLine(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk.toString();
    const newline = pending.indexOf('\n');
    if (newline >= 0) return pending.slice(0, newline);
  }
  throw new Error('Contained process ended before producing a line');
}

describe('native process containment', () => {
  it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
    'launches a child and grandchild in one dedicated POSIX group and terminates the whole unit',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-containment-'));
      roots.push(root);
      const port = createNodeNativeProcessContainmentPort();
      const script = [
        "const { spawn } = require('node:child_process');",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(JSON.stringify({ grandchild: grandchild.pid }) + '\\n');",
        'setInterval(() => {}, 1000);',
      ].join('');
      const handle = port.spawn({
        command: process.execPath,
        args: ['-e', script],
        cwd: root,
        env: {},
        ownershipToken: 'owned-process-group',
        generation: 'generation-1',
      });
      const { grandchild } = JSON.parse(await firstLine(handle.stdout)) as { grandchild: number };

      expect(handle.identity).toMatchObject({
        kind: 'posix-process-group',
        generation: 'generation-1',
        processGroupId: handle.pid,
      });
      expect(port.enumerate(handle.identity)).toEqual(expect.arrayContaining([handle.pid, grandchild]));
      if (process.platform === 'linux') {
        expect(() => port.signal({ ...handle.identity, generation: 'stale-generation' }, 'SIGTERM')).toThrow(/identity/i);
        expect(port.enumerate(handle.identity)).toEqual(expect.arrayContaining([handle.pid, grandchild]));
      }

      port.signal(handle.identity, 'SIGTERM');
      const report = await port.wait(handle.identity, { timeoutMs: 2_000, pollMs: 10 });
      expect(report).toMatchObject({ state: 'exited', members: [] });
      await expect(handle.exit).resolves.toMatchObject({ signal: 'SIGTERM' });
      expect(() => port.signal(handle.identity, 'SIGTERM')).not.toThrow();
    },
  );

  it('fences stable containment identity by ownership generation', () => {
    const identity: NativeProcessContainmentIdentity = {
      schemaVersion: 1,
      kind: 'posix-process-group',
      pid: 4242,
      processGroupId: 4242,
      generation: 'generation-1',
      startToken: 'start',
      commandSha256: 'a'.repeat(64),
      ownershipTokenSha256: 'b'.repeat(64),
      verification: 'linux-proc',
    };
    expect(sameNativeProcessContainment(identity, identity)).toBe(true);
    expect(sameNativeProcessContainment(identity, { ...identity, generation: 'generation-2' })).toBe(false);
    expect(sameNativeProcessContainment(identity, { ...identity, processGroupId: 4343 })).toBe(false);
  });

  it('fails closed instead of claiming Windows Job Object support', () => {
    const port = createNodeNativeProcessContainmentPort({ platform: 'win32' });
    expect(port.supported).toBe(false);
    expect(() => port.spawn({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: fs.realpathSync(os.tmpdir()),
      env: {},
      ownershipToken: 'ownership-token',
      generation: 'generation-1',
    })).toThrow(/not supported/i);
  });
});
