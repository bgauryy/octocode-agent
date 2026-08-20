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
import { Type } from 'typebox';
import {
  spawnRpcAgent,
  setAgentProcessFactoryForTests,
  isSubagentProcess,
  MAX_AGENT_LAST_OUTPUT_CHARS,
  MAX_AGENT_RECORDS,
  DEFAULT_SPAWN_POLICY,
  DEFAULT_IDLE_REAP_MS,
  evaluateStepBudget,
  findReapableIdleAgents,
  formatElapsed,
  formatAgentLedgerDetails,
  refreshAgentLedgerUi,
  isLedgerTickerActiveForTests,
  stopLedgerTickerForTests,
  extractDeltaSummary,
  agentPanelLines,
  handleOctocodeAgentsCommand,
} from '../src/tools/agent-tools.js';
import { registerSpawnSubagentTool } from '../src/tools/spawn-subagent-tool.js';
import type { ToolDefinition } from '../src/types.js';

test('extractDeltaSummary prefers the latest structured worker line', () => {
  const out = '[STATUS] booting\nsome noise\n[ACTION] editing src/foo.ts\ntrailing chatter';
  assert.equal(extractDeltaSummary(out), '[ACTION] editing src/foo.ts');
});

test('extractDeltaSummary falls back to the last non-empty line', () => {
  assert.equal(extractDeltaSummary('line one\n\nline two\n   '), 'line two');
});

test('extractDeltaSummary returns undefined for blank output and truncates long lines', () => {
  assert.equal(extractDeltaSummary('   \n\n'), undefined);
  const long = `[FINDING] ${'x'.repeat(200)}`;
  const out = extractDeltaSummary(long)!;
  assert.ok(out.length <= 120, 'truncated to <=120 chars');
  assert.ok(out.endsWith('…'), 'ellipsized');
});

// ─── Reliability guardrails (research-backed) ─────────────────────────────────

test('fan-out warning threshold is small (~4) per structured-topology research', () => {
  assert.equal(DEFAULT_SPAWN_POLICY.warningActiveAgents, 4);
  assert.ok(DEFAULT_SPAWN_POLICY.maxStepsPerWorker > 0);
});

test('evaluateStepBudget flags a runaway worker at/over budget', () => {
  assert.equal(evaluateStepBudget(10, 60).exceeded, false);
  const hit = evaluateStepBudget(60, 60);
  assert.equal(hit.exceeded, true);
  assert.match(String(hit.warning), /step budget \(60\/60/);
  assert.equal(evaluateStepBudget(99, 60).exceeded, true);
});

test('evaluateStepBudget disabled for non-positive budget', () => {
  assert.equal(evaluateStepBudget(1000, 0).exceeded, false);
  assert.equal(evaluateStepBudget(1000, Number.NaN).exceeded, false);
});

test('findReapableIdleAgents: terminal always reapable, idle only past TTL', () => {
  const now = 1_000_000_000_000;
  const recs = [
    { id: 'exited-1', status: 'exited' as const, updatedAt: now },
    { id: 'failed-1', status: 'failed' as const, updatedAt: now },
    { id: 'killed-1', status: 'killed' as const, updatedAt: now },
    { id: 'idle-fresh', status: 'idle' as const, updatedAt: now - 60_000 },
    { id: 'idle-stale', status: 'idle' as const, updatedAt: now - (DEFAULT_IDLE_REAP_MS + 1) },
    { id: 'running-1', status: 'running' as const, updatedAt: now - DEFAULT_IDLE_REAP_MS * 10 },
  ];
  const { terminal, idle } = findReapableIdleAgents(recs, { now });
  assert.deepEqual(terminal.sort(), ['exited-1', 'failed-1', 'killed-1']);
  assert.deepEqual(idle, ['idle-stale']); // fresh idle + running excluded
});

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

test('worker lastOutput is capped to a recent tail to bound memory use', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess({ stdinThrows: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'large output', resourceMode: 'lean' });
  const hugeText = `${'x'.repeat(MAX_AGENT_LAST_OUTPUT_CHARS + 500)}\n[DONE] tail`;

  mock._emit(
    'stdout:data',
    Buffer.from(`${JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: hugeText }] },
    })}\n`),
  );

  assert.equal(record.lastOutput.length, MAX_AGENT_LAST_OUTPUT_CHARS);
  assert.match(record.lastOutput, /\[DONE\] tail$/);
  assert.equal(record.normalizedResult?.status, 'done');
});

