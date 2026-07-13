/**
 * TDD tests for agent-tools.ts reliability fixes:
 * H4: sendRpc EPIPE must mark the agent as 'failed' and notify waiters immediately.
 * M7: Spawning more than MAX_AGENT_RECORDS active agents must throw a hard error.
 *
 * These tests are RED against the un-patched source because:
 * - H4: sendRpc currently swallows EPIPE without changing status or notifying waiters.
 * - M7: MAX_AGENT_RECORDS is not exported and no hard-cap guard exists.
 */
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'vitest';
import {
  spawnRpcAgent,
  setAgentProcessFactoryForTests,
  isSubagentProcess,
  MAX_AGENT_RECORDS,
} from '../src/tools/agent-tools.js';

// ─── Mock process factory ─────────────────────────────────────────────────────

type MockHandlers = Record<string, Array<(...args: unknown[]) => void>>;

interface MockProcess {
  stdin: { write(d: string): void; end(): void };
  stdout: { on(e: string, cb: (b: Buffer) => void): void };
  stderr: { on(e: string, cb: (b: Buffer) => void): void };
  on(e: string, cb: (...a: unknown[]) => void): void;
  kill(): boolean;
  exitCode: null | number;
  signalCode: null | string;
  _emit(event: string, ...args: unknown[]): void;
}

function makeMockProcess(opts: { stdinThrows?: boolean; exitImmediately?: boolean } = {}): MockProcess {
  const handlers: MockHandlers = {};

  const proc: MockProcess = {
    stdin: {
      write(d: string) {
        if (opts.stdinThrows) {
          const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
          throw err;
        }
        void d; // consume
      },
      end() {},
    },
    stdout: {
      on(e, cb) {
        (handlers[`stdout:${e}`] ??= []).push(cb as never);
      },
    },
    stderr: {
      on(e, cb) {
        (handlers[`stderr:${e}`] ??= []).push(cb as never);
      },
    },
    on(e, cb) {
      (handlers[e] ??= []).push(cb);
    },
    kill() {
      return true;
    },
    exitCode: null,
    signalCode: null,
    _emit(event, ...args) {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
  };

  if (opts.exitImmediately) {
    setTimeout(() => {
      proc.exitCode = 0;
      proc._emit('close', 0, null);
    }, 0);
  }

  return proc;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // Each test starts with a fresh empty agent registry
  setAgentProcessFactoryForTests(null);
});

afterEach(() => {
  // Restore the real factory so later tests are unaffected
  setAgentProcessFactoryForTests(null);
});

// ─── H4: EPIPE causes agent to be marked failed and waiters notified ──────────

test('H4: sendRpc EPIPE marks agent status as "failed"', () => {
  if (isSubagentProcess()) return; // skip inside RPC subprocess environments

  const mock = makeMockProcess({ stdinThrows: true });
  setAgentProcessFactoryForTests(() => mock as never);

  const record = spawnRpcAgent({ task: 'test task', resourceMode: 'lean' });

  // sendRpc is called synchronously inside spawnRpcAgent; EPIPE is thrown and caught.
  // The fix must transition the record to 'failed', not leave it in 'running'.
  assert.equal(record.status, 'failed', `Expected status 'failed' after EPIPE; got '${record.status}'`);
  assert.ok(record.error, 'record.error must be populated after EPIPE');
});

test('H4: waiters are resolved immediately when EPIPE transitions agent to failed', async () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess({ stdinThrows: true });
  setAgentProcessFactoryForTests(() => mock as never);

  const record = spawnRpcAgent({ task: 'test task', resourceMode: 'lean' });

  // Simulate what AgentMessage action:'wait' does: register a waiter if non-terminal,
  // resolve immediately if already terminal.
  const terminalStatuses = new Set(['idle', 'exited', 'failed', 'killed']);

  const raceResult = await Promise.race([
    new Promise<'resolved'>((resolve) => {
      if (terminalStatuses.has(record.status)) {
        resolve('resolved');
      } else {
        // Waiter would have been notified by notifyWaiters() inside the EPIPE catch.
        // Since the fix calls notifyWaiters synchronously, the Set should be empty by now.
        record.waiters.add(() => resolve('resolved'));
        // Nudge in case we missed the notification (shouldn't happen after fix)
        if (terminalStatuses.has(record.status)) resolve('resolved');
      }
    }),
    new Promise<'timed-out'>((res) => setTimeout(() => res('timed-out'), 500)),
  ]);

  assert.equal(raceResult, 'resolved', 'waiters must be notified; AgentMessage wait must not hang after EPIPE');
});

// ─── M7: Hard cap on active agents ────────────────────────────────────────────

test('M7: MAX_AGENT_RECORDS is exported and has the expected value', () => {
  assert.equal(typeof MAX_AGENT_RECORDS, 'number');
  assert.ok(MAX_AGENT_RECORDS > 0);
});

test('M7: spawning beyond MAX_AGENT_RECORDS non-droppable agents throws', function () {
  if (isSubagentProcess()) return;

  // Create a mock that keeps agents alive in 'running' state (non-droppable).
  const makePersistentMock = () => makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => makePersistentMock() as never);

  // Fill the registry to the limit — all agents remain 'running' (non-droppable).
  for (let i = 0; i < MAX_AGENT_RECORDS; i++) {
    spawnRpcAgent({ task: `slot ${i}`, resourceMode: 'lean' });
  }

  // The next spawn must throw a hard-cap error.
  assert.throws(
    () => spawnRpcAgent({ task: 'overflow', resourceMode: 'lean' }),
    /registry.*capacity|too many|at capacity/i,
    'Expected hard-cap error when non-droppable agents exceed MAX_AGENT_RECORDS',
  );
});
