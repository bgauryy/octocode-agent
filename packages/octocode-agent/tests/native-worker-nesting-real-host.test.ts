import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { connectDb, resolveDbPath } from '@octocodeai/octocode-awareness';
import { FileSettingsStorage } from '../src/native-settings.js';
import {
  probeNativeWorkerProcessIdentity,
  type NativeWorkerProcessIdentity,
} from '../src/native-workers.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const builtCli = path.join(packageRoot, 'out', 'octocode-agent.mjs');
const rustCoreBinary = path.resolve(packageRoot, '../octocode-agent-core-rust/target/debug/octocode-agent-core-rust');
const roots: Array<{ root: string; home: string; workspace: string }> = [];
const rootProcesses = new Set<ChildProcess>();
const secret = 'nested-worker-secret-must-stay-private';

interface LifecycleRow {
  event_type: string;
  payload_json: string;
}

interface ScenarioResult {
  code: number | null;
  stdout: string;
  stderr: string;
  requestsByActor: ReadonlyMap<string, number>;
  toolsByActor: ReadonlyMap<string, readonly string[]>;
  lifecycle: readonly LifecycleRow[];
  peakConcurrentChildren: number;
}

function processIdentities(rows: readonly LifecycleRow[]): NativeWorkerProcessIdentity[] {
  return rows
    .filter(({ event_type }) => event_type === 'worker.process')
    .map(({ payload_json }) => JSON.parse(payload_json) as NativeWorkerProcessIdentity);
}

function lifecycleRows(_home: string, workspace: string): LifecycleRow[] {
  const dbPath = resolveDbPath(undefined, { scope: 'repo', workspace });
  if (!fs.existsSync(dbPath)) return [];
  const db = connectDb(dbPath);
  try {
    return db.prepare(`
      SELECT event_type, payload_json
      FROM worker_lifecycle_events
      ORDER BY sequence ASC
    `).all() as unknown as LifecycleRow[];
  } catch (error) {
    if (error instanceof Error && /no such table/u.test(error.message)) return [];
    throw error;
  } finally {
    db.close();
  }
}

async function terminateVerifiedWorkers(home: string, workspace: string): Promise<void> {
  for (const identity of processIdentities(lifecycleRows(home, workspace))) {
    if (probeNativeWorkerProcessIdentity(identity) === undefined) continue;
    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch {
      // The verified process exited between the identity probe and the signal.
    }
  }
}

