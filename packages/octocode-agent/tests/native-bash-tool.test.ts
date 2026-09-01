import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { jsonSchemaError, sessionId, type ToolExecutionInput } from '@octocodeai/agent-core';
import { createNativeBashTool } from '../src/native-bash-tool.js';

function request(input: unknown, cwd: string, signal = new AbortController().signal): ToolExecutionInput {
  return {
    input,
    callId: 'bash-call' as never,
    context: {
      sessionId: sessionId('bash-session'), cwd, mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false }, signal,
    },
    signal,
    update: vi.fn(async () => undefined),
  };
}

describe('native bash tool', () => {
  it('publishes a strict bounded schema and conservative process policy', () => {
    const tool = createNativeBashTool();
    expect(jsonSchemaError({ command: 'pwd' }, tool.inputSchema)).toBeUndefined();
    expect(jsonSchemaError({ command: '' }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ command: 'pwd', timeoutMs: 0 }, tool.inputSchema)).toBeDefined();
    expect(jsonSchemaError({ command: 'pwd', extra: true }, tool.inputSchema)).toBeDefined();
    expect(tool.policy).toMatchObject({
      effects: ['read', 'network', 'process', 'write'],
      trust: 'workspace', approval: 'on-request', plan: 'forbidden',
    });
    expect(tool.policy.concurrency?.({})).toEqual({ lane: 'native-bash', maxActive: 1 });
  });

  it('rejects invalid inputs at the execution boundary before spawning a shell', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bash-schema-'));
    const tool = createNativeBashTool();

    await expect(tool.execute(request({ command: "printf 'must-not-run'", timeoutMs: 0 }, cwd))).rejects.toThrow(/must be >= 1/i);
  });

  it('executes in the requested cwd with a bounded structured result', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bash-'));
    const tool = createNativeBashTool();
    const result = await tool.execute(request({ command: "printf 'hello'" }, cwd));
    expect(result).toMatchObject({
      ok: true,
      content: { exitCode: 0, stdout: 'hello', stderr: '', timedOut: false, cancelled: false },
    });
  });

  it('does not expose secret-like inherited environment variables', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bash-env-'));
    const tool = createNativeBashTool({ env: { PATH: process.env.PATH, OCTOCODE_MODEL_API_KEY: 'must-not-leak' } });
    const result = await tool.execute(request({ command: "printf '%s' \"$OCTOCODE_MODEL_API_KEY\"" }, cwd));
    expect(JSON.stringify(result.content)).not.toContain('must-not-leak');
  });

  it('kills the process group on timeout and distinguishes caller cancellation', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bash-stop-'));
    const tool = createNativeBashTool();
    const timed = await tool.execute(request({ command: 'sleep 2', timeoutMs: 10 }, cwd));
    expect(timed).toMatchObject({ ok: false, category: 'timeout', content: { timedOut: true, cancelled: false } });

    const controller = new AbortController();
    const running = tool.execute(request({ command: 'sleep 2' }, cwd, controller.signal));
    controller.abort();
    await expect(running).resolves.toMatchObject({ ok: false, category: 'cancelled', content: { cancelled: true } });
  });

  it('caps combined output and blocks catastrophic root-destruction commands', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bash-cap-'));
    const tool = createNativeBashTool({ maxOutputBytes: 64 });
    const capped = await tool.execute(request({ command: "printf '%0100d' 0" }, cwd));
    expect(capped.content).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(capped.content))).toBeLessThan(1_000);
    await expect(tool.execute(request({ command: 'rm -rf /' }, cwd))).rejects.toThrow(/blocked/i);
  });
});
