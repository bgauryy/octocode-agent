import {
  LifecycleBus,
  RuntimeFailure,
  type AgentEventType,
  type EventAuthority,
  type HookDecision,
  type HookHandlerDefinition,
  type LifecycleDecision,
  type RuntimeEvent,
} from '@octocodeai/agent-core';
import type { NativeExtensionsController } from './native-extensions.js';
import type { NativeHookCommandExecutor, NativeHookCommandResult } from './native-extension-adapters.js';

type CodexEvent = 'SessionStart' | 'SessionEnd' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'PostCompact';
type CommandExecutor = Pick<NativeHookCommandExecutor, 'execute'>;
type McpHandler = Extract<HookHandlerDefinition, { type: 'mcp_tool' }>;

export interface NativeHookMcpExecutor {
  execute(handler: McpHandler, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<NativeHookCommandResult>;
}

export interface NativeHookDispatcherControl {
  (): void;
  cancel(): void;
  drain(): Promise<void>;
}

export interface NativeHookDispatchReceipt {
  readonly event: AgentEventType;
  readonly codexEvent: CodexEvent;
  readonly sourceId: string;
  readonly handlerIndex: number;
  readonly outcome: 'executed' | 'skipped' | 'failed';
  readonly reason?: 'matcher-no-match' | 'mcp-handler-unavailable' | 'unsupported-handler' | 'async-handler-deferred' | 'decision-not-authorized' | string;
}

export interface NativeHookDispatcherOptions {
  readonly extensions: NativeExtensionsController;
  readonly lifecycle: Map<RuntimeEvent['type'], LifecycleBus<unknown>>;
  readonly executor: CommandExecutor;
  readonly mcpExecutor?: NativeHookMcpExecutor;
  readonly workspaceTrusted: boolean;
  readonly managedOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly onReceipt?: (receipt: NativeHookDispatchReceipt) => void;
}

interface Mapping {
  readonly runtimeEvent: RuntimeEvent['type'];
  readonly codexEvent: CodexEvent;
  readonly authority: readonly EventAuthority[];
}

const MAPPINGS: readonly Mapping[] = Object.freeze([
  { runtimeEvent: 'session.starting', codexEvent: 'SessionStart', authority: ['observe', 'context', 'stop'] },
  { runtimeEvent: 'session.stopping', codexEvent: 'SessionEnd', authority: ['observe'] },
  { runtimeEvent: 'input.received', codexEvent: 'UserPromptSubmit', authority: ['observe', 'context', 'rewrite', 'stop'] },
  { runtimeEvent: 'tool.requested', codexEvent: 'PreToolUse', authority: ['observe', 'rewrite', 'allow-deny'] },
  { runtimeEvent: 'tool.ended', codexEvent: 'PostToolUse', authority: ['observe', 'context'] },
  { runtimeEvent: 'context.compaction-started', codexEvent: 'PreCompact', authority: ['observe', 'context', 'stop'] },
  { runtimeEvent: 'context.compacted', codexEvent: 'PostCompact', authority: ['observe', 'context'] },
]);

/** Installs reviewed hook subscriptions into the runtime-owned lifecycle buses. */
export function installNativeHookDispatcher(options: NativeHookDispatcherOptions): NativeHookDispatcherControl {
  const groups = options.extensions.effectiveHooks({
    workspaceTrusted: options.workspaceTrusted,
    managedOnly: options.managedOnly ?? false,
  });
  const unsubscribe: (() => void)[] = [];
  const owned = new AbortController();
  const pending = new Set<Promise<void>>();
  const cancelOwned = () => owned.abort(new RuntimeFailure('cancelled', 'Hook dispatcher was cancelled'));
  options.signal?.addEventListener('abort', cancelOwned, { once: true });
  for (const mapping of MAPPINGS) {
    const matchingGroups = groups.filter(({ event }) => event === mapping.codexEvent);
    if (matchingGroups.length === 0) continue;
    const bus = ensureBus(options.lifecycle, mapping);
    for (const effective of matchingGroups) {
      for (const [handlerIndex, handler] of effective.group.handlers.entries()) {
        const id = `native-hook:${effective.source.id}:${mapping.codexEvent}:${effective.group.declarationOrder}:${handlerIndex}`;
        unsubscribe.push(bus.subscribe({
          id,
          source: effective.source.scope,
          discoveryOrder: effective.source.discoveryOrder,
          declarationOrder: effective.group.declarationOrder * 1_000 + handlerIndex,
          handler: async (envelope) => {
            const payload = asRecord(envelope.payload, `${mapping.runtimeEvent} payload`);
            if (!matches(effective.group.matcher, matchSubject(mapping.codexEvent, payload))) {
              receipt(options, mapping, effective.source.id, handlerIndex, 'skipped', 'matcher-no-match');
              return { kind: 'continue' };
            }
            if (handler.type === 'unsupported') {
              receipt(options, mapping, effective.source.id, handlerIndex, 'skipped', 'unsupported-handler');
              return { kind: 'continue' };
            }
            if (handler.async) {
              const task = executeHandler(options, handler, codexInput(mapping.codexEvent, envelope, payload), owned.signal)
                .then(() => receipt(options, mapping, effective.source.id, handlerIndex, 'executed'))
                .catch((error) => receipt(options, mapping, effective.source.id, handlerIndex, 'failed', error instanceof Error ? error.message : 'handler failed'))
                .finally(() => pending.delete(task));
              pending.add(task);
              return { kind: 'continue' };
            }
            try {
              const result = await executeHandler(options, handler, codexInput(mapping.codexEvent, envelope, payload), owned.signal);
              const translated = translateDecision(mapping.codexEvent, payload, result);
              receipt(options, mapping, effective.source.id, handlerIndex, 'executed', translated.reason);
              return translated.decision;
            } catch (error) {
              receipt(options, mapping, effective.source.id, handlerIndex, 'failed', error instanceof Error ? error.message : 'handler failed');
              throw error;
            }
          },
        }));
      }
    }
  }
  const dispose = (() => {
    cancelOwned();
    options.signal?.removeEventListener('abort', cancelOwned);
    for (const unsubscribeOne of unsubscribe.reverse()) unsubscribeOne();
  }) as NativeHookDispatcherControl;
  dispose.cancel = cancelOwned;
  dispose.drain = async () => { await Promise.all([...pending]); };
  return dispose;
}

async function executeHandler(
  options: NativeHookDispatcherOptions,
  handler: Exclude<HookHandlerDefinition, { type: 'unsupported' }>,
  input: Readonly<Record<string, unknown>>,
  parentSignal: AbortSignal,
): Promise<NativeHookCommandResult> {
  if (handler.type === 'mcp_tool' && options.mcpExecutor === undefined) {
    throw new RuntimeFailure('tool-execution', 'MCP hook executor is unavailable');
  }
  if (parentSignal.aborted) throw parentSignal.reason;
  const controller = new AbortController();
  const cancel = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', cancel, { once: true });
  const timeout = new RuntimeFailure('tool-execution', 'Hook handler timed out');
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => { controller.abort(timeout); reject(timeout); }, Math.max(1, handler.timeoutSeconds * 1_000));
    timeoutId.unref();
  });
  try {
    const execution = handler.type === 'mcp_tool'
      ? options.mcpExecutor!.execute(handler, input, controller.signal)
      : options.executor.execute(handler, input, controller.signal);
    return await Promise.race([execution, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    parentSignal.removeEventListener('abort', cancel);
  }
}

function ensureBus(lifecycle: Map<RuntimeEvent['type'], LifecycleBus<unknown>>, mapping: Mapping): LifecycleBus<unknown> {
  const existing = lifecycle.get(mapping.runtimeEvent);
  if (existing !== undefined) {
    for (const authority of mapping.authority) if (!existing.definition.authority.includes(authority)) {
      throw new RuntimeFailure('internal-invariant', `Lifecycle bus ${mapping.runtimeEvent} lacks hook authority ${authority}`);
    }
    return existing;
  }
  const bus = new LifecycleBus<unknown>({
    eventType: mapping.runtimeEvent,
    authority: mapping.authority,
    validate: (payload): payload is unknown => validPayload(mapping.runtimeEvent, payload),
  });
  lifecycle.set(mapping.runtimeEvent, bus);
  return bus;
}

function validPayload(event: RuntimeEvent['type'], payload: unknown): boolean {
  if (!record(payload)) return false;
  if (event === 'tool.requested') return typeof payload.name === 'string' && payload.name.trim().length > 0 && 'input' in payload && typeof payload.callId === 'string';
  if (event === 'input.received') return typeof payload.text === 'string';
  return true;
}

function matchSubject(event: CodexEvent, payload: Record<string, unknown>): string {
  if (event === 'PreToolUse' || event === 'PostToolUse') return typeof payload.name === 'string' ? payload.name : '';
  if (event === 'UserPromptSubmit') return typeof payload.source === 'string' ? payload.source : 'user';
  return typeof payload.reason === 'string' ? payload.reason : '';
}

function matches(matcher: string | undefined, subject: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  return new RegExp(matcher).test(subject);
}

function codexInput(event: CodexEvent, envelope: RuntimeEvent, payload: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    session_id: String(envelope.sessionId), cwd: envelope.cwd, hook_event_name: event,
    ...(envelope.turnId === undefined ? {} : { turn_id: String(envelope.turnId) }),
    ...(envelope.model === undefined ? {} : { model: envelope.model.modelId }),
  };
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    return Object.freeze({ ...base, tool_name: payload.name, tool_input: payload.input, tool_use_id: payload.callId, ...(event === 'PostToolUse' ? { tool_response: payload.result } : {}) });
  }
  if (event === 'UserPromptSubmit') return Object.freeze({ ...base, prompt: payload.text });
  return Object.freeze({ ...base, reason: payload.reason });
}

