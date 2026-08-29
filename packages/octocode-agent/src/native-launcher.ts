import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import {
  createRuntimeKernel,
  DurableCompactionService,
  InMemorySessionStore,
  LiveRuntimePlanState,
  LifecycleBus,
  PolicyChain,
  RuntimeFailure,
  SessionController,
  revision,
  sessionEventId,
  sessionId,
  turnId,
  TransactionalSessionStore,
  WorkerSupervisor,
  type AgentRuntime,
  type EffectLedgerPort,
  type EffectLedgerRecord,
  type EffectSet,
  type LifecycleDispatchResult,
  type ModelMessage,
  type ModelPort,
  type ModelToolCall,
  type Revision,
  type RuntimeEvent,
  type SessionEvent,
  type SessionEventId,
  type SessionId,
  type SessionStore,
  type ToolRegistry,
} from '@octocodeai/agent-core';
import { getSkillEnablement, octocodeDbPath, openOctocodeDb, recordSession } from '@octocodeai/octocode-awareness/mcp-state';
import fs from 'node:fs';
import path from 'node:path';

import {
  createNativeProviderModelPort,
  resolveNativeModelConfiguration,
  type NativeProviderProtocol,
} from './native-provider-registry.js';
import { handleNativeSlashCommand, type NativeSkillSummary } from './native-slash-commands.js';
import {
  createNativeInteractionBroker,
  registerNativeAskUserTool,
  type NativeInteractionBroker,
} from './native-interactions.js';
import {
  closeNativeToolRegistry,
  createDefaultOctocodeToolRegistry,
  createNativeCapabilityComposition,
  createNativeHookMcpExecutor,
  createNativeSettingsCapabilityControl,
} from './native-tools.js';
import {
  FileBackedRuntimePlanState,
  FilePlanStore,
  InMemoryPlanStore,
  projectRuntimePlanSnapshot,
  type NativePlanInteraction,
  type RuntimePlanSnapshot,
  type RuntimePlanSnapshotSink,
} from './native-plan.js';
import { FileSessionRecordPort } from './native-session-store.js';
import { FileSettingsStorage } from './native-settings.js';
import { createNativeSettingsService, type NativeSettingsService } from './native-settings-service.js';
import { NativeExtensionsController } from './native-extensions.js';
import {
  createNativeFilesystemExtensionsOptions,
  NativeHookCommandExecutor,
  resolveNativeExtensionPolicy,
} from './native-extension-adapters.js';
import { installNativeHookDispatcher } from './native-hook-dispatcher.js';
import {
  createNativeSettingsPageController,
  type NativeSettingsPageController,
} from './native-settings-page.js';
import { listNativeSkillSummaries } from './native-skills.js';
import {
  buildNativePromptSnapshot,
  nativePromptRecord,
  parseNativePromptRecord,
  type NativePromptRecord,
} from './native-prompt.js';
import { listSessions, nativeSessionsDir, newestProjectSession, resolveSessionNavigation } from './sessions.js';
import { agentDir } from './settings.js';
import { readBreadcrumb, terminalId, writeBreadcrumb } from './state.js';
import { getOctocodeHome } from '@octocodeai/octocode-shared/paths';
import { runJsonTransport, runPrintTransport, runRpcTransport } from './native-transports.js';
import { withNativeSessionCommunication } from './native-communications.js';
import { createNativeSessionRuntimeRouter } from './native-session-router.js';

const DEFAULT_NATIVE_COMPACTION_INPUT_TOKEN_THRESHOLD = 64_000;
import { NativeAwarenessWorkerLedger } from './native-worker-ledger.js';
import { registerNativeWorkerTool } from './native-worker-tool.js';
import {
  NativeWorkerProcessPort,
  NativeWorkerWorktreePort,
  createNodeNativeWorkerProcessAdapter,
} from './native-workers.js';
import {
  NativeWorkerTransportProjection,
  type NativeWorkerProjectionAuthorizationRequest,
} from './native-worker-projection.js';
import { recoverNativeWorkerOrphans } from './native-worker-recovery.js';
import {
  type OpenTuiTerminal,
  type PresentationEvent,
} from './terminal/opentui/presentation.js';

export interface ParsedNativeArgs {
  mode: 'interactive' | 'print' | 'rpc';
  outputFormat: 'text' | 'json';
  initialMessage?: string;
  session?: string;
  name?: string;
  noSession: boolean;
  continue: boolean;
  accessible: boolean;
  allowWorkers: boolean;
  rest: string[];
}

export interface NativeLaunchDependencies {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
  createRuntime?: (options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    args: ParsedNativeArgs;
    interactions: NativeInteractionBroker;
    onPlanSnapshot?: RuntimePlanSnapshotSink;
    settings: NativeSettingsService;
    extensions: NativeExtensionsController;
    onWorkerProjection?: (projection: NativeWorkerTransportProjection) => void;
    authorizeWorkerProjection?: (request: NativeWorkerProjectionAuthorizationRequest) => Promise<boolean>;
  }) => Promise<AgentRuntime>;
  createTerminal?: () => OpenTuiTerminal;
  createSettingsPage?: (options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    runtime: AgentRuntime;
    settings: NativeSettingsService;
    extensions: NativeExtensionsController;
  }) => NativeSettingsPageController;
  createExtensions?: (options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
  }) => Promise<NativeExtensionsController>;
  createLineReader?: (input: Readable) => AsyncIterable<string>;
  authorizeWorkerProjection?: (request: NativeWorkerProjectionAuthorizationRequest) => Promise<boolean>;
  signalSource?: {
    on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
    off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void;
  };
}

