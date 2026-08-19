/**
 * Tests for the programmatic worker seams in agent-tools.ts:
 * - registerWorkerLedgerListener: subscribe/unsubscribe, event delivery, throwing-listener isolation.
 * - steerWorkerById / killWorkerById / getWorkerTranscript: reuse of the AgentMessage
 *   and /octocode-agents code paths, unknown-id handling.
 */
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'vitest';
import {
  spawnRpcAgent,
  setAgentProcessFactoryForTests,
  isSubagentProcess,
  registerWorkerLedgerListener,
  steerWorkerById,
  killWorkerById,
  getWorkerTranscript,
} from '../src/tools/agent-tools.js';
import type { WorkerLedgerEntry, WorkerLedgerEventType } from '../src/types.js';

// ─── Mock process factory (records stdin writes so RPC types are assertable) ──

type MockHandlers = Record<string, Array<(...args: unknown[]) => void>>;

interface MockProcess {
  stdin: { write(d: string): void; end(): void };
  stdout: { on(e: string, cb: (b: Buffer) => void): void };
  stderr: { on(e: string, cb: (b: Buffer) => void): void };
  on(e: string, cb: (...a: unknown[]) => void): void;
  kill(): boolean;
  exitCode: null | number;
  signalCode: null | string;
  writes: Array<Record<string, unknown>>;
  _emit(event: string, ...args: unknown[]): void;
}

function makeMockProcess(): MockProcess {
  const handlers: MockHandlers = {};
  const proc: MockProcess = {
    writes: [],
    stdin: {
      write(d: string) {
        proc.writes.push(JSON.parse(d) as Record<string, unknown>);
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
  return proc;
}

/** Drive the worker to 'idle' via a normal agent_end RPC event. */
function emitAgentEnd(mock: MockProcess): void {
  mock._emit('stdout:data', Buffer.from(`${JSON.stringify({ type: 'agent_end', messages: [] })}\n`));
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // Each test starts with a fresh empty agent registry
  setAgentProcessFactoryForTests(null);
});

afterEach(() => {
  setAgentProcessFactoryForTests(null);
});

// ─── registerWorkerLedgerListener ─────────────────────────────────────────────

test('ledger listener receives entries and event types for worker transitions', () => {
  if (isSubagentProcess()) return;

  const seen: Array<{ type: WorkerLedgerEventType; entry: WorkerLedgerEntry }> = [];
  const unsubscribe = registerWorkerLedgerListener((entry, type) => {
    seen.push({ type, entry });
  });
  try {
    const mock = makeMockProcess();
    setAgentProcessFactoryForTests(() => mock as never);
    const record = spawnRpcAgent({ task: 'listen to me', resourceMode: 'lean' });

    const types = seen.map((s) => s.type);
    assert.ok(types.includes('spawned'), `expected a 'spawned' event; got ${types.join(',')}`);
    assert.ok(types.includes('message'), `expected a 'message' event for the initial prompt; got ${types.join(',')}`);
    const initialMessage = seen.find((s) => s.type === 'message')?.entry.recentEvents.at(-1)?.message;
    assert.equal(initialMessage, 'initial prompt sent');
    assert.ok(seen.every((s) => s.entry.agentId === record.id), 'every entry carries the worker agentId');
    assert.equal(seen[0]!.entry.name, record.name);
  } finally {
    unsubscribe();
  }
});

test('ledger listener sees normalized-status flips (handback) via pushLedgerEvent', () => {
  if (isSubagentProcess()) return;

  const seen: Array<{ type: WorkerLedgerEventType; normalizedStatus?: string }> = [];
  const unsubscribe = registerWorkerLedgerListener((entry, type) => {
    seen.push({ type, normalizedStatus: entry.normalizedStatus });
  });
  try {
    const mock = makeMockProcess();
    setAgentProcessFactoryForTests(() => mock as never);
    spawnRpcAgent({ task: 'flip status', resourceMode: 'lean' });

    mock._emit('stdout:data', Buffer.from(`${JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '[DONE] finished the thing' }] },
    })}\n`));

    const handback = seen.find((s) => s.type === 'handback');
    assert.ok(handback, 'normalized-status flip must emit a handback ledger event to listeners');
  } finally {
    unsubscribe();
  }
});

test('unsubscribed ledger listener stops receiving events', () => {
  if (isSubagentProcess()) return;

  let calls = 0;
  const unsubscribe = registerWorkerLedgerListener(() => {
    calls += 1;
  });
  unsubscribe();

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  spawnRpcAgent({ task: 'nobody listening', resourceMode: 'lean' });

  assert.equal(calls, 0, 'unsubscribed listener must not be invoked');
});

test('a throwing ledger listener never breaks pushLedgerEvent or other listeners', () => {
  if (isSubagentProcess()) return;

  const seen: WorkerLedgerEventType[] = [];
  const unsubThrowing = registerWorkerLedgerListener(() => {
    throw new Error('listener boom');
  });
  const unsubGood = registerWorkerLedgerListener((_entry, type) => {
    seen.push(type);
  });
  try {
    const mock = makeMockProcess();
    setAgentProcessFactoryForTests(() => mock as never);
    const record = spawnRpcAgent({ task: 'resilient ledger', resourceMode: 'lean' });

    // The ledger itself must still record events despite the throwing listener…
    assert.ok(record.ledgerEvents.length > 0, 'ledger events recorded despite throwing listener');
    // …and well-behaved listeners must still be invoked.
    assert.ok(seen.includes('spawned'), 'other listeners still receive events');
  } finally {
    unsubThrowing();
    unsubGood();
  }
});

// ─── steerWorkerById ──────────────────────────────────────────────────────────

test('steerWorkerById sends a steer RPC to a running worker', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'busy work', resourceMode: 'lean' });
  assert.equal(record.status, 'running');

  assert.equal(steerWorkerById(record.id, 'change course'), true);
  const steer = mock.writes.find((w) => w['type'] === 'steer');
  assert.ok(steer, 'a steer RPC must be written to worker stdin');
  assert.equal(steer!['message'], 'change course');
  assert.equal(record.ledgerEvents.at(-1)?.message, 'steer sent: change course');
});

