import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  AgentRuntime,
  RpcEvent,
  RpcProtocolError,
  RpcRequest,
  RpcResponse,
  RuntimeCommand,
  RuntimeEvent,
} from '@octocodeai/agent-core';

type Write = (value: string) => void;

function eventText(event: RuntimeEvent): string | undefined {
  if (event.type !== 'message.delta') return undefined;
  const payload = event.payload as { text?: unknown };
  return typeof payload.text === 'string' ? payload.text : undefined;
}

export async function runPrintTransport(
  runtime: AgentRuntime,
  input: string,
  options: { format: 'text' | 'json'; write: Write },
): Promise<number> {
  await runtime.start();
  let sequence = 0;
  const unsubscribe = runtime.subscribe((event) => {
    if (options.format === 'json') {
      const envelope: RpcEvent = { protocolVersion: 1, sequence: ++sequence, event };
      options.write(`${JSON.stringify(envelope)}\n`);
      return;
    }
    const text = eventText(event);
    if (text != null) options.write(text);
  });
  try {
    await runtime.submit(input);
    return 0;
  } finally {
    unsubscribe();
    await runtime.stop();
  }
}

export function runJsonTransport(
  runtime: AgentRuntime,
  input: string,
  write: Write,
): Promise<number> {
  return runPrintTransport(runtime, input, { format: 'json', write });
}

function protocolError(
  category: RpcProtocolError['category'],
  message: string,
  requestId?: string,
  protocolVersion?: number,
): RpcProtocolError {
  return { protocolVersion, requestId, category, message };
}

function parseRpcRequest(line: string): RpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw protocolError('parse', 'RPC input must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw protocolError('validation', 'RPC input must be an object');
  }
  const value = parsed as Record<string, unknown>;
  const requestId = typeof value.requestId === 'string' ? value.requestId : undefined;
  const version = typeof value.protocolVersion === 'number' ? value.protocolVersion : undefined;
  if (version !== 1) {
    throw protocolError('version', 'Unsupported RPC protocol version', requestId, version);
  }
  if (!requestId) {
    throw protocolError('validation', 'RPC requestId must be a non-empty string', undefined, 1);
  }
  const command = value.command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw protocolError('validation', 'RPC command must be an object', requestId, 1);
  }
  if (typeof (command as { type?: unknown }).type !== 'string') {
    throw protocolError('validation', 'RPC command type must be a string', requestId, 1);
  }
  return { protocolVersion: 1, requestId, command: command as RuntimeCommand };
}

function writeJsonLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function runRpcTransport(
  runtime: AgentRuntime,
  streams: { input: Readable; output: Writable },
): Promise<number> {
  await runtime.start();
  let sequence = 0;
  const unsubscribe = runtime.subscribe((event) => {
    const envelope: RpcEvent = { protocolVersion: 1, sequence: ++sequence, event };
    writeJsonLine(streams.output, envelope);
  });

  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = parseRpcRequest(line);
        const result = await runtime.execute(request.command);
        const response: RpcResponse = {
          protocolVersion: 1,
          requestId: request.requestId,
          ok: true,
          data: result,
        };
        writeJsonLine(streams.output, response);
      } catch (error) {
        const safe = error as Partial<RpcProtocolError>;
        writeJsonLine(
          streams.output,
          protocolError(
            safe.category ?? 'validation',
            typeof safe.message === 'string' ? safe.message : 'Invalid RPC request',
            safe.requestId,
            safe.protocolVersion,
          ),
        );
      }
    }
    return 0;
  } finally {
    unsubscribe();
    await runtime.stop();
  }
}