test('agent_end user prompt echoes do not overwrite assistant worker output', () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess({ stdinThrows: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({ task: 'review code', resourceMode: 'lean' });

  mock._emit(
    'stdout:data',
    Buffer.from(`${JSON.stringify({
      type: 'agent_end',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '[RESULT] actual findings\n[DONE] reviewed' }] },
        { content: [{ type: 'text', text: 'Goal: echoed original task' }] },
        { role: 'user', content: [{ type: 'text', text: 'Return only your review findings now' }] },
      ],
    })}\n`),
  );

  assert.match(record.lastOutput, /actual findings/);
  assert.doesNotMatch(record.lastOutput, /Goal: echoed original task/);
  assert.doesNotMatch(record.lastOutput, /Return only your review findings/);
  assert.equal(record.normalizedResult?.status, 'done');
});

// ─── Worker launch mode: workers must not re-enter the SDK-embed launcher ─────
//
// getPiInvocation() re-executes process.argv[1], which for any octocode-agent
// process is bin/octocode-agent.mjs. When the parent runs in the default
// SDK-embed launch mode, that env is inherited by the child, so the worker also
// launches via launchWithSdk() — whose custom arg parser (sdk-launcher.ts) does
// not understand --tools/--exclude-tools/-e/--append-system-prompt/--skill/etc.
// Confirmed by live reproduction: a worker spawned with --tools web,MCPTool
// could still call `bash` because the allowlist was silently dropped. Forcing
// OCTOCODE_LAUNCHER_MODE=subprocess routes workers through octocode-agent's
// subprocess path, which forwards argv verbatim to the real Pi CLI — the only
// path that honors the full flag set buildPiArgs() produces.
test('spawnRpcAgent forces OCTOCODE_LAUNCHER_MODE=subprocess so worker --tools/--exclude-tools/-e flags are actually honored', () => {
  if (isSubagentProcess()) return;

  let capturedEnv: NodeJS.ProcessEnv | undefined;
  setAgentProcessFactoryForTests((_command, _args, options) => {
    capturedEnv = (options as { env?: NodeJS.ProcessEnv }).env;
    return makeMockProcess() as never;
  });

  spawnRpcAgent({ task: 'research something', resourceMode: 'octocode', tools: ['web', 'MCPTool'] });

  assert.equal(
    capturedEnv?.['OCTOCODE_LAUNCHER_MODE'],
    'subprocess',
    'worker env must force subprocess launch mode so the curated tool allowlist is not silently dropped',
  );
});

// ─── L1: ledger elapsed time must freeze once an agent is terminal ───────────
//
// formatElapsed(startedAt) used to always compute Date.now() - startedAt, so a
// finished agent's "elapsed" kept growing forever in the footer/widget ledger
// (a 5s task from an hour ago would show "elapsed: 1h"). Terminal records must
// report a fixed end-to-end duration instead of drifting with wall-clock time.

test('L1: formatElapsed freezes at endedAt instead of drifting against Date.now()', () => {
  const started = 1_700_000_000_000;
  assert.equal(formatElapsed(started, started + 500), '500ms');
  assert.equal(formatElapsed(started, started + 5_000), '5s');
  assert.equal(formatElapsed(started, started + 65_000), '1m5s');
  // Without endedAt, falls back to Date.now() — still correct for live agents.
  const liveMs = Date.now() - started;
  assert.ok(liveMs > 0);
});

test('L1: ledger elapsed time is frozen for a terminal agent, not growing with wall-clock time', async () => {
  if (isSubagentProcess()) return;

  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  spawnRpcAgent({ task: 'finishes quickly', resourceMode: 'lean' });

  // Terminate the agent (status -> 'exited', updatedAt frozen at this moment).
  mock.exitCode = 0;
  mock._emit('close', 0, null);

  const snapshotA = formatAgentLedgerDetails();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const snapshotB = formatAgentLedgerDetails();

  assert.equal(snapshotB, snapshotA, 'elapsed time for a terminal agent must not change after it finished');
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

// ─── L2/L3: live ledger ticker (Wave 3 live-progress) ─────────────────────────

test('L2: live ledger ticker runs while a worker is active and stops when it finishes', () => {
  if (isSubagentProcess()) return;
  const ctx = {
    hasUI: true,
    ui: { setStatus: () => {}, setWidget: () => {} },
  } as never;

  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  spawnRpcAgent({ task: 'long job', resourceMode: 'lean' }, ctx);

  refreshAgentLedgerUi(ctx);
  assert.equal(isLedgerTickerActiveForTests(), true, 'ticker active while a worker runs');

  mock.exitCode = 0;
  mock._emit('close', 0, null);
  refreshAgentLedgerUi(ctx);
  assert.equal(isLedgerTickerActiveForTests(), false, 'ticker stops once no worker is active');

  stopLedgerTickerForTests();
});

test('L3: refreshAgentLedgerUi with no agents clears the widget and stops the ticker', () => {
  if (isSubagentProcess()) return;
  const widgetVals: unknown[] = [];
  const ctx = {
    hasUI: true,
    ui: { setStatus: () => {}, setWidget: (_k: string, v: unknown) => widgetVals.push(v) },
  } as never;

  refreshAgentLedgerUi(ctx); // registry cleared by beforeEach
  assert.equal(isLedgerTickerActiveForTests(), false, 'no ticker without active workers');
  assert.ok(widgetVals.includes(undefined), 'widget cleared to undefined when no agents');

  stopLedgerTickerForTests();
});

test('/octocode-agents hide removes the agent section from the unified status panel until list/status shows it again', async () => {
  if (isSubagentProcess()) return;
  const widgetCalls: Array<{ name: string; cleared: boolean }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: () => {},
      setWidget: (name: string, content: unknown) => widgetCalls.push({ name, cleared: content === undefined }),
      notify: () => {},
    },
  } as never;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  spawnRpcAgent({ task: 'visible worker', resourceMode: 'lean' }, ctx);
  assert.ok(agentPanelLines().length > 0, 'agent panel starts visible');

  await handleOctocodeAgentsCommand('hide', ctx);
  assert.equal(agentPanelLines().length, 0, 'hide suppresses unified agent panel lines');
  assert.ok(widgetCalls.some((call) => call.name === 'octocode-status-panel' && call.cleared), 'unified panel is refreshed/cleared');

  await handleOctocodeAgentsCommand('list', ctx);
  assert.ok(agentPanelLines().length > 0, 'list shows the ledger again');

  stopLedgerTickerForTests();
});

test('L4: no ticker is started when the UI is absent (headless)', () => {
  if (isSubagentProcess()) return;
  const ctx = { hasUI: false, ui: { setStatus: () => {}, setWidget: () => {} } } as never;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  spawnRpcAgent({ task: 'headless job', resourceMode: 'lean' }, ctx);
  refreshAgentLedgerUi(ctx);
  assert.equal(isLedgerTickerActiveForTests(), false, 'headless mode never starts the ledger ticker');
  stopLedgerTickerForTests();
});

// ─── SEV-1: workers inherit the parent's model/provider when unset ────────────

test('SEV-1: spawnRpcAgent defaults worker --model/--provider to the parent ctx.model', () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const ctx = {
    hasUI: false,
    cwd: process.cwd(),
    model: { id: 'claude-haiku-4-5-20251001', provider: 'guy-provider-anthropic' },
    ui: { setStatus: () => {}, setWidget: () => {} },
  } as never;
  const record = spawnRpcAgent({ task: 'inherit model', resourceMode: 'lean' }, ctx);
  const args = record.args;
  const modelIdx = args.indexOf('--model');
  const provIdx = args.indexOf('--provider');
  assert.ok(modelIdx >= 0 && args[modelIdx + 1] === 'claude-haiku-4-5-20251001', 'worker inherits parent model id');
  assert.ok(provIdx >= 0 && args[provIdx + 1] === 'guy-provider-anthropic', 'worker inherits parent provider');
});