function translateDecision(event: CodexEvent, payload: Record<string, unknown>, result: NativeHookCommandResult): { decision: LifecycleDecision<unknown>; reason?: string } {
  const output = record(result.output) ? result.output : undefined;
  const specific = output !== undefined && record(output.hookSpecificOutput) ? output.hookSpecificOutput : undefined;
  if (event === 'PreToolUse' && specific !== undefined && 'updatedInput' in specific) {
    if (!record(specific.updatedInput)) throw new RuntimeFailure('validation', 'PreToolUse updatedInput must be an object');
    return { decision: { kind: 'rewrite', payload: { ...payload, input: structuredClone(specific.updatedInput) } } };
  }
  if (event === 'UserPromptSubmit' && specific !== undefined && 'updatedPrompt' in specific) {
    if (typeof specific.updatedPrompt !== 'string') throw new RuntimeFailure('validation', 'UserPromptSubmit updatedPrompt must be a string');
    return { decision: { kind: 'rewrite', payload: { ...payload, text: specific.updatedPrompt } } };
  }
  const decision = result.decision as HookDecision;
  if (decision.kind === 'deny' && event === 'PreToolUse') return { decision };
  if (decision.kind === 'stop' && (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PreCompact')) return { decision };
  if (decision.kind === 'context' && event !== 'SessionEnd' && event !== 'PreToolUse') return { decision };
  if (decision.kind === 'continue' || decision.kind === 'no-decision') return { decision: { kind: 'continue' } };
  return { decision: { kind: 'continue' }, reason: 'decision-not-authorized' };
}

function receipt(options: NativeHookDispatcherOptions, mapping: Mapping, sourceId: string, handlerIndex: number, outcome: NativeHookDispatchReceipt['outcome'], reason?: string): void {
  options.onReceipt?.({ event: mapping.runtimeEvent, codexEvent: mapping.codexEvent, sourceId, handlerIndex, outcome, ...(reason === undefined ? {} : { reason }) });
}
function asRecord(value: unknown, name: string): Record<string, unknown> { if (!record(value)) throw new RuntimeFailure('validation', `${name} must be an object`); return value; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