export function parseNativeArgs(argv: readonly string[] = []): ParsedNativeArgs {
  const parsed: ParsedNativeArgs = {
    mode: 'interactive',
    outputFormat: 'text',
    noSession: false,
    continue: false,
    accessible: false,
    allowWorkers: false,
    rest: [],
  };
  let print = false;
  let explicit: 'text' | 'json' | 'rpc' | undefined;
  let positionalOnly = false;
  const appendPositional = (value: string): void => {
    if (parsed.initialMessage === undefined) parsed.initialMessage = value;
    else parsed.rest.push(value);
  };
  const optionValue = (option: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value === '--' || value.startsWith('-')) {
      throw new RuntimeFailure('validation', `Missing value for ${option}`);
    }
    if (!value.trim()) throw new RuntimeFailure('validation', `Invalid value for ${option}`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (positionalOnly) {
      appendPositional(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (arg === '-p' || arg === '--print') {
      print = true;
      continue;
    }
    if (arg === '--accessible') {
      parsed.accessible = true;
      continue;
    }
    if (arg === '--allow-workers') {
      parsed.allowWorkers = true;
      continue;
    }
    if (arg === '--mode') {
      const value = optionValue(arg, index);
      index += 1;
      if (value === 'text' || value === 'json' || value === 'rpc') {
        explicit = value;
        continue;
      }
      throw new RuntimeFailure('validation', `Invalid value for --mode: ${value}`);
    }
    if (arg === '--no-session') {
      parsed.noSession = true;
      continue;
    }
    if (arg === '-c' || arg === '--continue') {
      parsed.continue = true;
      continue;
    }
    if (arg === '--session' || arg === '--name' || arg === '-n') {
      const value = optionValue(arg, index);
      index += 1;
      if (arg === '--session') parsed.session = value;
      else parsed.name = value;
      continue;
    }
    if (arg.startsWith('-')) throw new RuntimeFailure('validation', `Unknown native option: ${arg}`);
    appendPositional(arg);
  }
  if (explicit === 'rpc') parsed.mode = 'rpc';
  else if (print || explicit === 'text' || explicit === 'json') parsed.mode = 'print';
  if (explicit === 'json') parsed.outputFormat = 'json';
  return parsed;
}

function configuredApiKey(env: NodeJS.ProcessEnv, protocol: NativeProviderProtocol): string {
  return env.OCTOCODE_MODEL_API_KEY
    ?? (protocol === 'anthropic-messages' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY)
    ?? '';
}

export function resolveNativeSessionId(
  args: ParsedNativeArgs,
  cwd: string,
  sessionsRoot: string,
  now: () => number = Date.now,
  preferredSessionFile?: string,
  nonce: () => string = randomUUID,
): string {
  if (args.noSession) return `memory:${process.pid}`;
  if (args.session) {
    const match = listSessions(sessionsRoot).find((session) => (
      session.key === args.session
      || session.uuid === args.session
      || session.file === args.session
    ));
    if (match) return match.uuid;
    const directFile = path.resolve(args.session);
    const root = path.resolve(sessionsRoot);
    if (path.dirname(directFile) === root && path.basename(directFile).endsWith('.json')) {
      const encoded = path.basename(directFile).slice(0, -'.json'.length);
      try {
        const id = decodeURIComponent(encoded);
        if (fs.existsSync(directFile) || fs.existsSync(`${directFile}.bak`)) return id;
      } catch { /* Invalid encoded session path. */ }
    }
    const primary = path.join(sessionsRoot, `${encodeURIComponent(args.session)}.json`);
    if (fs.existsSync(primary) || fs.existsSync(`${primary}.bak`)) return args.session;
    throw new Error(`Native session not found: ${args.session}`);
  }
  if (args.continue) {
    if (preferredSessionFile) {
      const preferred = listSessions(sessionsRoot).find((session) => session.file === preferredSessionFile);
      if (preferred) return preferred.uuid;
    }
    const latest = newestProjectSession(cwd, sessionsRoot);
    if (latest) return latest.uuid;
  }
  return `native:${now()}:${nonce()}`;
}

export function resolveNativeWorkspaceTrust(
  cwd: string,
  values: Record<string, unknown>,
): 'trusted' | 'untrusted' | 'unknown' {
  const configured = values.workspaceTrust;
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) return 'unknown';
  const canonical = (() => {
    try { return fs.realpathSync(cwd); }
    catch { return path.resolve(cwd); }
  })();
  for (const [workspace, trust] of Object.entries(configured as Record<string, unknown>)) {
    let candidate: string;
    try { candidate = fs.realpathSync(workspace); }
    catch { candidate = path.resolve(workspace); }
    if (candidate === canonical) return trust === 'trusted' || trust === 'untrusted' ? trust : 'unknown';
  }
  return 'unknown';
}

export interface NativeWorkerCapabilityEnvelope {
  readonly allowedTools?: ReadonlySet<string>;
  readonly allowedModels?: readonly { readonly providerId: string; readonly modelId: string }[];
  readonly maxTurns?: number;
}

export function resolveNativeWorkerCapabilities(env: NodeJS.ProcessEnv): NativeWorkerCapabilityEnvelope {
  const parse = (key: string): unknown => {
    const encoded = env[key];
    if (encoded === undefined) return undefined;
    try { return JSON.parse(encoded) as unknown; }
    catch { throw new RuntimeFailure('adapter-compatibility', `Native worker ${key} is malformed`); }
  };
  const rawTools = parse('OCTOCODE_WORKER_ALLOWED_TOOLS');
  const rawModels = parse('OCTOCODE_WORKER_ALLOWED_MODELS');
  const rawTurns = env.OCTOCODE_WORKER_MAX_TURNS;
  if (rawTools !== undefined && (!Array.isArray(rawTools) || rawTools.length > 128 || rawTools.some((tool) => typeof tool !== 'string' || !tool.trim()))) {
    throw new RuntimeFailure('adapter-compatibility', 'Native worker tool capabilities are invalid');
  }
  if (rawModels !== undefined && (!Array.isArray(rawModels) || rawModels.length > 64 || rawModels.some((model) => (
    typeof model !== 'object' || model === null || Array.isArray(model)
    || typeof (model as { providerId?: unknown }).providerId !== 'string'
    || !(model as { providerId: string }).providerId.trim()
    || typeof (model as { modelId?: unknown }).modelId !== 'string'
    || !(model as { modelId: string }).modelId.trim()
  )))) throw new RuntimeFailure('adapter-compatibility', 'Native worker model capabilities are invalid');
  const maxTurns = rawTurns === undefined ? undefined : Number(rawTurns);
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 1_000)) {
    throw new RuntimeFailure('adapter-compatibility', 'Native worker turn capability is invalid');
  }
  return Object.freeze({
    ...(rawTools === undefined ? {} : { allowedTools: new Set(rawTools as string[]) }),
    ...(rawModels === undefined ? {} : { allowedModels: Object.freeze((rawModels as { providerId: string; modelId: string }[]).map((model) => Object.freeze({ ...model }))) }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
}

export function createNativeSessionEffectLedger(
  sessions: SessionStore,
  activeSessionId: SessionId,
  now: () => number = Date.now,
): EffectLedgerPort {
  const parseRecord = (value: unknown): EffectLedgerRecord | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const candidate = value as { key?: unknown; state?: unknown; updatedAt?: unknown; receipt?: unknown };
    const receipt = candidate.receipt;
    if (
      typeof candidate.key !== 'string'
      || !['started', 'committed', 'failed', 'cancelled', 'uncertain'].includes(String(candidate.state))
      || typeof candidate.updatedAt !== 'number'
      || typeof receipt !== 'object'
      || receipt === null
      || Array.isArray(receipt)
      || (receipt as { schemaVersion?: unknown }).schemaVersion !== 1
      || typeof (receipt as { operation?: unknown }).operation !== 'string'
      || !Array.isArray((receipt as { effects?: unknown }).effects)
      || (receipt as { effects: unknown[] }).effects.length === 0
      || typeof (receipt as { policy?: unknown }).policy !== 'object'
      || (receipt as { policy?: unknown }).policy === null
    ) return undefined;
    return candidate as EffectLedgerRecord;
  };
  const read = async (key: string): Promise<EffectLedgerRecord | undefined> => {
    const loaded = await sessions.load(activeSessionId);
    const value = [...loaded.projection.customEntries].reverse().find((entry) => entry.kind === 'native.effect.ledger'
      && typeof entry.value === 'object' && entry.value !== null && !Array.isArray(entry.value)
      && (entry.value as { key?: unknown }).key === key)?.value;
    return parseRecord(value);
  };
  return {
    get: read,
    begin: async (key, receipt) => {
      for (let retry = 0; retry < 3; retry += 1) {
        const loaded = await sessions.load(activeSessionId);
        const existingValue = [...loaded.projection.customEntries].reverse().find((entry) => entry.kind === 'native.effect.ledger'
          && typeof entry.value === 'object' && entry.value !== null && !Array.isArray(entry.value)
          && (entry.value as { key?: unknown }).key === key)?.value;
        const existing = parseRecord(existingValue);
        if (existing !== undefined) return isDeepStrictEqual(existing.receipt, receipt) ? existing.state : 'mismatch';
        const updatedAt = now();
        const sequence = Number(loaded.projection.revision) + 1;
        const record: EffectLedgerRecord = { key, state: 'started', updatedAt, receipt };
        const event: SessionEvent = {
          schemaVersion: 1, sessionId: activeSessionId,
          eventId: sessionEventId(`${activeSessionId}:effect:${sequence}`), revision: revision(String(sequence)),
          sequence, timestamp: updatedAt, visibility: 'internal',
          event: { type: 'custom.appended', kind: 'native.effect.ledger', value: record },
        };
        try { await sessions.append(activeSessionId, loaded.projection.revision, [event]); return 'acquired'; }
        catch (error) { if (!(error instanceof RuntimeFailure) || error.category !== 'session-conflict' || retry === 2) throw error; }
      }
      throw new RuntimeFailure('session-conflict', `Unable to admit effect ${key}`, 'safe');
    },
    settle: async (key, state) => {
      for (let retry = 0; retry < 3; retry += 1) {
        const loaded = await sessions.load(activeSessionId);
        const existingValue = [...loaded.projection.customEntries].reverse().find((entry) => entry.kind === 'native.effect.ledger'
          && typeof entry.value === 'object' && entry.value !== null && !Array.isArray(entry.value)
          && (entry.value as { key?: unknown }).key === key)?.value;
        const existing = parseRecord(existingValue);
        if (existing === undefined) throw new RuntimeFailure('internal-invariant', `Effect ${key} was not admitted`);
        if (existing.state !== 'started') {
          if (existing.state === state) return;
          throw new RuntimeFailure('conflict', `Effect ${key} is already terminal with state ${existing.state}`);
        }
        const updatedAt = now();
        const sequence = Number(loaded.projection.revision) + 1;
        const record: EffectLedgerRecord = { ...existing, state, updatedAt };
        const event: SessionEvent = {
          schemaVersion: 1, sessionId: activeSessionId,
          eventId: sessionEventId(`${activeSessionId}:effect:${sequence}`), revision: revision(String(sequence)),
          sequence, timestamp: updatedAt, visibility: 'internal',
          event: { type: 'custom.appended', kind: 'native.effect.ledger', value: record },
        };
        try { await sessions.append(activeSessionId, loaded.projection.revision, [event]); return; }
        catch (error) { if (!(error instanceof RuntimeFailure) || error.category !== 'session-conflict' || retry === 2) throw error; }
      }
      throw new RuntimeFailure('session-conflict', `Unable to settle effect ${key}`, 'safe');
    },
  };
}

export function createRuntimeEventPersister(options: {
  sessions: SessionStore;
  activeSessionId: SessionId;
  initialRevision: Revision;
  lifecycle?: Map<RuntimeEvent['type'], LifecycleBus<unknown>>;
  onRuntimeStopping?: () => Promise<void>;
}): (runtimeEvent: RuntimeEvent) => Promise<LifecycleDispatchResult<unknown>> {
  let storedRevision = options.initialRevision;
  const lifecycle = options.lifecycle ?? new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
  const assistantChunks: string[] = [];
  const assistantToolCalls: ModelToolCall[] = [];
  const pendingToolCalls = new Map<string, string>();
  const requestedToolCalls = new Set<string>();
  const pendingLifecycleContext: string[] = [];
  let assistantMessageEnded = false;
  let runtimeCleanupStarted = false;

  const dispatch = async (runtimeEvent: RuntimeEvent): Promise<LifecycleDispatchResult<unknown>> => {
    let bus = lifecycle.get(runtimeEvent.type);
    if (!bus) {
      bus = new LifecycleBus({ eventType: runtimeEvent.type, authority: ['observe'], validate: (_payload): _payload is unknown => true });
      lifecycle.set(runtimeEvent.type, bus);
    }
    return await bus.dispatch(runtimeEvent);
  };
  const append = async (
    runtimeEvent: RuntimeEvent,
    storedEvent: SessionEvent['event'],
    visibility: SessionEvent['visibility'],
  ): Promise<void> => {
    await appendBatch(runtimeEvent, [{ event: storedEvent, visibility }]);
  };
  const appendBatch = async (
    runtimeEvent: RuntimeEvent,
    records: readonly { event: SessionEvent['event']; visibility: SessionEvent['visibility']; causationId?: string }[],
  ): Promise<void> => {
    storedRevision = (await options.sessions.load(options.activeSessionId)).projection.revision;
    const baseSequence = Number(storedRevision);
    const entries = records.map((record, index): SessionEvent => {
      const sequence = baseSequence + index + 1;
      return {
        schemaVersion: 1,
        sessionId: options.activeSessionId,
        eventId: sessionEventId(`${options.activeSessionId}:runtime-event:${sequence}`),
        revision: revision(String(sequence)),
        sequence,
        timestamp: runtimeEvent.timestamp,
        visibility: record.visibility,
        ...(record.causationId ? { causationId: record.causationId } : {}),
        event: record.event,
      };
    });
    storedRevision = await options.sessions.append(options.activeSessionId, storedRevision, entries);
  };
  const flushAssistant = async (runtimeEvent: RuntimeEvent): Promise<void> => {
    if (assistantChunks.length === 0 && assistantToolCalls.length === 0) return;
    const content = assistantChunks.join('');
    const toolCalls = assistantToolCalls.splice(0);
    assistantChunks.length = 0;
    assistantMessageEnded = false;
    requestedToolCalls.clear();
    for (const call of toolCalls) pendingToolCalls.set(call.id, call.name);
    await append(runtimeEvent, { type: 'message.appended', role: 'assistant', content, ...(toolCalls.length === 0 ? {} : { toolCalls }) }, 'model');
  };
  const discardAssistant = (): void => {
    assistantChunks.length = 0;
    assistantToolCalls.length = 0;
    assistantMessageEnded = false;
    requestedToolCalls.clear();
  };
  const appendToolResult = async (
    runtimeEvent: RuntimeEvent,
    callId: string,
    content: unknown,
  ): Promise<boolean> => {
    if (!pendingToolCalls.has(callId)) return false;
    pendingToolCalls.delete(callId);
    await append(runtimeEvent, {
      type: 'message.appended',
      role: 'tool',
      toolCallId: callId,
      content: JSON.stringify(content) ?? 'null',
    }, 'model');
    return true;
  };
  const cancelPendingToolCalls = async (runtimeEvent: RuntimeEvent, reason: string): Promise<void> => {
    for (const callId of [...pendingToolCalls.keys()]) {
      await appendToolResult(runtimeEvent, callId, { error: reason, category: 'cancelled' });
    }
  };
  const flushLifecycleContext = async (runtimeEvent: RuntimeEvent): Promise<void> => {
    if (pendingToolCalls.size > 0 || pendingLifecycleContext.length === 0) return;
    for (const context of pendingLifecycleContext.splice(0)) {
      await append(runtimeEvent, { type: 'message.appended', role: 'system', content: context }, 'model');
    }
  };

  return async (runtimeEvent: RuntimeEvent): Promise<LifecycleDispatchResult<unknown>> => {
    let lifecycleResult = await dispatch(runtimeEvent);
    if (runtimeEvent.type === 'tool.requested') {
      const original = runtimeEvent.payload as Record<string, unknown>;
      const rewritten = lifecycleResult.payload;
      if (typeof original.callId !== 'string') throw new RuntimeFailure('validation', 'tool.requested requires a callId');
      if (typeof rewritten !== 'object' || rewritten === null || Array.isArray(rewritten)) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload must be an object');
      const candidate = rewritten as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || !candidate.name.trim()) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload requires a non-empty name');
      if (!('input' in candidate)) throw new RuntimeFailure('validation', 'tool.requested lifecycle payload requires input');
      lifecycleResult = { ...lifecycleResult, payload: { ...candidate, callId: original.callId } };
    }
    runtimeEvent = lifecycleResult.payload === runtimeEvent.payload
      ? runtimeEvent
      : { ...runtimeEvent, payload: lifecycleResult.payload } as RuntimeEvent;
    const payload = runtimeEvent.payload as Record<string, unknown>;
    if (runtimeEvent.type === 'message.delta') {
      if (payload.type === 'text' && typeof payload.text === 'string') assistantChunks.push(payload.text);
      else if (payload.type === 'tool-call' && typeof payload.id === 'string' && typeof payload.name === 'string') {
        assistantToolCalls.push({ id: payload.id, name: payload.name, input: payload.input });
      }
      return lifecycleResult;
    }
    if (runtimeEvent.type === 'message.ended') {
      if (payload.status === 'cancelled' || payload.status === 'error') discardAssistant();
      else if (assistantToolCalls.length === 0) await flushAssistant(runtimeEvent);
      else assistantMessageEnded = true;
    } else if (runtimeEvent.type === 'turn.ended') {
      if (payload.stop === 'cancelled' || payload.stop === 'error') {
        if (assistantMessageEnded && assistantToolCalls.length > 0) await flushAssistant(runtimeEvent);
        else discardAssistant();
      }
      else await flushAssistant(runtimeEvent);
    } else if (runtimeEvent.type === 'runtime.failed' || runtimeEvent.type === 'runtime.stopping') {
      discardAssistant();
    }

    if (runtimeEvent.type === 'tool.requested' && typeof payload.callId === 'string') {
      const call = assistantToolCalls.find((candidate) => candidate.id === payload.callId);
      if (!call) throw new RuntimeFailure('internal-invariant', `tool.requested has no buffered assistant call: ${payload.callId}`);
      const index = assistantToolCalls.indexOf(call);
      assistantToolCalls[index] = { id: call.id, name: payload.name as string, input: payload.input };
      requestedToolCalls.add(call.id);
      pendingLifecycleContext.push(...lifecycleResult.context);
      if (assistantMessageEnded && requestedToolCalls.size === assistantToolCalls.length) await flushAssistant(runtimeEvent);
    }

    if (runtimeEvent.type === 'tool.blocked' && typeof payload.callId === 'string') {
      if (assistantMessageEnded && assistantToolCalls.length > 0) await flushAssistant(runtimeEvent);
      await appendToolResult(runtimeEvent, payload.callId, {
        error: typeof payload.error === 'string' ? payload.error : 'Tool call blocked',
        ...(typeof payload.category === 'string' ? { category: payload.category } : {}),
      });
      await flushLifecycleContext(runtimeEvent);
      return lifecycleResult;
    }
    if (runtimeEvent.type === 'tool.ended' && typeof payload.callId === 'string') {
      if (assistantMessageEnded && assistantToolCalls.length > 0) await flushAssistant(runtimeEvent);
      const appended = await appendToolResult(runtimeEvent, payload.callId, payload.result === undefined ? { error: payload.error } : payload.result);
      if (!appended) await append(runtimeEvent, { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload }, 'diagnostics');
      await flushLifecycleContext(runtimeEvent);
      return lifecycleResult;
    }
    if (runtimeEvent.type === 'turn.ended' && payload.stop === 'cancelled') {
      await cancelPendingToolCalls(runtimeEvent, 'Tool call cancelled');
    } else if (runtimeEvent.type === 'runtime.failed') {
      await cancelPendingToolCalls(runtimeEvent, 'Tool call aborted by runtime failure');
    } else if (runtimeEvent.type === 'runtime.stopping') {
      await cancelPendingToolCalls(runtimeEvent, 'Tool call cancelled during runtime shutdown');
    }
    await flushLifecycleContext(runtimeEvent);
    if (runtimeEvent.type === 'context.appended') {
      const eventId = typeof payload.eventId === 'string' ? payload.eventId.trim() : '';
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!eventId || !text || payload.provenance !== 'peer-attributed-data') {
        throw new RuntimeFailure('validation', 'context.appended requires attributed peer context identity');
      }
      await appendBatch(runtimeEvent, [
        { event: { type: 'message.appended', role: 'system', content: text }, visibility: 'model', causationId: eventId },
        { event: { type: 'custom.appended', kind: 'native.context.event', value: { eventId, provenance: payload.provenance } }, visibility: 'internal', causationId: eventId },
      ]);
      return lifecycleResult;
    }
    const modelVisibleInputText = runtimeEvent.type === 'input.received'
      && lifecycleResult.decision.kind === 'continue'
      && typeof payload.text === 'string'
      ? payload.text
      : undefined;
    const storedEvent: SessionEvent['event'] = modelVisibleInputText !== undefined
      ? { type: 'message.appended', role: 'user', content: modelVisibleInputText }
      : { type: 'custom.appended', kind: runtimeEvent.type, value: runtimeEvent.payload };
    await append(
      runtimeEvent,
      storedEvent,
      modelVisibleInputText !== undefined ? 'model' : 'diagnostics',
    );
    if (runtimeEvent.type === 'runtime.stopping' && !runtimeCleanupStarted) {
      runtimeCleanupStarted = true;
      await options.onRuntimeStopping?.();
    }
    return lifecycleResult;
  };
}