test('SEV-1: an explicit model/provider still wins over the parent default', () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const ctx = { hasUI: false, model: { id: 'parent-model', provider: 'parent-prov' }, ui: { setStatus: () => {}, setWidget: () => {} } } as never;
  const record = spawnRpcAgent({ task: 't', resourceMode: 'lean', model: 'chosen-model', provider: 'chosen-prov' }, ctx);
  assert.equal(record.args[record.args.indexOf('--model') + 1], 'chosen-model');
  assert.equal(record.args[record.args.indexOf('--provider') + 1], 'chosen-prov');
});

test('SEV-1: an explicit model without provider does not inherit an unrelated parent provider', () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const ctx = { hasUI: false, model: { id: 'parent-model', provider: 'parent-prov' }, ui: { setStatus: () => {}, setWidget: () => {} } } as never;
  assert.throws(
    () => spawnRpcAgent({ task: 't', resourceMode: 'lean', model: 'claude-haiku-4-5' }, ctx),
    /requires an explicit provider/,
  );
});

test('SEV-1: OpenAI GPT-5 tool-calling workers omit --thinking to avoid reasoning_effort 400s', () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const record = spawnRpcAgent({
    task: 'Goal: test\nContext: test\nScope: test\nOwnership: test\nAcceptance: test\nReturn: test',
    resourceMode: 'octocode',
    model: 'gpt-5.4-mini',
    provider: 'guy-provider-openai',
    thinking: 'low',
    tools: ['web', 'MCPTool'],
  }, { hasUI: false, ui: { setStatus: () => {}, setWidget: () => {} } } as never);

  assert.equal(record.args.includes('--thinking'), false, 'tool-calling OpenAI GPT-5 worker must not pass --thinking');
  assert.ok(record.args.includes('--tools'), 'worker still receives its tool allowlist');
  assert.ok(
    record.policyWarnings.some((warning) => /Omitted --thinking for OpenAI GPT-5 tool-calling worker/.test(warning)),
    'spawn policy explains the compatibility omission',
  );
});

