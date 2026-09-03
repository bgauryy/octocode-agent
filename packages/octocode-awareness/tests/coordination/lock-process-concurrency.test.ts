import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openAwarenessStore } from '../../src/coordination/index.js';

const DIST_INDEX_URL = new URL('../../out/index.js', import.meta.url).href;

const ACQUIRE_LOCK = `
const [moduleUrl, workspace, dbPath, agentId, filePath] = process.argv.slice(1);
const { openAwareness } = await import(moduleUrl);
const store = openAwareness({ workspace, dbPath });
process.send({ type: 'ready', agentId });
process.once('message', () => {
  let result;
  try {
    const lock = store.acquireLock({ filePath, agentId, reason: 'concurrent regression', ttlSeconds: 60 });
    result = { type: 'result', outcome: 'success', agentId, owner: lock.agentId };
  } catch (error) {
    result = {
      type: 'result',
      outcome: 'conflict',
      agentId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  process.send(result, () => {
    store.close();
    process.disconnect();
  });
});
`;

interface ChildResult {
  outcome: 'success' | 'conflict';
  agentId: string;
  owner?: string;
  message?: string;
}

function lockProcess(workspace: string, dbPath: string, agentId: string, filePath: string) {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    ACQUIRE_LOCK,
    DIST_INDEX_URL,
    workspace,
    dbPath,
    agentId,
    filePath,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });

  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });

  let readyResolve!: () => void;
  let resultResolve!: (result: ChildResult) => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, rejectPromise) => {
    readyResolve = resolve;
    reject = rejectPromise;
  });
  const result = new Promise<ChildResult>((resolve) => { resultResolve = resolve; });
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`lock child ${agentId} exited ${code}: ${stderr}`));
    });
  });

  child.on('message', (message: { type?: string } & Partial<ChildResult>) => {
    if (message.type === 'ready') readyResolve();
    if (message.type === 'result' && message.outcome && message.agentId) {
      resultResolve({
        outcome: message.outcome,
        agentId: message.agentId,
        ...(message.owner === undefined ? {} : { owner: message.owner }),
        ...(message.message === undefined ? {} : { message: message.message }),
      });
    }
  });
  child.once('error', reject);

  return {
    child: child as ChildProcess,
    ready,
    result,
    closed,
  };
}

describe('coordination lock process concurrency', () => {
  it('atomically grants one owner and reports conflicts to every competing process', { timeout: 60_000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'aw-lock-process-race-'));
    const dbPath = join(workspace, 'awareness.sqlite3');
    const filePath = 'src/shared.ts';
    let contenders: ReturnType<typeof lockProcess>[] = [];

    try {
      const initialized = openAwarenessStore({ workspace, dbPath });
      initialized.close();

      contenders = Array.from({ length: 8 }, (_unused, index) => (
        lockProcess(workspace, dbPath, `agent-${index + 1}`, filePath)
      ));
      await Promise.all(contenders.map(({ ready }) => ready));
      for (const { child } of contenders) child.send('acquire');

      const results = await Promise.all(contenders.map(({ result }) => result));
      await Promise.all(contenders.map(({ closed }) => closed));
      const winners = results.filter(({ outcome }) => outcome === 'success');
      const losers = results.filter(({ outcome }) => outcome === 'conflict');

      expect(winners).toHaveLength(1);
      expect(new Set(winners.map(({ agentId }) => agentId))).toHaveLength(1);
      expect(losers).toHaveLength(contenders.length - 1);
      expect(losers.every(({ message }) => message?.includes('lock conflict'))).toBe(true);

      const stored = openAwarenessStore({ workspace, dbPath });
      try {
        expect(stored.listLocks()).toEqual([
          expect.objectContaining({ agentId: winners[0]!.agentId }),
        ]);
      } finally {
        stored.close();
      }
    } finally {
      for (const { child } of contenders) {
        if (!child.killed && child.exitCode === null) child.kill();
      }
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
