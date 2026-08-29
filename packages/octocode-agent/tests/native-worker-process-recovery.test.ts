import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const packageRoot = path.resolve(import.meta.dirname, '..');
const builtCli = path.join(packageRoot, 'out', 'octocode-agent.mjs');
const signalFixture = path.join(import.meta.dirname, 'fixtures', 'native-worker-signal-child.mjs');

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.allSettled([...children].map((child) => child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve()));
  children.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function isolatedHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-real-'));
  roots.push(root);
  return path.join(root, 'home');
}

async function runBuiltWorker(label: string): Promise<{ code: number | null; lines: Record<string, unknown>[] }> {
  const child = spawn(process.execPath, [builtCli, '--mode', 'rpc', '--no-session'], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENAI_API_KEY: 'test-key-not-secret-output',
      OCTOCODE_HOME: isolatedHome(),
      OCTOCODE_NATIVE_WORKER: '1',
      OCTOCODE_AGENT_ID: `parent:worker:${label}`,
      OCTOCODE_WORKER_CORRELATION_ID: `correlation-${label}`,
      OCTOCODE_WORKER_ALLOWED_TOOLS: '[]',
      OCTOCODE_WORKER_ALLOWED_MODELS: '[{"providerId":"openai","modelId":"gpt-5"}]',
      OCTOCODE_WORKER_MAX_TURNS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.end([
    JSON.stringify({ protocolVersion: 1, requestId: `snapshot-${label}`, command: { type: 'runtime.snapshot' } }),
    JSON.stringify({ protocolVersion: 1, requestId: `tools-${label}`, command: { type: 'tools.list' } }),
    '',
  ].join('\n'));
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  children.delete(child);
  if (stderr) throw new Error(`built worker stderr: ${stderr}`);
  return { code, lines: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('native worker real-process recovery', () => {
  it('runs two built worker processes with correlated JSONL and no recursive tools or secret output', async () => {
    expect(fs.existsSync(builtCli)).toBe(true);
    const [first, second] = await Promise.all([runBuiltWorker('one'), runBuiltWorker('two')]);
    for (const [label, result] of [['one', first], ['two', second]] as const) {
      expect(result.code).toBe(0);
      expect(result.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ requestId: `snapshot-${label}`, ok: true }),
        expect.objectContaining({ requestId: `tools-${label}`, ok: true, data: [] }),
      ]));
      expect(JSON.stringify(result.lines)).not.toContain('test-key-not-secret-output');
      expect(JSON.stringify(result.lines)).not.toContain('worker-management');
    }
  });

  it('closes the built worker cleanly after RPC stdin EOF without an open-handle leak', async () => {
    const result = await Promise.race([
      runBuiltWorker('open-handle'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('built worker left an open handle')), 5_000)),
    ]);
    expect(result.code).toBe(0);
  });

  it('surfaces a dead stdin pipe after the child exits', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'ignore', 'ignore'] });
    children.add(child);
    await once(child, 'close');
    children.delete(child);
    const error = await new Promise<Error | null>((resolve) => {
      child.stdin.write('late write\n', (value) => resolve(value ?? null));
    });
    expect(error).toBeInstanceOf(Error);
  });

  it('proves TERM-to-KILL escalation against an uncooperative real child', async () => {
    const child = spawn(process.execPath, [signalFixture], { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    child.stdout.setEncoding('utf8');
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    await once(child.stdout, 'data');
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    const [, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    children.delete(child);
    expect(signal).toBe('SIGKILL');
  });
});