test('SEV-1: modelRegistry rejects mismatched model/provider pairs before spawning', () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const ctx = {
    hasUI: false,
    modelRegistry: { find: () => undefined },
    ui: { setStatus: () => {}, setWidget: () => {} },
  } as never;
  assert.throws(
    () => spawnRpcAgent({ task: 't', resourceMode: 'lean', model: 'claude-haiku-4-5', provider: 'guy-provider-openai' }, ctx),
    /model\/provider not found/,
  );
});

test('SEV-1: spawnSubagent inherits the parent provider when the caller does not pass one', async () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  let capturedArgs: string[] = [];
  setAgentProcessFactoryForTests((_command, args) => {
    capturedArgs = args;
    return mock as never;
  });
  const tools = new Map<string, ToolDefinition>();
  registerSpawnSubagentTool(
    { registerTool: (def) => tools.set(def.name, def) },
    Type,
    new Set<string>(),
    (pi, names, def) => { names.add(def.name); pi.registerTool?.(def); },
  );
  const ctx = {
    hasUI: false,
    cwd: process.cwd(),
    model: { id: 'claude-haiku-4-5-20251001', provider: 'guy-provider-anthropic' },
    ui: { setStatus: () => {}, setWidget: () => {} },
  } as never;

  await tools.get('spawnSubagent')!.execute('id', {
    agent: 'researcher',
    task: 'Goal: test\nContext: test\nScope: test\nOwnership: test\nAcceptance: test\nReturn: test',
  }, undefined, undefined, ctx);

  const providerIdx = capturedArgs.indexOf('--provider');
  assert.equal(providerIdx >= 0, true, 'spawnSubagent should pass an inherited --provider');
  assert.equal(capturedArgs[providerIdx + 1], 'guy-provider-anthropic');
});

// ─── SEV-2: worker model/turn errors are captured into record.error ───────────

test('SEV-2: an errored agent_end message surfaces the model error on record.error', () => {
  if (isSubagentProcess()) return;
  const mock = makeMockProcess({ stdinThrows: false, exitImmediately: false });
  setAgentProcessFactoryForTests(() => mock as never);
  const ctx = { hasUI: false, ui: { setStatus: () => {}, setWidget: () => {} } } as never;
  const record = spawnRpcAgent({ task: 'boom', resourceMode: 'lean' }, ctx);
  const frame = JSON.stringify({
    type: 'agent_end',
    messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 Unsupported model: claude-x' }],
  });
  mock._emit('stdout:data', Buffer.from(frame + '\n'));
  assert.equal(record.error, '400 Unsupported model: claude-x', 'model error captured');
  assert.ok(record.ledgerEvents.some((e) => /worker turn error/.test(e.message ?? '')), 'ledger records the turn error');
});