export function createNativeSessionStore(noSession: boolean, sessionsRoot: string): SessionStore {
  return noSession
    ? new InMemorySessionStore()
    : new TransactionalSessionStore(new FileSessionRecordPort(sessionsRoot));
}

function repairInterruptedToolCalls(messages: readonly ModelMessage[]): ModelMessage[] {
  const repaired: ModelMessage[] = [];
  const pending = new Map<string, string>();
  const flush = (): void => {
    for (const callId of pending.keys()) {
      repaired.push({
        role: 'tool',
        toolCallId: callId,
        content: JSON.stringify({ error: { category: 'cancelled', message: 'Tool call interrupted before completion' } }),
      });
    }
    pending.clear();
  };
  for (const message of messages) {
    if (pending.size > 0 && message.role !== 'tool') flush();
    if (message.role === 'assistant') {
      repaired.push(message);
      for (const call of message.toolCalls ?? []) pending.set(call.id, call.name);
    } else if (message.role === 'tool') {
      if (!pending.has(message.toolCallId)) continue;
      repaired.push(message);
      pending.delete(message.toolCallId);
    } else repaired.push(message);
  }
  flush();
  return repaired;
}

export function retainedCompactionEventIds(
  messages: readonly (ModelMessage & { readonly eventId: SessionEventId })[],
  tailSize = 4,
): SessionEventId[] {
  const retained = new Set<number>();
  for (let index = Math.max(0, messages.length - tailSize); index < messages.length; index += 1) retained.add(index);
  const assistantByCall = new Map<string, number>();
  const resultByCall = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) assistantByCall.set(call.id, index);
    else if (message.role === 'tool') resultByCall.set(message.toolCallId, index);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of [...retained]) {
      const message = messages[index]!;
      if (message.role === 'tool') {
        const assistant = assistantByCall.get(message.toolCallId);
        if (assistant === undefined) { retained.delete(index); changed = true; }
        else if (!retained.has(assistant)) { retained.add(assistant); changed = true; }
      } else if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) {
          const result = resultByCall.get(call.id);
          if (result !== undefined && !retained.has(result)) { retained.add(result); changed = true; }
        }
      }
    }
  }
  return [...retained].sort((left, right) => left - right).map((index) => messages[index]!.eventId);
}

