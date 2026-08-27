import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  createRuntimeKernel,
  LifecycleBus,
  PolicyChain,
  revision,
  sessionEventId,
  sessionId,
  TransactionalSessionStore,
  type AgentRuntime,
  type Revision,
  type RuntimeEvent,
  type SessionEvent,
  type SessionId,
  type SessionStore,
} from '@octocodeai/agent-core';
import path from 'node:path';

import { createOpenAiCompatibleModelPort } from './native-model.js';
import { createDefaultOctocodeToolRegistry } from './native-tools.js';
import { FileSessionRecordPort } from './native-session-store.js';
import { FileSettingsStorage } from './native-settings.js';
import { listSessions, nativeSessionsDir, newestProjectSession } from './sessions.js';
import { agentDir } from './settings.js';
import { runJsonTransport, runPrintTransport, runRpcTransport } from './native-transports.js';
import {
  type OpenTuiTerminal,
  type PresentationEvent,
} from './terminal/opentui/index.js';
import { createDefaultOpenTuiTerminal } from './terminal/opentui/renderer.js';

export interface ParsedNativeArgs {
  mode: 'interactive' | 'print' | 'rpc';
  outputFormat: 'text' | 'json';
  initialMessage?: string;
  session?: string;
  name?: string;
  noSession: boolean;
  continue: boolean;
  rest: string[];
}

export interface NativeLaunchDependencies {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
  createRuntime?: (options: { env: NodeJS.ProcessEnv; cwd: string; args: ParsedNativeArgs }) => Promise<AgentRuntime>;
  createTerminal?: () => OpenTuiTerminal;
}

export function parseNativeArgs(argv: readonly string[] = []): ParsedNativeArgs {
  const parsed: ParsedNativeArgs = {
    mode: 'interactive',
    outputFormat: 'text',
    noSession: false,
    continue: false,
    rest: [],
  };
  let print = false;
  let explicit: 'text' | 'json' | 'rpc' | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-p' || arg === '--print') {
      print = true;
      continue;
    }
    if (arg === '--mode' && index + 1 < argv.length) {
      const value = argv[++index];
      if (value === 'text' || value === 'json' || value === 'rpc') {
        explicit = value;
        continue;
      }
      parsed.rest.push('--mode', value!);
      continue;
    }
    if (arg === '--no-session') {
      parsed.noSession = true;
      continue;
    }
    if (arg === '-c' || arg === '--continue') {
      parsed.continue = true;
      continue;
    }
    if ((arg === '--session' || arg === '--name' || arg === '-n') && index + 1 < argv.length) {
      const value = argv[++index];
      if (arg === '--session') parsed.session = value;
      else parsed.name = value;
      continue;
    }
    if (!arg.startsWith('-') && parsed.initialMessage == null) parsed.initialMessage = arg;
    else parsed.rest.push(arg);
  }
  if (explicit === 'rpc') parsed.mode = 'rpc';
  else if (print || explicit === 'json') parsed.mode = 'print';
  if (explicit === 'json') parsed.outputFormat = 'json';
  return parsed;
}

function configuredApiKey(env: NodeJS.ProcessEnv): string {
  return env.OCTOCODE_MODEL_API_KEY ?? env.OPENAI_API_KEY ?? '';
}

export function resolveNativeSessionId(
  args: ParsedNativeArgs,
  cwd: string,
  sessionsRoot: string,
  now: () => number = Date.now,
): string {
  if (args.noSession) return `memory:${process.pid}`;
  if (args.session) {
    const match = listSessions(sessionsRoot).find((session) => (
      session.key === args.session
      || session.uuid === args.session
      || session.file === args.session
    ));
    if (!match) throw new Error(`Native session not found: ${args.session}`);
    return match.uuid;
  }
  if (args.continue) {
    const latest = newestProjectSession(cwd, sessionsRoot);
    if (latest) return latest.uuid;
  }
  return `native:${now()}`;
}

