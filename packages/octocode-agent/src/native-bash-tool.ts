import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { RuntimeFailure, createEffectSet, jsonSchemaError, type ToolDefinition, type ToolResult } from '@octocodeai/agent-core';

const SECRET_ENV = /(?:api_?key|token|secret|password|passwd|credential|private_?key|cookie|authorization|auth)/i;
const CATASTROPHIC = [
  /(?:^|[;&|()\n]\s*)(?:sudo\s+)?rm\s+(?:-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*)\s+\/(?:\s|$)/i,
  /(?:^|[;&|()\n]\s*)(?:sudo\s+)?(?:mkfs(?:\.[A-Za-z0-9]+)?|shutdown|reboot|halt|poweroff)\b/i,
  /\bdd\b[^\n;&|]*\bof=\/dev\//i,
];

export interface NativeBashToolOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
}

const inputSchema = {
  type: 'object',
  required: ['command'],
  properties: {
    command: { type: 'string', minLength: 1, maxLength: 32_768 },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 },
  },
  additionalProperties: false,
} as const;

const outputSchema = {
  type: 'object',
  required: ['exitCode', 'signal', 'stdout', 'stderr', 'timedOut', 'cancelled', 'truncated'],
  properties: {
    exitCode: { type: ['integer', 'null'] }, signal: { type: ['string', 'null'] },
    stdout: { type: 'string' }, stderr: { type: 'string' }, timedOut: { type: 'boolean' },
    cancelled: { type: 'boolean' }, truncated: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= maximum ? value! : fallback;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !SECRET_ENV.test(name)) output[name] = value;
  }
  return output;
}

function assertCommandAllowed(command: string): void {
  if (command.includes('\0')) throw new Error('bash blocked: command contains a NUL byte');
  if (CATASTROPHIC.some((pattern) => pattern.test(command)))
    throw new Error('bash blocked: command matches a catastrophic system-destruction pattern');
}

interface BashOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

async function executeProcess(options: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
  timeoutMs: number; maxOutputBytes: number;
}): Promise<BashOutcome> {
  if (options.signal.aborted) return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false };
  const shell = process.platform === 'win32' ? options.env.ComSpec ?? 'cmd.exe' : options.env.SHELL ?? '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', options.command] : ['-lc', options.command];
  return await new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: options.cwd,
      env: safeEnvironment(options.env),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let retainedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const remaining = Math.max(0, options.maxOutputBytes - retainedBytes);
      if (remaining === 0) { truncated = true; return; }
      const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      retainedBytes += retained.byteLength;
      if (retained.byteLength < chunk.byteLength) truncated = true;
      if (target === 'stdout') stdout += outDecoder.write(retained);
      else stderr += errDecoder.write(retained);
    };
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { child.kill(signal); }
    };
    const terminate = (): void => {
      kill('SIGTERM');
      const escalation = setTimeout(() => { if (!settled) kill('SIGKILL'); }, 250);
      escalation.unref?.();
    };
    const onAbort = (): void => { cancelled = true; terminate(); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    child.once('error', (error) => {
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      resolve({ exitCode, signal: exitSignal, stdout, stderr, timedOut, cancelled, truncated });
    });
  });
}

export function createNativeBashTool(options: NativeBashToolOptions = {}): ToolDefinition {
  const env = options.env ?? process.env;
  const maxOutputBytes = boundedPositive(options.maxOutputBytes, 1024 * 1024, 8 * 1024 * 1024);
  const defaultTimeoutMs = boundedPositive(options.defaultTimeoutMs, 120_000, 600_000);
  return {
    name: 'bash',
    label: 'Bash',
    description: 'Run one bounded shell command in the workspace. The inherited environment excludes secret-like variables. Every call is treated conservatively as read/write/network/process and requires approval.',
    schemaVersion: 1,
    inputSchema,
    outputSchema,
    outputVersion: 1,
    policy: {
      effects: createEffectSet('read', 'write', 'network', 'process'),
      trust: 'workspace', approval: 'on-request', plan: 'forbidden',
      concurrency: () => ({ lane: 'native-bash', maxActive: 1 }),
    },
    async execute(execution): Promise<ToolResult> {
      const invalid = jsonSchemaError(execution.input, inputSchema);
      if (invalid) throw new RuntimeFailure('validation', invalid);
      const input = execution.input as { command: string; timeoutMs?: number };
      assertCommandAllowed(input.command);
      const cwd = path.resolve(execution.context.cwd);
      const stat = fs.statSync(cwd, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) throw new Error('bash working directory does not exist');
      const outcome = await executeProcess({
        command: input.command, cwd, env, signal: execution.signal,
        timeoutMs: input.timeoutMs ?? defaultTimeoutMs, maxOutputBytes,
      });
      const content = outcome;
      if (outcome.cancelled) return { ok: false, category: 'cancelled', content, detailsVersion: 1 };
      if (outcome.timedOut) return { ok: false, category: 'timeout', content, detailsVersion: 1 };
      if (outcome.exitCode !== 0) return { ok: false, category: 'process-exit', content, detailsVersion: 1 };
      return { ok: true, content, detailsVersion: 1 };
    },
  };
}

export function registerNativeBashTool(registry: { register(definition: ToolDefinition, owner?: string): void }, options?: NativeBashToolOptions): void {
  registry.register(createNativeBashTool(options), 'octocode-agent');
}
