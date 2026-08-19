import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from '@earendil-works/pi-coding-agent';

export const DEFAULT_SERVE_SESSION = 'octocode';
export const DEFAULT_SERVE_SESSION_NAME = 'Octocode Serve';
const INTERNAL_SESSION_NAME_ID = 'octocode-serve:set-session-name';

export interface ServeCommandEnvelope {
  v?: 1;
  session?: string;
  id?: string;
  cmd: RpcCommand | RpcExtensionUIResponse;
}

export type ServeOutputKind = 'response' | 'event' | 'ui' | 'serve' | 'error';

export interface ServeOutputEnvelope {
  v: 1;
  session: string;
  id?: string;
  kind: ServeOutputKind;
  body: RpcResponse | RpcExtensionUIRequest | ServeEventLike | ServeErrorBody | ServeControlBody;
}

export interface ServeStdioOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  spawnProcess?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  entrypoint?: string;
}

export type ServeEventLike = { type: string; [key: string]: unknown };
export type ServeErrorBody = { type: 'error'; error: string };
export type ServeControlBody = { type: string; [key: string]: unknown };
export type RawRpcInput = RpcCommand | RpcExtensionUIResponse;
export type RawRpcOutput = RpcResponse | RpcExtensionUIRequest | ServeEventLike;

export interface ServeArgs {
  mode: 'stdio' | 'raw-rpc';
  session: string;
  sessionName: string;
  rpcArgs: string[];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseServeArgs(rest: string[] = []): ServeArgs {
  const rpcArgs: string[] = [];
  let mode: ServeArgs['mode'] = 'stdio';
  let session = DEFAULT_SERVE_SESSION;
  let sessionName = DEFAULT_SERVE_SESSION_NAME;
  let passthrough = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (passthrough) {
      rpcArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }
    if (arg === '--stdio') {
      mode = 'stdio';
      continue;
    }
    if (arg === '--raw-rpc') {
      mode = 'raw-rpc';
      continue;
    }
    if (arg === '--session' && i + 1 < rest.length) {
      session = rest[++i]!;
      continue;
    }
    if ((arg === '--name' || arg === '-n') && i + 1 < rest.length) {
      sessionName = rest[++i]!;
      continue;
    }
    rpcArgs.push(arg);
  }

  return {
    mode,
    session: stringValue(session) ?? DEFAULT_SERVE_SESSION,
    sessionName: stringValue(sessionName) ?? DEFAULT_SERVE_SESSION_NAME,
    rpcArgs,
  };
}

export function buildRawRpcArgv(args: ServeArgs): string[] {
  return ['--mode', 'rpc', ...args.rpcArgs];
}

export function createSessionNameCommand(name = DEFAULT_SERVE_SESSION_NAME): RpcCommand {
  return { id: INTERNAL_SESSION_NAME_ID, type: 'set_session_name', name };
}

function isRawRpcInput(value: unknown): value is RawRpcInput {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string');
}

export function unwrapServeInputLine(line: string, defaultSession = DEFAULT_SERVE_SESSION): { session: string; command: RawRpcInput } {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('serve input must be a JSON object');
  const envelope = parsed as Partial<ServeCommandEnvelope>;
  if (!isRawRpcInput(envelope.cmd)) {
    throw new Error('serve input must include a cmd object with a string type');
  }
  const session = stringValue(envelope.session) ?? defaultSession;
  const command = { ...envelope.cmd } as RawRpcInput;
  const id = stringValue(envelope.id);
  if (id && command.id == null) command.id = id;
  return { session, command };
}

export function classifyRpcOutput(body: RawRpcOutput): ServeOutputKind {
  if (body.type === 'response') return 'response';
  if (body.type === 'extension_ui_request') return 'ui';
  return 'event';
}

function isRawRpcOutput(value: unknown): value is RawRpcOutput {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string');
}

export function wrapRpcOutput(body: RawRpcOutput, session = DEFAULT_SERVE_SESSION): ServeOutputEnvelope | null {
  if (body.type === 'response' && body.id === INTERNAL_SESSION_NAME_ID) return null;
  const id = stringValue(body.id);
  return { v: 1, session, id, kind: classifyRpcOutput(body), body };
}

export function makeServeError(message: string, session = DEFAULT_SERVE_SESSION, id?: string): ServeOutputEnvelope {
  return {
    v: 1,
    session,
    id,
    kind: 'error',
    body: { type: 'error', error: message },
  };
}

function writeJsonLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function runServeStdio(options: ServeStdioOptions = {}): Promise<number> {
  const serveArgs = parseServeArgs(options.argv ?? []);
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const entrypoint = options.entrypoint ?? process.argv[1];

  if (!entrypoint) {
    writeJsonLine(stdout, makeServeError('cannot locate octocode-agent entrypoint', serveArgs.session));
    return 1;
  }

  const env = {
    ...process.env,
    ...(options.env ?? {}),
    OCTOCODE_SERVE: '1',
    OCTOCODE_SERVE_SESSION: serveArgs.session,
  };
  const spawnProcess = options.spawnProcess ?? ((command, args, opts) => spawn(command, args, opts));
  const child = spawnProcess(process.execPath, [entrypoint, ...buildRawRpcArgv(serveArgs)], { env });

  child.stdin.write(`${JSON.stringify(createSessionNameCommand(serveArgs.sessionName))}\n`);

  const childOut = createInterface({ input: child.stdout });
  childOut.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRawRpcOutput(parsed)) return;
      const wrapped = wrapRpcOutput(parsed, serveArgs.session);
      if (wrapped) writeJsonLine(stdout, wrapped);
    } catch {
      // Raw child output is ignored; raw RPC mode is JSON-lines only.
    }
  });

  child.stderr.on('data', (chunk: Buffer | string) => stderr.write(chunk));

  const parentIn = createInterface({ input: stdin });
  parentIn.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const { command } = unwrapServeInputLine(line, serveArgs.session);
      child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      writeJsonLine(stdout, makeServeError(error instanceof Error ? error.message : String(error), serveArgs.session));
    }
  });
  parentIn.on('close', () => child.stdin.end());

  return await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      writeJsonLine(stdout, makeServeError(error.message, serveArgs.session));
      resolve(1);
    });
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}