function nativePlanInteraction(interactions: NativeInteractionBroker): NativePlanInteraction {
  return async (request, signal) => {
    if (request.action === 'propose') {
      const response = await interactions.interact({ type: 'confirm', message: 'Approve this plan?' }, signal);
      if (response.status === 'accepted' && response.value === true) return { status: 'approved' };
      if (response.status === 'accepted' && response.value === false) return { status: 'rejected', reason: 'Plan was rejected' };
      return { status: 'pending', correlationId: response.status };
    }
    const answers: string[] = [];
    for (const question of request.questions ?? []) {
      const response = await interactions.interact({ type: 'input', message: question.prompt }, signal);
      if (response.status !== 'accepted' || typeof response.value !== 'string') {
        return { status: 'pending', correlationId: response.status };
      }
      answers.push(response.value);
    }
    return { status: 'answered', answers };
  };
}

export async function createDefaultNativeRuntime(options: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  args: ParsedNativeArgs;
  model?: ModelPort;
  tools?: ToolRegistry;
  interactions?: NativeInteractionBroker;
  onPlanSnapshot?: RuntimePlanSnapshotSink;
  settings?: NativeSettingsService;
  extensions?: NativeExtensionsController;
  onWorkerProjection?: (projection: NativeWorkerTransportProjection) => void;
  authorizeWorkerProjection?: (request: NativeWorkerProjectionAuthorizationRequest) => Promise<boolean>;
  /** Internal recursion guard: build exactly one immutable session runtime. */
  fixedSessionId?: SessionId;
}): Promise<AgentRuntime> {
  const workerCapabilities = resolveNativeWorkerCapabilities(options.env);
  const sessionsRoot = nativeSessionsDir(options.env);
  const terminal = terminalId(options.env);
  const breadcrumb = options.args.continue && terminal ? readBreadcrumb(getOctocodeHome(options.env), terminal) : null;
  const activeSessionId = options.fixedSessionId
    ?? sessionId(resolveNativeSessionId(options.args, options.cwd, sessionsRoot, Date.now, breadcrumb?.sessionFile));
  if (options.fixedSessionId === undefined && !options.args.noSession && options.tools === undefined) {
    const sessions = createNativeSessionStore(false, sessionsRoot);
    const controller = new SessionController(sessions);
    const candidates = new Map<string, {
      committed: boolean;
      worker?: NativeWorkerTransportProjection;
      plan?: RuntimePlanSnapshot;
    }>();
    const commitCandidate = (id: SessionId): void => {
      for (const candidate of candidates.values()) candidate.committed = false;
      const candidate = candidates.get(String(id));
      if (candidate === undefined) return;
      candidate.committed = true;
      if (candidate.worker !== undefined) options.onWorkerProjection?.(candidate.worker);
      if (candidate.plan !== undefined) options.onPlanSnapshot?.(candidate.plan);
    };
    const router = await createNativeSessionRuntimeRouter({
      controller,
      initialSessionId: activeSessionId,
      createRuntime: async ({ sessionId: nextSessionId }) => {
        const candidate: { committed: boolean; worker?: NativeWorkerTransportProjection; plan?: RuntimePlanSnapshot } = { committed: false };
        candidates.set(String(nextSessionId), candidate);
        try {
          return await createDefaultNativeRuntime({
            ...options,
            fixedSessionId: nextSessionId,
            args: { ...options.args, session: String(nextSessionId), continue: false },
            onWorkerProjection: (projection) => {
              candidate.worker = projection;
              if (candidate.committed) options.onWorkerProjection?.(projection);
            },
            onPlanSnapshot: (snapshot) => {
              candidate.plan = snapshot;
              if (candidate.committed) options.onPlanSnapshot?.(snapshot);
            },
          });
        } catch (error) {
          if (candidates.get(String(nextSessionId)) === candidate) candidates.delete(String(nextSessionId));
          throw error;
        }
      },
      resolveNavigation: ({ current, direction }) => {
        const target = resolveSessionNavigation(String(current), direction, options.cwd, sessionsRoot);
        return target === null ? null : sessionId(target);
      },
      onTransition: ({ sessionId: nextSessionId }) => commitCandidate(nextSessionId),
    });
    commitCandidate(activeSessionId);
    return router;
  }
  const home = agentDir(options.env);
  const settingsStorage = new FileSettingsStorage(path.join(home, 'settings.json'));
  const persistedSettings = settingsStorage.read();
  const settings = options.settings ?? await createNativeSettingsService(settingsStorage);
  const workspaceTrust = resolveNativeWorkspaceTrust(options.cwd, persistedSettings.values);
  const interactions = options.interactions ?? createNativeInteractionBroker();
  const configuredModelValue = settings.snapshot().values.find(({ key }) => key === 'defaultModel')?.value;
  const configuredProviderValue = settings.snapshot().values.find(({ key }) => key === 'defaultProvider')?.value;
  const configuredModel = typeof configuredModelValue === 'string' ? configuredModelValue : undefined;
  const configuredProvider = typeof configuredProviderValue === 'string' ? configuredProviderValue : undefined;
  const modelConfiguration = resolveNativeModelConfiguration({
    env: options.env,
    configuredProvider,
    configuredModel,
  });
  const modelEndpoint = modelConfiguration.endpoint;
  const modelProtocol = modelConfiguration.protocol;
  const { providerId, modelId: effectiveModel } = modelConfiguration.selection;
  if (workerCapabilities.allowedModels !== undefined && !workerCapabilities.allowedModels.some((model) => (
    model.providerId === providerId && model.modelId === effectiveModel
  ))) throw new RuntimeFailure('adapter-compatibility', 'Native worker model is outside its delegated capabilities');
  const planStore = options.args.noSession
    ? new InMemoryPlanStore()
    : new FilePlanStore(path.join(home, 'plans'));
  const planScope = { sessionId: String(activeSessionId), workspace: options.cwd };
  const planState = planStore instanceof FilePlanStore
    ? new FileBackedRuntimePlanState(planStore, planScope)
    : new LiveRuntimePlanState();
  const storedPlan = await planStore.load(planScope);
  if (storedPlan !== undefined) {
    planState.update({
      authority: 'runtime',
      revision: storedPlan.revision,
      active: storedPlan.phase === 'active',
    });
    try { options.onPlanSnapshot?.(projectRuntimePlanSnapshot(storedPlan)); }
    catch {
      // Presentation observers are not part of durable plan hydration.
    }
  }
  const capabilityComposition = createNativeCapabilityComposition({
    cwd: options.cwd,
    env: options.env,
    interactions,
    workspaceTrust,
  });
  const tools = options.tools ?? await createDefaultOctocodeToolRegistry({
    cwd: options.cwd,
    env: options.env,
    ...capabilityComposition,
    plan: {
      store: planStore,
      planState,
      interact: nativePlanInteraction(interactions),
      ...(options.onPlanSnapshot === undefined ? {} : { onSnapshot: options.onPlanSnapshot }),
    },
    ...(workerCapabilities.allowedTools === undefined ? {} : { allowedTools: workerCapabilities.allowedTools }),
  });
  if (
    tools.get('askUser') === undefined
    && (workerCapabilities.allowedTools === undefined || workerCapabilities.allowedTools.has('askUser'))
  ) registerNativeAskUserTool(tools, interactions);
  const policy = new PolicyChain();
  policy.use('native-effect-boundary', async (request) => (
    nativeEffectAllowed(request)
      ? { effect: 'allow' }
      : { effect: 'deny', reason: `Native ${request.effects.join('+')} effects require an explicit approved adapter`, category: 'approval' }
  ));
  const lifecycle = new Map<RuntimeEvent['type'], LifecycleBus<unknown>>();
  const mcpHookExecutor = createNativeHookMcpExecutor(tools);
  const disposeHooks = options.extensions === undefined
    ? undefined
    : installNativeHookDispatcher({
        extensions: options.extensions,
        lifecycle,
        executor: new NativeHookCommandExecutor({ cwd: options.cwd, allowShell: true }),
        ...(mcpHookExecutor === undefined ? {} : { mcpExecutor: mcpHookExecutor }),
        workspaceTrusted: workspaceTrust === 'trusted',
      });
  const sessions = createNativeSessionStore(options.args.noSession, sessionsRoot);
  let storedRevision = revision('0');
  let initialMessages: Parameters<typeof createRuntimeKernel>[0]['initialMessages'] = [];
  let initialContextEventIds: string[] = [];
  let storedPrompt: NativePromptRecord | undefined;
  let storedPromptTrust: 'trusted' | 'untrusted' | 'unknown' | undefined;
  let storedCwd = false;
  let activePrompt: NativePromptRecord | undefined;
  try {
    const loaded = await sessions.load(activeSessionId);
    storedRevision = loaded.projection.revision;
    storedPrompt = [...loaded.projection.customEntries]
      .reverse()
      .find((entry) => entry.kind === 'native.prompt.snapshot')
      ?.value as NativePromptRecord | undefined;
    storedPrompt = parseNativePromptRecord(storedPrompt);
    const promptTrustValue = [...loaded.projection.customEntries]
      .reverse()
      .find((entry) => entry.kind === 'native.prompt.workspace-trust')
      ?.value;
    storedPromptTrust = promptTrustValue === 'trusted' || promptTrustValue === 'untrusted' || promptTrustValue === 'unknown'
      ? promptTrustValue
      : undefined;
    storedCwd = loaded.projection.customEntries.some((entry) => entry.kind === 'session.cwd' && typeof entry.value === 'string');
    const currentPrompt = nativePromptRecord(buildNativePromptSnapshot(options.cwd, {
      includeRepositoryInstructions: workspaceTrust === 'trusted',
    }));
    const storedPromptMatchesTrust = storedPromptTrust === workspaceTrust
      || (storedPromptTrust === undefined && workspaceTrust === 'trusted');
    activePrompt = storedPrompt !== undefined && storedPromptMatchesTrust ? storedPrompt : currentPrompt;
    const retained = loaded.projection.compaction === null
      ? loaded.projection.modelContext
      : loaded.projection.modelContext.filter(({ eventId }) => loaded.projection.compaction!.retainedEventIds.includes(eventId));
    initialMessages = [
      { role: 'system', content: activePrompt.content },
      ...(loaded.projection.compaction === null ? [] : [{ role: 'system' as const, content: `Conversation summary:\n${loaded.projection.compaction.summary}` }]),
      ...repairInterruptedToolCalls(retained.map(({ eventId: _eventId, ...message }) => message)),
    ];
    initialContextEventIds = loaded.projection.customEntries
      .filter((entry) => entry.kind === 'native.context.event')
      .map((entry) => entry.value)
      .filter((value): value is { eventId: string } => (
        typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as { eventId?: unknown }).eventId === 'string'
      ))
      .map(({ eventId }) => eventId);
  } catch {
    // The transactional store reports corrupt state; do not silently overwrite it.
    throw new Error(`Unable to load native session ${activeSessionId}`);
  }
  const expectedWorkerPrompt = options.env.OCTOCODE_EXPECTED_PROMPT_SHA256?.trim();
  if (expectedWorkerPrompt !== undefined && expectedWorkerPrompt !== activePrompt!.sha256) {
    throw new RuntimeFailure('adapter-compatibility', 'Native worker prompt snapshot mismatch');
  }
  let workerSupervisor: WorkerSupervisor | undefined;
  if (options.env.OCTOCODE_NATIVE_WORKER !== '1' && options.tools === undefined) {
    const workerLedger = new NativeAwarenessWorkerLedger({ workspace: options.cwd, env: options.env });
    if (!options.args.noSession) await recoverNativeWorkerOrphans({
      workspace: options.cwd,
      sessionId: String(activeSessionId),
      env: options.env,
    });
    const entry = process.argv[1];
    if (entry === undefined || !entry.trim()) throw new RuntimeFailure('adapter-compatibility', 'Native worker entry point is unavailable');
    const availableTools = tools.list().map(({ name }) => name).filter((name) => name !== 'worker');
    const preferredDefaults = [
      'localSearchCode', 'localViewStructure', 'localFindFiles', 'localGetFileContent', 'lspGetSemantics', 'awareness',
    ].filter((name) => availableTools.includes(name));
    const workerWorktreesRoot = path.join(
      getOctocodeHome(options.env),
      'worker-worktrees',
      encodeURIComponent(String(activeSessionId)),
    );
    workerSupervisor = new WorkerSupervisor({
      port: new NativeWorkerProcessPort({
        process: createNodeNativeWorkerProcessAdapter(),
        command: process.execPath,
        argvPrefix: [entry],
        cwd: options.cwd,
        env: options.env,
        parentAgentId: options.env.OCTOCODE_AGENT_ID,
        worktreesRoot: workerWorktreesRoot,
        onProcessStarted: (packet, identity) => workerLedger.recordProcess(packet, identity),
      }),
      ledger: workerLedger,
      worktrees: new NativeWorkerWorktreePort({
        repositoryRoot: options.cwd,
        worktreesRoot: workerWorktreesRoot,
      }),
      maxActive: 4,
    });
    options.onWorkerProjection?.(new NativeWorkerTransportProjection(workerSupervisor, {
      activeSessionId,
      promptSnapshotId: activePrompt!.sha256,
      capabilities: {
        tools: availableTools,
        models: [{ providerId, modelId: effectiveModel }],
        maxTurns: 16,
      },
      authorize: async ({ command }) => {
        if (workspaceTrust !== 'trusted') return false;
        if (options.authorizeWorkerProjection !== undefined) return options.authorizeWorkerProjection({
          sessionId: activeSessionId,
          command,
          policy: { effect: 'process', trust: 'workspace', approval: 'on-request' },
        });
        const result = await interactions.interact({
          type: 'confirm',
          message: `Allow ${command.type} worker process operation?`,
        }, new AbortController().signal);
        return result.status === 'accepted' && result.value === true;
      },
    }));
    registerNativeWorkerTool(tools, {
      controller: workerSupervisor,
      promptSnapshotId: activePrompt!.sha256,
      allowedTools: availableTools,
      defaultTools: preferredDefaults,
      allowedModels: [{ providerId, modelId: effectiveModel }],
      defaultModel: { providerId, modelId: effectiveModel },
      defaultMaxTurns: 16,
      allowWorktree: true,
    });
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
      {
        schemaVersion: 1,
        sessionId: activeSessionId,
        eventId: sessionEventId(`${activeSessionId}:prompt`),
        revision: revision('3'),
        sequence: 3,
        timestamp,
        visibility: 'internal',
        event: { type: 'custom.appended', kind: 'native.prompt.snapshot', value: activePrompt! },
      },
      {
        schemaVersion: 1,
        sessionId: activeSessionId,
        eventId: sessionEventId(`${activeSessionId}:prompt-trust`),
        revision: revision('4'),
        sequence: 4,
        timestamp,
        visibility: 'internal',
        event: { type: 'custom.appended', kind: 'native.prompt.workspace-trust', value: workspaceTrust },
      },
    ];
    storedRevision = await sessions.append(activeSessionId, storedRevision, created);
  } else if (!storedCwd || storedPrompt?.sha256 !== activePrompt!.sha256 || storedPromptTrust !== workspaceTrust) {
    const additions: SessionEvent[] = [];
    const add = (kind: string, value: unknown): void => {
      const sequence = Number(storedRevision) + additions.length + 1;
      additions.push({
        schemaVersion: 1,
        sessionId: activeSessionId,
        eventId: sessionEventId(`${activeSessionId}:${kind}:${sequence}`),
        revision: revision(String(sequence)),
        sequence,
        timestamp: Date.now(),
        visibility: 'internal',
        event: { type: 'custom.appended', kind, value },
      });
    };
    if (!storedCwd) add('session.cwd', options.cwd);
    if (storedPrompt?.sha256 !== activePrompt!.sha256) add('native.prompt.snapshot', activePrompt!);
    if (storedPromptTrust !== workspaceTrust) add('native.prompt.workspace-trust', workspaceTrust);
    storedRevision = await sessions.append(activeSessionId, storedRevision, additions);
  }
  if (!options.args.noSession) {
    const sessionFile = new FileSessionRecordPort(sessionsRoot).pathFor(activeSessionId);
    recordSession(openOctocodeDb(octocodeDbPath(options.env)), {
      sessionId: activeSessionId,
      workspacePath: options.cwd,
      cwd: options.cwd,
    });
    if (terminal) writeBreadcrumb(getOctocodeHome(options.env), terminal, { sessionFile, cwd: options.cwd });
  }
  const persistRuntimeEvent = createRuntimeEventPersister({
    sessions,
    activeSessionId,
    initialRevision: storedRevision,
    lifecycle,
    onRuntimeStopping: async () => {
      disposeHooks?.cancel();
      await disposeHooks?.drain();
      await Promise.all([
        closeNativeToolRegistry(tools),
        workerSupervisor?.shutdown('native runtime stopping'),
      ]);
      disposeHooks?.();
    },
  });
  const modelPort = options.model ?? createNativeProviderModelPort(modelProtocol === 'anthropic-messages'
    ? {
        protocol: modelProtocol,
        endpoint: modelEndpoint,
        apiKey: configuredApiKey(options.env, modelProtocol),
        defaultModel: effectiveModel,
        promptCaching: true,
      }
    : {
        protocol: modelProtocol,
        endpoint: modelEndpoint,
        apiKey: configuredApiKey(options.env, modelProtocol),
        defaultModel: effectiveModel,
        ...(new URL(modelEndpoint).hostname === 'api.openai.com' ? { promptCacheKey: `octocode:${activePrompt!.sha256.slice(0, 55)}` } : {}),
      });
  const durableCompaction = new DurableCompactionService({
    store: sessions,
    summarizer: { summarize: async ({ messages, reason, attempt, signal }) => {
      const text: string[] = [];
      const response = await modelPort.run({
        messages: [
          { role: 'system', content: 'Summarize the conversation faithfully for a later agent. Preserve decisions, constraints, unresolved work, file paths, commands, failures, and verification evidence. Return only the summary.' },
          { role: 'user', content: `Compaction reason: ${reason}; attempt: ${attempt}.` },
          ...messages.map(({ eventId: _eventId, ...message }) => message),
        ],
        model: { providerId, modelId: effectiveModel },
        toolChoice: 'none',
      }, { signal, emit: async (delta) => { if (delta.type === 'text') text.push(delta.text); } });
      if (response.stop === 'error' || response.stop === 'tool' || response.stop === 'cancelled') throw new RuntimeFailure('compaction', `Compaction model stopped with ${response.stop}`, 'safe');
      return { summary: text.join('').trim(), retainedEventIds: retainedCompactionEventIds(messages) };
    } },
  });
  const runtime = createRuntimeKernel({
    sessionId: activeSessionId,
    createTurnId: () => turnId(`turn:${randomUUID()}`),
    effectLedger: createNativeSessionEffectLedger(sessions, activeSessionId),
    cwd: options.cwd,
    tools,
    planState,
    policy,
    ...(workerCapabilities.maxTurns === undefined ? {} : { maxIterations: workerCapabilities.maxTurns }),
    mode: options.args.mode === 'print'
      ? options.args.outputFormat === 'json' ? 'json' : 'print'
      : options.args.mode,
    trust: { workspace: workspaceTrust, managedOnly: false },
    approve: async (request) => {
      if (request.name === 'worker' && options.args.allowWorkers && workspaceTrust === 'trusted') return true;
      const result = await interactions.interact({
        type: 'confirm',
        message: nativeToolApprovalMessage(request),
      }, request.signal);
      return result.status === 'accepted' && result.value === true;
    },
    initialMessages,
    initialContextEventIds,
    compactionInputTokenThreshold: DEFAULT_NATIVE_COMPACTION_INPUT_TOKEN_THRESHOLD,
    compaction: {
      compact: async ({ reason, signal }) => {
        const result = await durableCompaction.compact(activeSessionId, reason, signal);
        const loaded = await sessions.load(activeSessionId);
        const retainedIds = new Set(result.retainedEventIds);
        return {
          summary: result.summary,
          messages: [
            { role: 'system', content: activePrompt!.content },
            { role: 'system', content: `Conversation summary:\n${result.summary}` },
            ...repairInterruptedToolCalls(loaded.projection.modelContext.filter(({ eventId }) => retainedIds.has(eventId)).map(({ eventId: _eventId, ...message }) => message)),
          ],
        };
      },
      cancel: (reason) => durableCompaction.cancel(activeSessionId, reason),
    },
    initialModel: { providerId, modelId: effectiveModel },
    validateModel: (model) => modelConfiguration.catalog.providers.some(({ id, enabled }) => id === model.providerId && enabled)
      && modelConfiguration.catalog.models.some(({ providerId: candidateProvider, id, enabled }) => (
        candidateProvider === model.providerId && id === model.modelId && enabled
      ))
      ? undefined
      : `Model ${model.providerId}/${model.modelId} is not available in the effective native model catalog`,
    validateThinking: providerId === 'anthropic'
      ? (level) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)
        ? undefined
        : `Thinking level ${level} is not supported by the Anthropic Messages adapter`
      : () => 'Thinking controls are not supported by the active OpenAI-compatible adapter',
    emit: persistRuntimeEvent,
    model: modelPort,
  });
  const agentId = options.env.OCTOCODE_AGENT_ID?.trim() || `native:${activeSessionId}`;
  return withNativeSessionCommunication(runtime, {
    workspace: options.cwd,
    sessionId: String(activeSessionId),
    agentId,
  });
}