export function createRuntimeEventPersister(options: {
  sessions: SessionStore;
  activeSessionId: SessionId;
  initialRevision: Revision;
  lifecycle?: Map<RuntimeEvent['type'], LifecycleBus<unknown>>;
}): (runtimeEvent: RuntimeEvent) => Promise<void> {
  let storedRevision = options.initialRevision;
  const lifecycle = options.lifecycle ?? new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
  const assistantChunks: string[] = [];

  const dispatch = async (runtimeEvent: RuntimeEvent): Promise<void> => {
    let bus = lifecycle.get(runtimeEvent.type);
    if (!bus) {
      bus = new LifecycleBus({ eventType: runtimeEvent.type, authority: ['observe'], validate: (_payload): _payload is unknown => true });
      lifecycle.set(runtimeEvent.type, bus);
    }
    await bus.dispatch(runtimeEvent);
  };
  const append = async (
    runtimeEvent: RuntimeEvent,
    storedEvent: SessionEvent['event'],
    visibility: SessionEvent['visibility'],
    eventIdSuffix = '',
  ): Promise<void> => {
    const sequence = Number(storedRevision) + 1;
    const entry: SessionEvent = {
      schemaVersion: 1,
      sessionId: options.activeSessionId,
      eventId: sessionEventId(`${String(runtimeEvent.id)}${eventIdSuffix}`),
      revision: revision(String(sequence)),
      sequence,
      timestamp: runtimeEvent.timestamp,
      visibility,
      event: storedEvent,
    };
    storedRevision = await options.sessions.append(options.activeSessionId, storedRevision, [entry]);
  };
  const flushAssistant = async (runtimeEvent: RuntimeEvent): Promise<void> => {
    if (assistantChunks.length === 0) return;
    const content = assistantChunks.join('');
    assistantChunks.length = 0;
    await append(runtimeEvent, { type: 'message.appended', role: 'assistant', content }, 'transcript', ':assistant');
  };

  return async (runtimeEvent: RuntimeEvent): Promise<void> => {
    const payload = runtimeEvent.payload as Record<string, unknown>;
    if (runtimeEvent.type === 'message.delta' && payload.type === 'text' && typeof payload.text === 'string') {
      assistantChunks.push(payload.text);
      await dispatch(runtimeEvent);
      return;
    }
    if (
      runtimeEvent.type === 'provider.response-received'
      || runtimeEvent.type === 'turn.ended'
      || runtimeEvent.type === 'runtime.failed'
      || runtimeEvent.type === 'runtime.stopping'
    ) await flushAssistant(runtimeEvent);

    const storedEvent: SessionEvent['event'] = runtimeEvent.type === 'input.received' && typeof payload.text === 'string'
      ? { type: 'message.appended', role: 'user', content: payload.text }
      : { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload };
    await append(
      runtimeEvent,
      storedEvent,
      runtimeEvent.type === 'input.received' ? 'transcript' : 'diagnostics',
    );
    await dispatch(runtimeEvent);
  };
}

