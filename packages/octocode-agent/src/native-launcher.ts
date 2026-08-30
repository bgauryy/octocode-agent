import { randomUUID } from 'node:crypto';
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
  eventId,
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
  type ModelMessage,
  type ModelPort,
  type RuntimeEvent,
  type SessionEvent,
  type SessionEventId,
  type SessionId,
  type SessionStore,
  type ToolRegistry,
} from '@octocodeai/agent-core';
import { agentDbPath, closeOctocodeDb, getSkillEnablement, openOctocodeDb, recordSession } from '@octocodeai/octocode-awareness/mcp-state';
import type { AwarenessEventObservability } from '@octocodeai/octocode-awareness';
import fs from 'node:fs';
import path from 'node:path';

import {
  createNativeProviderModelPort,
  resolveNativeModelConfiguration,
  type NativeProviderProtocol,
} from './native-provider-registry.js';
import { runNativeProviderSmoke, type NativeProviderSmokeResult } from './native-provider-smoke.js';
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
  octocodeCatalogCacheMetrics,
} from './native-tools.js';
import {
  FileBackedRuntimePlanState,
  FilePlanStore,
  InMemoryPlanStore,
  NativePlanWorkerOwnership,
  projectRuntimePlanSnapshot,
  type NativePlanInteraction,
  type RuntimePlanSnapshot,
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
import { buildNativeDiscoverySnapshot } from './native-discovery.js';
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
import { createRuntimeEventPersister } from './native-runtime-session-projector.js';
import { runNativeInteractiveController } from './native-interactive-controller.js';

export { createRuntimeEventPersister } from './native-runtime-session-projector.js';

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
} from './terminal/opentui/presentation.js';

export interface ParsedNativeArgs {
  mode: 'interactive' | 'print' | 'rpc' | 'acp';
  outputFormat: 'text' | 'json';
  initialMessage?: string;
  session?: string;
  name?: string;
  noSession: boolean;
  continue: boolean;
  accessible: boolean;
  allowWorkers: boolean;
  model?: { readonly providerId: string; readonly modelId: string };
  fallbackModels: { readonly providerId: string; readonly modelId: string }[];
  rest: string[];
}

export type NativeModelRef = { readonly providerId: string; readonly modelId: string };
export type NativeFallbackProbe = (model: NativeModelRef) => Promise<NativeProviderSmokeResult>;

/** Evaluates only a user-supplied chain and never changes vendors implicitly. */
export async function selectNativeFallbackModel(
  candidates: readonly NativeModelRef[],
  probe: NativeFallbackProbe,
): Promise<NativeModelRef> {
  for (const candidate of candidates) {
    const result = await probe(candidate);
    if (result.status === 'PASS') return candidate;
  }
  throw new RuntimeFailure('provider', 'No explicitly configured model passed provider health checks');
}