export function nativeEffectAllowed(request: { readonly effects: EffectSet; readonly operation: string }): boolean {
  return request.effects.every((effect) => effect === 'read'
    || effect === 'network'
    || (effect === 'process' && (request.operation === 'tool:MCPTool' || request.operation === 'tool:worker'))
    || (effect === 'write' && (request.operation === 'tool:plan' || request.operation === 'tool:awareness')));
}

export function nativeToolApprovalMessage(request: {
  readonly name: string;
  readonly input: unknown;
  readonly policy: { readonly effects: EffectSet };
}): string {
  const effects = request.policy.effects.join('+');
  if (request.name !== 'MCPTool' || typeof request.input !== 'object' || request.input === null || Array.isArray(request.input)) {
    return `Allow ${request.name} (${effects})?`;
  }
  const input = request.input as Record<string, unknown>;
  const scope = ['server', 'action', 'tool', 'uri']
    .flatMap((key) => typeof input[key] === 'string' && input[key] ? [`${key}=${input[key]}`] : []);
  return `Allow MCP ${scope.join(' ')} (${effects})?`;
}

function presentationEvents(event: RuntimeEvent, activeTurnId?: string): readonly PresentationEvent[] {
  const payload = event.payload as Record<string, unknown>;
  const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
  const name = typeof payload.name === 'string' ? payload.name : 'tool';
  const turn = typeof payload.turnId === 'string'
    ? payload.turnId
    : event.turnId === undefined
      ? activeTurnId
      : String(event.turnId);
  const stringify = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    try { return JSON.stringify(value) ?? String(value); }
    catch { return '[unserializable]'; }
  };
  const errorDetails = (): { message: string; category?: string } => {
    if (typeof payload.error === 'string') return { message: payload.error, ...(typeof payload.category === 'string' ? { category: payload.category } : {}) };
    if (typeof payload.error === 'object' && payload.error !== null) {
      const error = payload.error as Record<string, unknown>;
      return {
        message: typeof error.message === 'string' ? error.message : 'Tool execution failed',
        ...(typeof error.category === 'string' ? { category: error.category } : typeof payload.category === 'string' ? { category: payload.category } : {}),
      };
    }
    return { message: 'Tool execution failed', ...(typeof payload.category === 'string' ? { category: payload.category } : {}) };
  };
  switch (event.type) {
    case 'runtime.ready': return [{ type: 'runtime-ready' }];
    case 'runtime.stopping': return [{ type: 'runtime-stopping' }];
    case 'runtime.failed': return [{ type: 'runtime-failed' }];
    case 'input.received':
      return typeof payload.text === 'string' ? [{ type: 'input-received', text: payload.text, ...(turn === undefined ? {} : { turnId: turn }) }] : [];
    case 'input.queued': {
      const position = typeof payload.position === 'number' ? payload.position : undefined;
      const kind = payload.kind === 'steer' ? 'Steer' : 'Follow-up';
      return [{
        type: 'notification',
        severity: 'info',
        message: `${kind} queued${position === undefined ? '' : ` · position ${position}`}`,
      }];
    }
    case 'input.rejected': {
      const kind = payload.kind === 'steer' ? 'Steer' : 'Follow-up';
      const reason = typeof payload.reason === 'string' ? payload.reason : 'runtime unavailable';
      return [{ type: 'notification', severity: 'error', message: `${kind} rejected · ${reason}` }];
    }
    case 'turn.started':
      return turn === undefined ? [] : [{ type: 'turn-started', turnId: turn }];
    case 'turn.ended': {
      if (turn === undefined) return [];
      const stop = payload.stop;
      return [{ type: 'turn-ended', turnId: turn, outcome: stop === 'cancelled' ? 'cancelled' : stop === 'error' ? 'error' : 'completed' }];
    }
    case 'message.started': {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : String(event.id);
      const role = payload.role === 'user' || payload.role === 'system' || payload.role === 'tool' ? payload.role : 'assistant';
      return [{ type: 'message-started', messageId, role, ...(turn === undefined ? {} : { turnId: turn }) }];
    }
    case 'message.delta':
      return typeof payload.text === 'string' ? [{
        type: 'message-delta',
        text: payload.text,
        messageId: typeof payload.messageId === 'string' ? payload.messageId : `assistant:${turn ?? 'unscoped'}`,
        role: 'assistant',
        ...(turn === undefined ? {} : { turnId: turn }),
        ...(payload.segment === 'thinking' ? { segment: 'thinking' as const } : {}),
      }] : [];
    case 'message.ended': {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : `assistant:${turn ?? 'unscoped'}`;
      return [{ type: 'message-ended', messageId, status: payload.status === 'cancelled' || payload.status === 'error' ? payload.status : 'complete' }];
    }
    case 'tool.requested':
      return callId === undefined ? [] : [{
        type: 'tool-requested', callId, name,
        ...(turn === undefined ? {} : { turnId: turn }),
        ...(payload.input === undefined ? {} : { input: stringify(payload.input) }),
      }];
    case 'tool.started':
      return callId === undefined ? [] : [{ type: 'tool-started', callId, name, ...(turn === undefined ? {} : { turnId: turn }) }];
    case 'tool.updated': {
      const update = typeof payload.update === 'object' && payload.update !== null ? payload.update as Record<string, unknown> : undefined;
      const value = typeof update?.value === 'object' && update.value !== null ? update.value as Record<string, unknown> : undefined;
      return callId === undefined ? [] : [{
        type: 'tool-updated', callId, name,
        ...(typeof update?.message === 'string' ? { message: update.message } : {}),
        ...(typeof value?.current === 'number' ? { current: value.current } : {}),
        ...(typeof value?.total === 'number' ? { total: value.total } : {}),
      }];
    }
    case 'tool.blocked': {
      if (callId === undefined) return [];
      const error = errorDetails();
      return [{ type: 'tool-blocked', callId, name, message: error.message, ...(error.category === undefined ? {} : { category: error.category }) }];
    }
    case 'tool.ended': {
      if (callId === undefined) return [];
      if (payload.outcome === 'cancelled' || payload.category === 'cancelled') {
        const error = errorDetails();
        return [{
          type: 'tool-cancelled', callId, name,
          ...(typeof payload.message === 'string' ? { message: payload.message } : error.message === 'Tool execution failed' ? {} : { message: error.message }),
        }];
      }
      if (payload.error !== undefined) {
        const error = errorDetails();
        return [{ type: 'tool-ended', callId, name, error: error.message, ...(error.category === undefined ? {} : { category: error.category }) }];
      }
      return [{ type: 'tool-ended', callId, name, ...(payload.result === undefined ? {} : { result: stringify(payload.result) }) }];
    }
    case 'context.usage-changed': {
      const inputTokens = typeof payload.inputTokens === 'number' ? payload.inputTokens : undefined;
      const outputTokens = typeof payload.outputTokens === 'number' ? payload.outputTokens : undefined;
      return inputTokens === undefined || outputTokens === undefined ? [] : [{
        type: 'status-changed',
        name: 'context.usage',
        text: `${inputTokens} input · ${outputTokens} output tokens`,
      }];
    }
    case 'provider.response-received': {
      const usage = typeof payload.usage === 'object' && payload.usage !== null ? payload.usage as Record<string, unknown> : undefined;
      const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined;
      const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined;
      return inputTokens === undefined || outputTokens === undefined ? [] : [{
        type: 'status-changed', name: 'context.usage', text: `${inputTokens} input · ${outputTokens} output tokens`,
      }];
    }
    case 'ui.notification': {
      if (typeof payload.message !== 'string') return [];
      const severity = payload.severity;
      return [{
        type: 'notification',
        message: payload.message,
        severity: severity === 'success' || severity === 'warning' || severity === 'error' ? severity : 'info',
      }];
    }
    case 'ui.status-changed':
      return typeof payload.name === 'string'
        ? [{ type: 'status-changed', name: payload.name, text: typeof payload.text === 'string' ? payload.text : undefined }]
        : [];
    default:
      return [];
  }
}

