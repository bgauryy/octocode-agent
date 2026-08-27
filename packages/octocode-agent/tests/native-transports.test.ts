import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeEvent,
  RuntimeSnapshot,
} from '@octocodeai/agent-core';

import {
  runJsonTransport,
  runPrintTransport,
  runRpcTransport,
} from '../src/native-transports.js';

function runtimeFixture(): {
  runtime: AgentRuntime;
  emit(event: RuntimeEvent): void;
  execute: ReturnType<typeof vi.fn<(command: RuntimeCommand) => Promise<RuntimeCommandResult>>>;
} {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const execute = vi.fn(async () => ({ ok: true as const, data: { state: 'ready' } }));
  const runtime: AgentRuntime = {
    start: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    execute,
    snapshot: vi.fn(() => ({ state: 'ready' }) as RuntimeSnapshot),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return { runtime, emit: (event) => listeners.forEach((listener) => listener(event)), execute };
}

function event(type: RuntimeEvent['type'], payload: unknown): RuntimeEvent {
  return { type, payload } as RuntimeEvent;
}

describe('native noninteractive transports', () => {
  it('prints only semantic message deltas in text mode', async () => {
    const fixture = runtimeFixture();
    const writes: string[] = [];
    const run = runPrintTransport(fixture.runtime, 'hello', {
      format: 'text',
      write: (value) => writes.push(value),
    });
    await Promise.resolve();
    fixture.emit(event('message.delta', { text: 'answer' }));
    await run;

    expect(writes.join('')).toBe('answer');
    expect(fixture.runtime.submit).toHaveBeenCalledWith('hello');
    expect(fixture.runtime.stop).toHaveBeenCalledOnce();
  });

  it('emits JSONL events without terminal initialization', async () => {
    const fixture = runtimeFixture();
    const writes: string[] = [];
    const run = runJsonTransport(fixture.runtime, 'hello', (value) => writes.push(value));
    await Promise.resolve();
    fixture.emit(event('runtime.ready', {}));
    await run;

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toMatchObject({ protocolVersion: 1, sequence: 1 });
  });

  it('validates versioned RPC lines and correlates responses', async () => {
    const fixture = runtimeFixture();
    const input = new PassThrough();
    const output = new PassThrough();
    const writes: string[] = [];
    output.on('data', (chunk) => writes.push(String(chunk)));

    const run = runRpcTransport(fixture.runtime, { input, output });
    input.write(`${JSON.stringify({
      protocolVersion: 1,
      requestId: 'r1',
      command: { type: 'runtime.snapshot' },
    })}\n`);
    input.write('{bad json}\n');
    input.end();
    await run;

    const lines = writes.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ protocolVersion: 1, requestId: 'r1', ok: true });
    expect(lines[1]).toMatchObject({ category: 'parse' });
    expect(fixture.execute).toHaveBeenCalledWith({ type: 'runtime.snapshot' });
  });
});