test('steerWorkerById queues via follow_up when the worker is idle', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'quick task', resourceMode: 'lean' });
  emitAgentEnd(mock);
  assert.equal(record.status, 'idle');

  assert.equal(steerWorkerById(record.id.slice(0, 8), 'next task please'), true);
  const followUp = mock.writes.find((w) => w['type'] === 'follow_up');
  assert.ok(followUp, 'idle worker must receive follow_up, not steer');
  assert.equal(followUp!['message'], 'next task please');
  assert.equal(mock.writes.find((w) => w['type'] === 'steer'), undefined);
  assert.equal(record.status, 'running', 'follow_up starts the next turn');
  assert.equal(record.ledgerEvents.at(-1)?.message, 'follow-up queued: next task please');
});

test('steerWorkerById returns false for unknown ids and empty messages', () => {
  if (isSubagentProcess()) return;

  assert.equal(steerWorkerById('no-such-agent', 'hello'), false);

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'still here', resourceMode: 'lean' });
  assert.equal(steerWorkerById(record.id, '   '), false, 'blank message is rejected');
});

test('steerWorkerById returns false when the worker process is dead', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'dies early', resourceMode: 'lean' });
  mock.exitCode = 0;
  mock._emit('close', 0, null);

  assert.equal(steerWorkerById(record.id, 'anyone home?'), false);
});

// ─── killWorkerById ───────────────────────────────────────────────────────────

test('killWorkerById kills a live worker by prefix and returns true', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'doomed worker', resourceMode: 'lean' });

  assert.equal(killWorkerById(record.id.slice(0, 8)), true);
  assert.equal(record.status, 'killed');
  assert.ok(record.ledgerEvents.some((e) => e.type === 'killed'));
});

test('killWorkerById returns false for unknown ids', () => {
  if (isSubagentProcess()) return;
  assert.equal(killWorkerById('does-not-exist'), false);
});

// ─── getWorkerTranscript ──────────────────────────────────────────────────────

test('getWorkerTranscript renders the single-agent status view', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'talkative', name: 'transcripty', resourceMode: 'lean' });
  mock._emit('stdout:data', Buffer.from(`${JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '[STATUS] deep in thought' }] },
  })}\n`));

  const transcript = getWorkerTranscript(record.id)!;
  assert.match(transcript, /transcripty/);
  assert.match(transcript, /agentId: /);
  assert.match(transcript, /deep in thought/);
});

test('getWorkerTranscript caps to the last maxLines lines', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess();
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'chatty', resourceMode: 'lean' });
  const output = Array.from({ length: 20 }, (_v, i) => `line ${i + 1}`).join('\n');
  mock._emit('stdout:data', Buffer.from(`${JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: output }] },
  })}\n`));

  const full = getWorkerTranscript(record.id)!;
  const capped = getWorkerTranscript(record.id, { maxLines: 5 })!;
  assert.ok(full.split('\n').length > 5);
  assert.equal(capped.split('\n').length, 5);
  assert.match(capped, /line 20$/, 'keeps the freshest (last) lines');
});

test('getWorkerTranscript returns undefined for unknown ids', () => {
  if (isSubagentProcess()) return;
  assert.equal(getWorkerTranscript('missing-id'), undefined);
});