async function runInteractive(
  runtime: AgentRuntime,
  terminal: OpenTuiTerminal,
  interactions: NativeInteractionBroker,
  input: Readable,
  initialMessage?: string,
  createLineReader: (input: Readable) => AsyncIterable<string> = (stream) => createInterface({ input: stream, crlfDelay: Infinity }),
  currentPlan: () => RuntimePlanSnapshot | undefined = () => undefined,
  skills: () => readonly NativeSkillSummary[] = () => [],
  signalSource: NonNullable<NativeLaunchDependencies['signalSource']> = process,
  settingsPage?: NativeSettingsPageController,
): Promise<number> {
  try {
    await terminal.start();
  } catch (startupFailure) {
    await Promise.allSettled([
      Promise.resolve().then(() => runtime.stop()),
      Promise.resolve().then(() => settingsPage?.close()),
      Promise.resolve().then(() => terminal.stop()),
    ]);
    throw startupFailure;
  }
  let detachInteractions: () => void = () => undefined;
  let activeTurnId: string | undefined;
  let submissionInFlight = false;
  let submissionFailure: unknown;
  const submissions = new Set<Promise<void>>();
  const submit = (text: string): void => {
    submissionInFlight = true;
    const task = runtime.submit(text)
      .catch((error) => { submissionFailure ??= error; })
      .finally(() => { submissionInFlight = false; });
    submissions.add(task);
    void task.finally(() => submissions.delete(task));
  };
  let followUps = Promise.resolve();
  const followUp = (text: string): void => {
    const task = followUps.then(async () => {
      const result = await runtime.execute({ type: 'input.follow-up', text });
      if (!result.ok) terminal.accept({
        type: 'notification',
        severity: 'error',
        message: `Follow-up rejected · ${result.error.message}`,
      });
    }).catch((error) => { submissionFailure ??= error; });
    followUps = task;
    submissions.add(task);
    void task.finally(() => submissions.delete(task));
  };
  let chromeConnection: 'connected' | 'connecting' | 'error' = 'connecting';
  let chromeTrust: 'trusted' | 'untrusted' | 'unknown' = 'unknown';
  let runtimeFailed = false;
  const presentChrome = (
    working: 'idle' | 'active' | 'cancelling' | 'failed',
    connection = chromeConnection,
  ): void => {
    chromeConnection = connection;
    const snapshot = runtime.snapshot();
    const interaction = terminal.snapshot()?.interaction;
    const keyHints = interaction === undefined
      ? [
          { key: 'Enter', label: 'Send', priority: 1 },
          { key: 'Ctrl-C', label: 'Cancel or exit', priority: 2 },
          { key: 'Tab', label: 'Move focus', priority: 3 },
          { key: '/', label: 'Commands', priority: 4 },
          { key: '@', label: 'Files', priority: 5 },
        ]
      : [
          { key: 'Enter', label: 'Choose', priority: 1 },
          { key: 'Esc', label: 'Cancel', priority: 2 },
          { key: 'Tab', label: 'Move choice', priority: 3 },
        ];
    terminal.accept({
      type: 'runtime-widgets-changed',
      snapshots: {
        header: {
          authority: 'runtime', title: 'Octocode Agent',
          ...(snapshot.model?.modelId === undefined ? {} : { modelId: snapshot.model.modelId }),
          ...(snapshot.sessionId === undefined ? {} : { sessionId: String(snapshot.sessionId) }),
          trust: chromeTrust, working, width: 80,
        },
        footer: {
          authority: 'runtime', activeMode: working === 'active' ? 'running' : 'interactive', connection, widthColumns: 80,
          keyHints,
        },
      },
    });
  };
  const currentWorking = (): 'idle' | 'active' | 'cancelling' | 'failed' => {
    const state = runtime.snapshot().state;
    if (state === 'running') return 'active';
    if (state === 'failed') return 'failed';
    if (state === 'stopping') return 'cancelling';
    return 'idle';
  };
  const interactionHandler = terminal.interact === undefined
    ? async () => ({ status: 'unsupported' as const })
    : async (...args: Parameters<NonNullable<OpenTuiTerminal['interact']>>) => {
        const pending = terminal.interact!(...args);
        presentChrome(currentWorking());
        try { return await pending; }
        finally { presentChrome(currentWorking()); }
      };
  detachInteractions = interactions.attach(interactionHandler);
  terminal.accept({ type: 'interaction-handler-state', ready: terminal.interact !== undefined });
  const unsubscribe = runtime.subscribe((event) => {
    const payload = event.payload as Record<string, unknown>;
    chromeTrust = event.trust.workspace;
    if (event.type === 'turn.started' && typeof payload.turnId === 'string') activeTurnId = payload.turnId;
    for (const semantic of presentationEvents(event, activeTurnId)) terminal.accept(semantic);
    if (event.type === 'runtime.ready') { runtimeFailed = false; presentChrome('idle', 'connected'); }
    else if (event.type === 'runtime.stopping') presentChrome('cancelling', 'connecting');
    else if (event.type === 'runtime.failed') { runtimeFailed = true; presentChrome('failed', 'error'); }
    else if (event.type === 'turn.started') presentChrome('active');
    else if (event.type === 'turn.ended') presentChrome(runtimeFailed ? 'failed' : 'idle');
    if (event.type === 'turn.ended') activeTurnId = undefined;
  });
  let detachInput: (() => void) | undefined;
  let detachFailure: (() => void) | undefined;
  let detachSignals: (() => void) | undefined;
  try {
    presentChrome('idle');
    await runtime.start();
    if (initialMessage) submit(initialMessage);
    let finishNativeInput: (() => void) | undefined;
    const nativeInputDone = new Promise<void>((resolve) => { finishNativeInput = resolve; });
    detachFailure = terminal.subscribeFailure?.((error) => {
      submissionFailure ??= error;
      finishNativeInput?.();
    });
    const handleLine = async (line: string): Promise<boolean> => {
      if (terminal.acceptInput?.(line)) return true;
      const command = await handleNativeSlashCommand(line, {
        runtime,
        terminal,
        currentPlan,
        skills,
        ...(settingsPage ? { openSettings: (section) => settingsPage.open(section) } : {}),
      });
      if (command === 'exit') return false;
      if (command === 'handled') return true;
      if (line.trim()) {
        const runtimeActive = runtime.snapshot().state === 'running';
        if (!submissionInFlight && activeTurnId === undefined && !runtimeActive) submit(line);
        else followUp(line);
      }
      return true;
    };
    if (terminal.inputOwnership === 'renderer') {
      if (!terminal.subscribeInput) throw new Error('renderer-owned input requires a terminal input subscription');
      const settleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
        void (async () => {
          try {
            const active = runtime.snapshot().state === 'running' || activeTurnId !== undefined || submissionInFlight;
            if (active) await runtime.cancel(signal === 'SIGTERM' ? 'process terminated' : 'user interrupt');
            if (signal === 'SIGTERM' || !active) finishNativeInput?.();
          } catch (error) {
            submissionFailure ??= error;
            finishNativeInput?.();
          }
        })();
      };
      const onSigint = () => settleSignal('SIGINT');
      const onSigterm = () => settleSignal('SIGTERM');
      signalSource.on('SIGINT', onSigint);
      signalSource.on('SIGTERM', onSigterm);
      detachSignals = () => {
        signalSource.off('SIGINT', onSigint);
        signalSource.off('SIGTERM', onSigterm);
      };
      detachInput = terminal.subscribeInput(async (event) => {
        if (event.type === 'line') {
           if (!await handleLine(event.line)) finishNativeInput?.();
          return;
        }
        if (terminal.cancelInteraction?.()) return;
        if (runtime.snapshot().state === 'running' || activeTurnId !== undefined || submissionInFlight) {
          await runtime.cancel('user interrupt');
        } else {
          finishNativeInput?.();
        }
      });
      await nativeInputDone;
    } else {
      for await (const line of createLineReader(input)) {
        if (!await handleLine(line)) break;
      }
    }
    return 0;
  } finally {
    let failure: unknown;
    try { await runtime.stop(); }
    catch (error) { failure = error; }
    finally {
      await Promise.allSettled([...submissions]);
      failure ??= submissionFailure;
      unsubscribe();
      detachInput?.();
      detachFailure?.();
      detachSignals?.();
      detachInteractions();
      try { await settingsPage?.close(); }
      catch (error) { failure ??= error; }
      try { await terminal.stop(); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
}

export async function launchNativeAgent(
  argv: readonly string[] = [],
  dependencies: NativeLaunchDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const args = parseNativeArgs(argv);
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let message = [args.initialMessage, ...args.rest]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .trim();
  if (args.mode === 'print' && !message) {
    if ((stdin as Readable & { isTTY?: boolean }).isTTY === true) {
      stderr.write('octocode-agent run requires a prompt or piped stdin\n');
      return 2;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    message = Buffer.concat(chunks).toString('utf8').trim();
    if (!message) {
      stderr.write('octocode-agent run requires a prompt or piped stdin\n');
      return 2;
    }
  }
  const interactions = createNativeInteractionBroker();
  const settingsStorage = new FileSettingsStorage(path.join(agentDir(env), 'settings.json'));
  const settings = await createNativeSettingsService(settingsStorage);
  const storedSettings = settingsStorage.read().values;
  const workspaceTrust = resolveNativeWorkspaceTrust(cwd, storedSettings);
  const settingsCapabilityComposition = createNativeCapabilityComposition({
    cwd,
    env,
    interactions,
    workspaceTrust,
  });
  const extensionPolicy = resolveNativeExtensionPolicy(storedSettings);
  const extensions = dependencies.createExtensions
    ? await dependencies.createExtensions({ env, cwd })
    : new NativeExtensionsController(createNativeFilesystemExtensionsOptions({
        home: env.HOME ?? cwd,
        workspace: cwd,
        workspaceTrusted: workspaceTrust === 'trusted',
        reviewedHashes: extensionPolicy.reviewedHashes,
        pluginGrants: extensionPolicy.pluginGrants,
      }));
  if (!extensions.snapshot().discovered) await extensions.discover();
  await extensions.activateEligible();
  let presentPlanSnapshot: RuntimePlanSnapshotSink | undefined;
  let currentPlanSnapshot: RuntimePlanSnapshot | undefined;
  let workerProjection: NativeWorkerTransportProjection | undefined;
  try {
    const runtime = await (dependencies.createRuntime ?? createDefaultNativeRuntime)({
      env,
      cwd,
      args,
      interactions,
      settings,
      extensions,
      onWorkerProjection: (projection) => { workerProjection = projection; },
      ...(dependencies.authorizeWorkerProjection === undefined ? {} : { authorizeWorkerProjection: dependencies.authorizeWorkerProjection }),
      ...(args.mode === 'interactive'
        ? { onPlanSnapshot: (snapshot: RuntimePlanSnapshot) => {
            currentPlanSnapshot = snapshot;
            presentPlanSnapshot?.(snapshot);
          } }
        : {}),
    });
              if (args.mode === 'rpc') return await runRpcTransport(
                runtime,
                { input: stdin, output: stdout },
                { getWorkerProjection: () => workerProjection, ...(dependencies.signalSource === undefined ? {} : { signalSource: dependencies.signalSource }) },
              );
              if (args.mode === 'print') {
                if (args.outputFormat === 'json') return await runJsonTransport(runtime, message, (value) => { stdout.write(value); }, dependencies.signalSource === undefined ? {} : { signalSource: dependencies.signalSource });
                return await runPrintTransport(runtime, message, { format: 'text', write: (value) => { stdout.write(value); }, ...(dependencies.signalSource === undefined ? {} : { signalSource: dependencies.signalSource }) });
              }
    const terminal = dependencies.createTerminal
      ? dependencies.createTerminal()
      : (await import('./terminal/opentui/renderer.js')).createDefaultOpenTuiTerminal({ cwd, alternateOutput: args.accessible });
    presentPlanSnapshot = (plan) => terminal.accept({ type: 'runtime-widgets-changed', snapshots: { plan } });
    const settingsPage = dependencies.createSettingsPage
      ? dependencies.createSettingsPage({ env, cwd, runtime, settings, extensions })
      : createNativeSettingsPageController({
          settings,
          cwd,
          env,
          getRuntimeSnapshot: () => runtime.snapshot(),
          workspaceTrust: resolveNativeWorkspaceTrust(
            cwd,
            settingsStorage.read().values,
          ),
          getExtensionsSnapshot: () => extensions.snapshot(),
          capabilityControl: createNativeSettingsCapabilityControl({
            cwd,
            env,
            skills: settingsCapabilityComposition.skills,
          }),
        });
    return await runInteractive(
      runtime,
      terminal,
      interactions,
      stdin,
      args.initialMessage,
      dependencies.createLineReader,
      () => currentPlanSnapshot,
      () => {
        const db = openOctocodeDb(octocodeDbPath(env));
        return listNativeSkillSummaries({
          cwd,
          homeDir: env.HOME,
          isEnabled: (name) => getSkillEnablement(db, cwd, name, true),
        });
      },
      dependencies.signalSource,
      settingsPage,
    );
  } finally {
    extensions.deactivateAll();
  }
}