export async function createDefaultNativeRuntime(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  args: ParsedNativeArgs;
}): Promise<AgentRuntime> {
  const sessionsRoot = nativeSessionsDir(options.env);
  const selectedSession = resolveNativeSessionId(options.args, options.cwd, sessionsRoot);
  const activeSessionId = sessionId(selectedSession);
  const home = agentDir(options.env);
  const settings = new FileSettingsStorage(path.join(home, 'settings.json')).read();
  const configuredModel = typeof settings.values.defaultModel === 'string' ? settings.values.defaultModel : undefined;
  const tools = await createDefaultOctocodeToolRegistry();
  const policy = new PolicyChain();
  policy.use('native-effect-boundary', async (request) => (
    request.effect === 'read' || request.effect === 'network'
      ? { effect: 'allow' }
      : { effect: 'deny', reason: `Native ${request.effect} effects require an explicit approved adapter`, category: 'approval' }
  ));
  const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
  const sessions = new TransactionalSessionStore(new FileSessionRecordPort(sessionsRoot));
  let storedRevision = revision('0');
  try {
    const loaded = await sessions.load(activeSessionId);
    storedRevision = loaded.projection.revision;
  } catch {
    // The transactional store reports corrupt state; do not silently overwrite it.
    throw new Error(`Unable to load native session ${activeSessionId}`);
  }
  if (storedRevision === revision('0')) {
    const timestamp = Date.now();
    const created: SessionEvent[] = [
      {
        schemaVersion: 1,
        sessionId: activeSessionId,
        eventId: sessionEventId(`${activeSessionId}:created`),
        revision: revision('1'),
        sequence: 1,
        timestamp,
        visibility: 'internal',
        event: { type: 'session.created', ...(options.args.name ? { name: options.args.name } : {}) },
      },
      {
        schemaVersion: 1,
        sessionId: activeSessionId,
        eventId: sessionEventId(`${activeSessionId}:cwd`),
        revision: revision('2'),
        sequence: 2,
        timestamp,
        visibility: 'internal',
        event: { type: 'custom.appended', kind: 'session.cwd', value: options.cwd },
      },
    ];
    storedRevision = await sessions.append(activeSessionId, storedRevision, created);
  }
  const persistRuntimeEvent = createRuntimeEventPersister({
    sessions,
    activeSessionId,
    initialRevision: storedRevision,
    lifecycle,
  });
  return createRuntimeKernel({
    sessionId: activeSessionId,
    cwd: options.cwd,
    tools,
    policy,
    emit: persistRuntimeEvent,
    model: createOpenAiCompatibleModelPort({
      endpoint: options.env.OCTOCODE_MODEL_ENDPOINT ?? 'https://api.openai.com/v1',
      apiKey: configuredApiKey(options.env),
      defaultModel: options.env.OCTOCODE_MODEL ?? configuredModel ?? 'gpt-5',
    }),
  });
}

function presentationEvent(event: RuntimeEvent): PresentationEvent | undefined {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'runtime.ready': return { type: 'runtime-ready' };
    case 'runtime.stopping': return { type: 'runtime-stopping' };
    case 'runtime.failed': return { type: 'runtime-failed' };
    case 'message.delta':
      return typeof payload.text === 'string' ? { type: 'message-delta', text: payload.text } : undefined;
    case 'ui.notification': {
      if (typeof payload.message !== 'string') return undefined;
      const severity = payload.severity;
      return {
        type: 'notification',
        message: payload.message,
        severity: severity === 'success' || severity === 'warning' || severity === 'error' ? severity : 'info',
      };
    }
    case 'ui.status-changed':
      return typeof payload.name === 'string'
        ? { type: 'status-changed', name: payload.name, text: typeof payload.text === 'string' ? payload.text : undefined }
        : undefined;
    default:
      return undefined;
  }
}

async function runInteractive(
  runtime: AgentRuntime,
  terminal: OpenTuiTerminal,
  input: Readable,
  initialMessage?: string,
): Promise<number> {
  await terminal.start();
  const unsubscribe = runtime.subscribe((event) => {
    const semantic = presentationEvent(event);
    if (semantic) terminal.accept(semantic);
  });
  try {
    await runtime.start();
    if (initialMessage) await runtime.submit(initialMessage);
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === '/exit' || line.trim() === '/quit') break;
      if (line.trim()) await runtime.submit(line);
    }
    return 0;
  } finally {
    unsubscribe();
    await runtime.stop();
    await terminal.stop();
  }
}

export async function launchNativeAgent(
  argv: readonly string[] = [],
  dependencies: NativeLaunchDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const args = parseNativeArgs(argv);
  const runtime = await (dependencies.createRuntime ?? createDefaultNativeRuntime)({ env, cwd, args });
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  if (args.mode === 'rpc') return runRpcTransport(runtime, { input: stdin, output: stdout });
  const message = [args.initialMessage, ...args.rest.filter((value) => !value.startsWith('-'))]
    .filter((value): value is string => Boolean(value))
    .join(' ');
  if (args.mode === 'print') {
    if (args.outputFormat === 'json') return runJsonTransport(runtime, message, (value) => { stdout.write(value); });
    return runPrintTransport(runtime, message, { format: 'text', write: (value) => { stdout.write(value); } });
  }
  return runInteractive(runtime, (dependencies.createTerminal ?? createDefaultOpenTuiTerminal)(), stdin, args.initialMessage);
}