afterEach(async () => {
  for (const child of rootProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.allSettled([...rootProcesses].map((child) =>
    child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve(),
  ));
  rootProcesses.clear();
  for (const fixture of roots) await terminateVerifiedWorkers(fixture.home, fixture.workspace);
  for (const { root } of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function responseFixture(output: unknown[]): Record<string, unknown> {
  return {
    id: 'resp-worker-fixture',
    created_at: 1,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'fixture-model',
    object: 'response',
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage: {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    },
  };
}

function sendToolCall(
  response: http.ServerResponse,
  actor: string,
  step: number,
  input: Record<string, unknown>,
  name = 'worker',
): void {
  const id = `${actor}-${step}`;
  const args = JSON.stringify(input);
  const item = {
    type: 'function_call',
    id: `item-${id}`,
    call_id: `call-${id}`,
    name,
    arguments: args,
    status: 'completed',
  };
  response.end([
    `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', delta: args, item_id: item.id, output_index: 0, sequence_number: 1 })}`,
    '',
    `data: ${JSON.stringify({ type: 'response.output_item.done', item, output_index: 0, sequence_number: 2 })}`,
    '',
    `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([item]), sequence_number: 3 })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'));
}

function sendMessage(response: http.ServerResponse, text: string): void {
  const item = {
    id: `msg-${text.toLowerCase()}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  response.end([
    `data: ${JSON.stringify({ type: 'response.completed', response: responseFixture([item]), sequence_number: 1 })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'));
}

function actorFor(input: unknown): 'root' | 'child' | 'child-a' | 'child-b' {
  const encoded = JSON.stringify(input);
  if (encoded.includes('ROOT_PARALLEL_START') || encoded.includes('ROOT_LEAF_CHECK_START') || encoded.includes('ROOT_SINGLE_START')) return 'root';
  if (encoded.includes('CHILD_A_START')) return 'child-a';
  if (encoded.includes('CHILD_B_START')) return 'child-b';
  if (/[^A-Z]CHILD_START[^A-Z]/u.test(encoded) || encoded.includes('SINGLE_CHILD_START')) return 'child';
  throw new Error('model request omitted a scenario actor marker');
}

function workerIds(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return workerIds(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(workerIds);
  if (typeof value !== 'object' || value === null) return [];
  const nested = Object.entries(value).flatMap(([key, item]) => [
    ...(key === 'workerId' && typeof item === 'string' ? [item] : []),
    ...workerIds(item),
  ]);
  if (nested.length > 0) return nested;
  let encoded = JSON.stringify(value);
  for (let index = 0; index < 3; index++) encoded = encoded.replaceAll('\\"', '"');
  return [...encoded.matchAll(/"workerId"\s*:\s*"([^"\\]+)"/gu)].map((match) => match[1]!);
}

async function waitForBoundedClose(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
  }, timeoutMs);
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  clearTimeout(timeout);
  if (forceKill !== undefined) clearTimeout(forceKill);
  if (timedOut) throw new Error(`built worker flow exceeded ${timeoutMs}ms`);
  return code;
}

async function runScenario(leafCheck: boolean, rustCore = false, parallel = false): Promise<ScenarioResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-worker-nesting-real-host-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  roots.push({ root, home, workspace });
  fs.mkdirSync(workspace, { recursive: true });

  const requestsByActor = new Map<string, number>();
  const toolsByActor = new Map<string, readonly string[]>();
  const pendingChildren: Array<{ actor: string; response: http.ServerResponse }> = [];
  let activeChildren = 0;
  let peakConcurrentChildren = 0;
  const model = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as {
      input?: unknown;
      tools?: Array<{ name?: unknown }>;
    };
    const actor = actorFor(parsed.input);
    const step = requestsByActor.get(actor) ?? 0;
    requestsByActor.set(actor, step + 1);
    toolsByActor.set(actor, (parsed.tools ?? [])
      .map(({ name }) => name)
      .filter((name): name is string => typeof name === 'string'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });

    if (actor !== 'root') {
      if (parallel) {
        activeChildren += 1;
        peakConcurrentChildren = Math.max(peakConcurrentChildren, activeChildren);
        pendingChildren.push({ actor, response });
        if (pendingChildren.length < 2) return;
        for (const pending of pendingChildren.splice(0)) {
          sendMessage(pending.response, `${pending.actor.toUpperCase()}_DONE`);
          activeChildren -= 1;
        }
        return;
      }
      if (leafCheck && actor === 'child' && step === 0) {
        sendToolCall(response, actor, step, {
          action: 'call',
          tool: 'localSearch',
          input: { operation: 'tree', path: workspace, maxDepth: 1 },
        }, 'octocode');
        return;
      }
      sendMessage(response, leafCheck ? 'CHILD_LEAF_DONE' : 'SINGLE_CHILD_DONE');
      return;
    }
    if (parallel) {
      if (step === 0 || step === 1) {
        sendToolCall(response, actor, step, {
          action: 'spawn',
          task: step === 0 ? 'CHILD_A_START' : 'CHILD_B_START',
          tools: [],
          model: { providerId: 'fixture', modelId: 'fixture-model' },
          maxTurns: 2,
          workspace: { mode: 'shared' },
        });
        return;
      }
      if (step === 2 || step === 3) {
        const ids = [...new Set(workerIds(parsed.input))];
        const workerId = ids[step - 2];
        if (workerId === undefined) throw new Error(`root parallel flow omitted worker ${step - 1}`);
        sendToolCall(response, actor, step, { action: 'wait', workerId, timeoutMs: 15_000 });
        return;
      }
      sendMessage(response, 'ROOT_PARALLEL_DONE');
      return;
    }
    if (step === 0) {
      sendToolCall(response, actor, step, {
        action: 'spawn',
        task: leafCheck ? 'CHILD_START' : 'SINGLE_CHILD_START',
        model: { providerId: 'fixture', modelId: 'fixture-model' },
        maxTurns: leafCheck ? 6 : 2,
        workspace: { mode: 'shared' },
      });
      return;
    }
    if (step === 1) {
      const workerId = workerIds(parsed.input).at(-1);
      if (workerId === undefined) throw new Error('root spawn result omitted workerId');
      sendToolCall(response, actor, step, { action: 'wait', workerId, timeoutMs: leafCheck ? 15_000 : 8_000 });
      return;
    }
    sendMessage(response, leafCheck ? 'ROOT_LEAF_CHECK_DONE' : 'ROOT_SINGLE_DONE');
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const address = model.address();
  if (address === null || typeof address === 'string') throw new Error('model fixture address unavailable');

  const agentDir = path.join(home, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-responses',
        apiKey: '$OCTOCODE_MODEL_API_KEY',
        models: [{ id: 'fixture-model' }],
      },
    },
  }));
  new FileSettingsStorage(path.join(agentDir, 'settings.json')).commit('0', {
    defaultProvider: 'fixture',
    defaultModel: 'fixture-model',
    workspaceTrust: { [workspace]: 'trusted' },
  });

  const child = spawn(process.execPath, [
    builtCli,
    '--mode', 'json',
    ...(rustCore ? ['--session', 'rust-worker-flow'] : ['--no-session']),
    '--allow-workers',
    parallel ? 'ROOT_PARALLEL_START' : leafCheck ? 'ROOT_LEAF_CHECK_START' : 'ROOT_SINGLE_START',
  ], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      OCTOCODE_HOME: home,
      OCTOCODE_MODEL_API_KEY: secret,
      ...(rustCore ? {
        OCTOCODE_AGENT_RUST_CORE_BIN: rustCoreBinary,
        OCTOCODE_AGENT_RUST_CORE_DB: path.join(home, 'agent', 'core.sqlite3'),
      } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rootProcesses.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  try {
    const code = await waitForBoundedClose(child, leafCheck ? 20_000 : 10_000);
    rootProcesses.delete(child);
    return {
      code,
      stdout,
      stderr,
      requestsByActor,
      toolsByActor,
      lifecycle: lifecycleRows(home, workspace),
      peakConcurrentChildren,
    };
  } finally {
    model.close();
    await once(model, 'close');
  }
}

function expectCleanTermination(result: ScenarioResult, expectedWorkers: number): void {
  expect(result.code, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
  expect(result.stderr).toBe('');
  expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
  const identities = processIdentities(result.lifecycle);
  expect(identities).toHaveLength(expectedWorkers);
  for (const identity of identities) expect(probeNativeWorkerProcessIdentity(identity)).toBeUndefined();
  const terminal = result.lifecycle
    .filter(({ event_type }) => event_type === 'worker.terminal')
    .map(({ payload_json }) => JSON.parse(payload_json) as { outcome?: unknown });
  expect(terminal).toHaveLength(expectedWorkers);
  expect(
    terminal.every(({ outcome }) => outcome === 'succeeded'),
    `terminal=${JSON.stringify(terminal)}`,
  ).toBe(true);
}

describe('built native root-only workers', () => {
  it('completes one real leaf worker before the root exits', async () => {
    expect(fs.existsSync(builtCli)).toBe(true);
    const result = await runScenario(false);

    expectCleanTermination(result, 1);
    expect(result.requestsByActor.get('root')).toBe(3);
    expect(result.requestsByActor.get('child')).toBe(1);
  }, 15_000);

  it('makes a real child leaf-only and never starts a grandchild', async () => {
    expect(fs.existsSync(builtCli)).toBe(true);
    const result = await runScenario(true);

    expectCleanTermination(result, 1);
    expect(result.requestsByActor.get('root')).toBe(3);
    expect(result.requestsByActor.get('child')).toBe(2);
    expect(result.requestsByActor.get('grandchild')).toBeUndefined();
    expect([...result.toolsByActor.get('child')!].sort()).toEqual([
      'MCPTool', 'awareness', 'bash', 'file', 'octocode', 'plan', 'skill', 'web',
    ].sort());
    expect(JSON.stringify(result.lifecycle)).not.toMatch(/CHILD_START|GRANDCHILD_START/);
  }, 25_000);

  it('runs two real leaf workers concurrently within the root worker bound', async () => {
    expect(fs.existsSync(builtCli)).toBe(true);
    const result = await runScenario(true, false, true);

    expectCleanTermination(result, 2);
    expect(result.peakConcurrentChildren).toBe(2);
    expect(result.peakConcurrentChildren).toBeLessThanOrEqual(4);
    expect(result.requestsByActor.get('root')).toBe(5);
    expect(result.requestsByActor.get('child-a')).toBe(1);
    expect(result.requestsByActor.get('child-b')).toBe(1);
    expect(result.toolsByActor.get('child-a')).not.toContain('worker');
    expect(result.toolsByActor.get('child-b')).not.toContain('worker');
  }, 25_000);

  it.skipIf(!fs.existsSync(rustCoreBinary))('completes a real leaf worker through Rust-leased AI messages', async () => {
    expect(fs.existsSync(builtCli)).toBe(true);
    const result = await runScenario(false, true);

    expectCleanTermination(result, 1);
    expect(result.requestsByActor.get('root')).toBe(3);
    expect(result.requestsByActor.get('child')).toBe(1);
  }, 20_000);
});