function parseModelRef(value: string, option: '--model' | '--fallback-model'): { providerId: string; modelId: string } {
  const separator = value.indexOf('/');
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  if (separator < 1 || !providerId || !modelId) throw new RuntimeFailure('validation', `Invalid value for ${option}: ${value}`);
  return { providerId, modelId };
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
    onPlanSnapshot?: (snapshot: RuntimePlanSnapshot | undefined) => void;
    onAwarenessObservability?: (stats: AwarenessEventObservability) => void;
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
  probeFallbackModel?: NativeFallbackProbe;
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
    fallbackModels: [],
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
    if (arg === '--model' || arg === '--fallback-model') {
      const value = optionValue(arg, index);
      index += 1;
      const model = parseModelRef(value, arg);
      if (arg === '--model') parsed.model = model;
      else parsed.fallbackModels.push(model);
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
  if (parsed.fallbackModels.length > 0 && parsed.model === undefined) {
    throw new RuntimeFailure('validation', '--fallback-model requires --model');
  }
  return parsed;
}

function configuredApiKey(env: NodeJS.ProcessEnv, protocol: NativeProviderProtocol, credentialEnv?: string): string {
  return (credentialEnv ? env[credentialEnv] : undefined)
    ?? env.OCTOCODE_MODEL_API_KEY
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
  onPlanSnapshot?: (snapshot: RuntimePlanSnapshot | undefined) => void;
  onAwarenessObservability?: (stats: AwarenessEventObservability) => void;
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
      planObserved: boolean;
      awareness?: AwarenessEventObservability;
    }>();
    const commitCandidate = (id: SessionId): void => {
      for (const candidate of candidates.values()) candidate.committed = false;
      const candidate = candidates.get(String(id));
      if (candidate === undefined) return;
      candidate.committed = true;
      if (candidate.worker !== undefined) options.onWorkerProjection?.(candidate.worker);
      if (candidate.planObserved) options.onPlanSnapshot?.(candidate.plan);
      if (candidate.awareness !== undefined) options.onAwarenessObservability?.(candidate.awareness);
    };
    const router = await createNativeSessionRuntimeRouter({
      controller,
      initialSessionId: activeSessionId,
      createRuntime: async ({ sessionId: nextSessionId }) => {
        const candidate: { committed: boolean; worker?: NativeWorkerTransportProjection; plan?: RuntimePlanSnapshot; planObserved: boolean; awareness?: AwarenessEventObservability } = {
          committed: false,
          planObserved: false,
        };
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
              candidate.planObserved = true;
              candidate.plan = snapshot;
              if (candidate.committed) options.onPlanSnapshot?.(snapshot);
            },
            onAwarenessObservability: (stats) => {
              candidate.awareness = stats;
              if (candidate.committed) options.onAwarenessObservability?.(stats);
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
  const delegatedModel = options.args.model === undefined && configuredModel === undefined && configuredProvider === undefined && workerCapabilities.allowedModels?.length === 1
    ? workerCapabilities.allowedModels[0]
    : undefined;
  const modelConfiguration = resolveNativeModelConfiguration({
    env: options.env,
    configuredProvider: options.args.model?.providerId ?? configuredProvider ?? delegatedModel?.providerId,
    configuredModel: options.args.model?.modelId ?? configuredModel ?? delegatedModel?.modelId,
    ...(options.args.model !== undefined
      ? { configuredSelectionSource: 'cli.override', forceConfiguredSelection: true }
      : delegatedModel === undefined ? {} : { configuredSelectionSource: 'worker.capabilities' }),
    cwd: options.cwd,
    home: options.env.HOME ?? path.dirname(getOctocodeHome(options.env)),
    octocodeHome: getOctocodeHome(options.env),
    workspaceTrusted: workspaceTrust === 'trusted',
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
  }
  try { options.onPlanSnapshot?.(storedPlan === undefined ? undefined : projectRuntimePlanSnapshot(storedPlan)); }
  catch {
    // Presentation observers are not part of durable plan hydration.
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
  const runtimeMode = options.args.mode === 'print'
    ? options.args.outputFormat === 'json' ? 'json' : 'print'
    : options.args.mode;
  let emitWorkerLifecycle: ((type: 'worker.started' | 'worker.stopped', payload: unknown) => Promise<void>) | undefined;
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
      onStarted: async (snapshot) => emitWorkerLifecycle?.('worker.started', snapshot),
      onStopped: async (snapshot) => emitWorkerLifecycle?.('worker.stopped', snapshot),
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
      planOwnership: new NativePlanWorkerOwnership(planStore),
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
    recordSession(openOctocodeDb(agentDbPath(options.env)), {
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
  emitWorkerLifecycle = async (type, payload) => {
    await persistRuntimeEvent({
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId(`native:${type}:${randomUUID()}`),
      type,
      phase: 'after',
      sessionId: activeSessionId,
      timestamp: Date.now(),
      cwd: options.cwd,
      mode: runtimeMode,
      outputFormat: options.args.outputFormat,
      model: { providerId, modelId: effectiveModel },
      trust: { workspace: workspaceTrust, managedOnly: false },
      payload: payload as Readonly<unknown>,
    });
  };
  const modelPort = options.model ?? createNativeProviderModelPort(modelProtocol === 'anthropic-messages'
    ? {
        protocol: modelProtocol,
        endpoint: modelEndpoint,
        apiKey: configuredApiKey(options.env, modelProtocol, modelConfiguration.credentialEnv),
        resolveAuth: modelConfiguration.resolveRuntimeAuth,
        allowMissingApiKey: modelConfiguration.credential.source === 'headers' || modelConfiguration.credential.source === 'none',
        defaultModel: effectiveModel,
        promptCaching: modelConfiguration.promptCaching !== 'disabled',
        ...(modelConfiguration.maxOutputTokens === undefined ? {} : { maxOutputTokens: modelConfiguration.maxOutputTokens }),
        ...(modelConfiguration.sendSessionAffinityHeaders ? { sessionAffinityId: activeSessionId } : {}),
      }
    : {
        protocol: modelProtocol,
        endpoint: modelEndpoint,
        apiKey: configuredApiKey(options.env, modelProtocol, modelConfiguration.credentialEnv),
        resolveAuth: modelConfiguration.resolveRuntimeAuth,
        allowMissingApiKey: modelConfiguration.credential.source === 'headers' || modelConfiguration.credential.source === 'none',
        defaultModel: effectiveModel,
        ...(modelConfiguration.promptCaching === 'enabled' || (modelConfiguration.promptCaching === 'auto' && new URL(modelEndpoint).hostname === 'api.openai.com')
          ? { promptCacheKey: `octocode:${activePrompt!.sha256.slice(0, 55)}` }
          : {}),
      });
  let activeTransportModelId = effectiveModel;
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
        model: { providerId, modelId: activeTransportModelId },
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
    mode: runtimeMode,
    outputFormat: options.args.outputFormat,
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
    validateModel: (model) => {
      if (model.providerId !== providerId) {
        return `Changing providers from ${providerId} to ${model.providerId} requires a new session so the native transport, endpoint, and credentials can be recomposed`;
      }
      const available = modelConfiguration.catalog.providers.some(({ id, enabled }) => id === model.providerId && enabled)
        && modelConfiguration.catalog.models.some(({ providerId: candidateProvider, id, enabled }) => (
          candidateProvider === model.providerId && id === model.modelId && enabled
        ));
      if (!available) return `Model ${model.providerId}/${model.modelId} is not available in the effective native model catalog`;
      activeTransportModelId = model.modelId;
      return undefined;
    },
    validateThinking: providerId === 'anthropic'
      ? (level) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)
        ? undefined
        : `Thinking level ${level} is not supported by the Anthropic Messages adapter`
      : () => 'Thinking controls are not supported by the active OpenAI-compatible adapter',
    monitoring: { snapshot: () => ({ cache: octocodeCatalogCacheMetrics() }) },
    emit: persistRuntimeEvent,
    model: modelPort,
  });
  const agentId = options.env.OCTOCODE_AGENT_ID?.trim() || `native:${activeSessionId}`;
  return withNativeSessionCommunication(runtime, {
    workspace: options.cwd,
    sessionId: String(activeSessionId),
    agentId,
    ...(options.onAwarenessObservability === undefined ? {} : { onObservability: options.onAwarenessObservability }),
  });
}

function nativeAwarenessStatus(stats: AwarenessEventObservability): string | undefined {
  const attention = stats.backlogDepth > 0
    || stats.drainHeld > 0
    || stats.drainRefused > 0
    || stats.drainErrors > 0;
  if (!attention) return undefined;
  return `queue ${stats.backlogDepth}${stats.backlogCapped ? '+' : ''} · ack ${stats.lastAcknowledgedSequence} · accepted ${stats.drainAccepted} · held ${stats.drainHeld} · refused ${stats.drainRefused} · errors ${stats.drainErrors}`;
}

export function nativeEffectAllowed(request: { readonly effects: EffectSet; readonly operation: string }): boolean {
  return request.effects.every((effect) => effect === 'read'
    || effect === 'network'
    || (effect === 'process' && (request.operation === 'tool:MCPTool' || request.operation === 'tool:worker'))
    || (effect === 'write' && (request.operation === 'tool:plan' || request.operation === 'tool:awareness' || request.operation === 'tool:MCPTool')));
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
  if (args.model !== undefined && args.fallbackModels.length > 0) {
    const probe = dependencies.probeFallbackModel ?? (async (candidate: NativeModelRef) => {
      const configuration = resolveNativeModelConfiguration({
        env,
        configuredProvider: candidate.providerId,
        configuredModel: candidate.modelId,
        configuredSelectionSource: 'cli.override',
        forceConfiguredSelection: true,
        cwd,
        home: env.HOME ?? path.dirname(getOctocodeHome(env)),
        octocodeHome: getOctocodeHome(env),
        workspaceTrusted: workspaceTrust === 'trusted',
      });
      const apiKey = configuration.credentialEnv === undefined ? '' : env[configuration.credentialEnv]?.trim() ?? '';
      return runNativeProviderSmoke({
        protocol: configuration.protocol,
        endpoint: configuration.endpoint,
        apiKey,
        model: candidate.modelId,
        ...(configuration.resolveRuntimeAuth === undefined ? {} : { resolveAuth: configuration.resolveRuntimeAuth }),
      });
    });
    args.model = await selectNativeFallbackModel([args.model, ...args.fallbackModels], probe);
  }
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
  let presentPlanSnapshot: ((snapshot: RuntimePlanSnapshot | undefined) => void) | undefined;
  let currentPlanSnapshot: RuntimePlanSnapshot | undefined;
  let planSnapshotObserved = false;
  let currentAwarenessObservability: AwarenessEventObservability | undefined;
  let presentAwarenessObservability: ((stats: AwarenessEventObservability) => void) | undefined;
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
        ? { onPlanSnapshot: (snapshot: RuntimePlanSnapshot | undefined) => {
            planSnapshotObserved = true;
            currentPlanSnapshot = snapshot;
            presentPlanSnapshot?.(snapshot);
          } }
        : {}),
      ...(args.mode === 'interactive'
        ? { onAwarenessObservability: (stats: AwarenessEventObservability) => {
            currentAwarenessObservability = stats;
            presentAwarenessObservability?.(stats);
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
    const reducedMotion = settings.snapshot().values.find(({ key }) => key === 'reducedMotion')?.value !== false;
    const terminal = dependencies.createTerminal
      ? dependencies.createTerminal()
      : (await import('./terminal/opentui/renderer.js')).createDefaultOpenTuiTerminal({
          cwd, alternateOutput: args.accessible, reducedMotion,
        });
    presentPlanSnapshot = (plan) => terminal.accept({
      type: 'runtime-widgets-changed',
      snapshots: { plan: plan ?? null },
    });
    if (planSnapshotObserved) presentPlanSnapshot(currentPlanSnapshot);
    presentAwarenessObservability = (stats) => terminal.accept({
      type: 'status-changed',
      name: 'awareness.events',
      ...(nativeAwarenessStatus(stats) === undefined ? {} : { text: nativeAwarenessStatus(stats) }),
    });
    if (currentAwarenessObservability !== undefined) presentAwarenessObservability(currentAwarenessObservability);
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
          getDiscoverySnapshot: () => {
            const values = settings.snapshot().values;
            const configuredProvider = values.find(({ key }) => key === 'defaultProvider')?.value;
            const configuredModel = values.find(({ key }) => key === 'defaultModel')?.value;
            return buildNativeDiscoverySnapshot({
              cwd,
              env,
              configuredProvider: typeof configuredProvider === 'string' ? configuredProvider : undefined,
              configuredModel: typeof configuredModel === 'string' ? configuredModel : undefined,
              workspaceTrusted: resolveNativeWorkspaceTrust(cwd, settingsStorage.read().values) === 'trusted',
            });
          },
          capabilityControl: createNativeSettingsCapabilityControl({
            cwd,
            env,
            skills: settingsCapabilityComposition.skills,
          }),
        });
    const selectedInteractiveModel = runtime.snapshot().model;
    const thinkingSupported = selectedInteractiveModel != null && resolveNativeModelConfiguration({
      env,
      configuredProvider: selectedInteractiveModel.providerId,
      configuredModel: selectedInteractiveModel.modelId,
      configuredSelectionSource: 'cli.override',
      forceConfiguredSelection: true,
      cwd,
      home: env.HOME ?? path.dirname(getOctocodeHome(env)),
      octocodeHome: getOctocodeHome(env),
      workspaceTrusted: workspaceTrust === 'trusted',
    }).protocol === 'anthropic-messages';
    return await runNativeInteractiveController({
      runtime,
      terminal,
      interactions,
      input: stdin,
      ...(args.initialMessage === undefined ? {} : { initialMessage: args.initialMessage }),
      ...(dependencies.createLineReader === undefined ? {} : { createLineReader: dependencies.createLineReader }),
      currentPlan: () => currentPlanSnapshot,
      skills: () => {
        const dbFile = agentDbPath(env);
        const db = openOctocodeDb(dbFile);
        try {
          return listNativeSkillSummaries({
            cwd,
            homeDir: env.HOME,
            octocodeHome: getOctocodeHome(env),
            workspaceTrusted: resolveNativeWorkspaceTrust(cwd, settingsStorage.read().values) === 'trusted',
            isEnabled: (name, defaultEnabled, source) => getSkillEnablement(db, cwd, name, defaultEnabled, source.id),
          });
        } finally {
          closeOctocodeDb(dbFile);
        }
      },
      ...(dependencies.signalSource === undefined ? {} : { signalSource: dependencies.signalSource }),
      settingsPage,
      thinkingSupported,
    });
  } finally {
    extensions.deactivateAll();
  }
}
