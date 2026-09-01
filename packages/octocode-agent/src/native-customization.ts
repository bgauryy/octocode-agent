import {
  RuntimeFailure,
  type LifecycleDecision,
  type RuntimeEvent,
  type ToolDefinition,
  type ToolRegistry,
} from '@octocodeai/agent-core';
import type {
  AgentEventObserverV1,
  AgentHookDecisionV1,
  AgentHookV1,
  AgentLifecycleObservedEventByTypeV1,
  AgentLifecycleSensitiveEventByTypeV1,
  AgentToolV1,
  OctocodeAgentCustomizationV1,
  ProductPolicyOverlayV1,
} from './api/v1.js';
import { ensureNativeLifecycleBus } from './native-hook-dispatcher.js';
import {
  projectObservedLifecycleEventV1,
  projectSensitiveLifecycleEventV1,
} from './native-public-events.js';

export type NativeAgentCustomization = Readonly<OctocodeAgentCustomizationV1>;
const disposed = new WeakSet<object>();

export async function disposeNativeCustomization(
  customization: NativeAgentCustomization | undefined,
): Promise<void> {
  if (customization === undefined || customization.dispose === undefined || disposed.has(customization)) return;
  disposed.add(customization);
  await customization.dispose();
}

export function registerNativeCustomizationTools(
  registry: ToolRegistry,
  customization: NativeAgentCustomization | undefined,
): () => void {
  const tools = customization?.tools ?? [];
  if (tools.length === 0) return () => undefined;
  for (const tool of tools) {
    if (registry.get(tool.name) !== undefined)
      throw new RuntimeFailure('validation', `Custom tool name collides with ${tool.name}`);
  }
  const owner = `api:${customization!.id}`;
  try {
    for (const tool of tools) registry.register(adaptTool(tool), owner);
  } catch (error) {
    registry.unregisterOwner(owner);
    throw error;
  }
  return () => registry.unregisterOwner(owner);
}

export function installNativeCustomizationLifecycle(
  lifecycle: Map<RuntimeEvent['type'], import('@octocodeai/agent-core').LifecycleBus<unknown>>,
  customization: NativeAgentCustomization | undefined,
): NativeCustomizationLifecycleControl {
  const unsubscribe: (() => void)[] = [];
  const owned = new AbortController();
  const pending = new Set<Promise<void>>();
  const state = { owned, pending };
  for (const hook of customization?.hooks ?? [])
    unsubscribe.push(subscribeHook(lifecycle, customization!.id, hook, state));
  for (const observer of customization?.events ?? [])
    unsubscribe.push(subscribeObserver(lifecycle, customization!.id, observer, state));
  const dispose = (() => {
    for (const dispose of unsubscribe.reverse()) dispose();
  }) as NativeCustomizationLifecycleControl;
  dispose.cancel = () => owned.abort(new RuntimeFailure('cancelled', 'Native API lifecycle was cancelled'));
  dispose.drain = async ({ timeoutMs = 1_000 } = {}) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new RuntimeFailure('validation', 'Native API lifecycle drain timeout must be a positive integer');
    if (pending.size === 0) return { completed: true, pendingAtDeadline: 0 };
    let timeout: NodeJS.Timeout | undefined;
    const settled = (async () => {
      while (pending.size > 0) await Promise.all([...pending]);
      return true as const;
    })();
    const completed = await Promise.race([
      settled,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    return {
      completed,
      pendingAtDeadline: completed ? 0 : pending.size,
    };
  };
  return dispose;
}

export interface NativeCustomizationLifecycleControl {
  (): void;
  cancel(): void;
  drain(options?: Readonly<{ timeoutMs?: number }>): Promise<Readonly<{
    completed: boolean;
    pendingAtDeadline: number;
  }>>;
}

export function nativeProductPolicy(
  base: { readonly version: string; readonly content: string },
  customization: NativeAgentCustomization | undefined,
): { readonly version: string; readonly content: string } {
  const overlay = customization?.productPolicyOverlay;
  if (overlay === undefined) return base;
  const encoded = JSON.stringify({
    schemaVersion: 1,
    id: customization!.id,
    content: overlay.content,
  }).replace(/[<>&\u2028\u2029]/gu, (character) => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  })[character]!);
  const contribution = [
    '<api_product_policy_overlay encoding="json">',
    encoded,
    '</api_product_policy_overlay>',
  ].join('\n');
  const content = overlayContent(base.content, overlay, contribution);
  const digest = createOverlayDigest(customization!.id, overlay);
  return { version: `${base.version}:api:${digest}`, content };
}

function overlayContent(base: string, overlay: ProductPolicyOverlayV1, encoded: string): string {
  if (overlay.mode === 'replace')
    return `Use the following host-supplied product policy as the product authority.\n${encoded}`;
  return overlay.mode === 'prepend' ? `${encoded}\n${base}` : `${base}\n${encoded}`;
}

function createOverlayDigest(id: string, overlay: ProductPolicyOverlayV1): string {
  let hash = 2166136261;
  for (const character of `${id}\0${overlay.mode}\0${overlay.content}`) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function adaptTool(tool: AgentToolV1): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    schemaVersion: tool.schemaVersion,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    outputVersion: tool.outputVersion,
    policy: {
      ...tool.policy,
      effects: tool.policy.effects,
    },
    execute: async (input) => tool.execute({
      input: input.input,
      callId: String(input.callId),
      context: {
        sessionId: String(input.context.sessionId),
        ...(input.context.turnId === undefined ? {} : { turnId: String(input.context.turnId) }),
        cwd: input.context.cwd,
        mode: input.context.mode,
        ...(input.context.outputFormat === undefined ? {} : { outputFormat: input.context.outputFormat }),
        trust: input.context.trust,
      },
      signal: input.signal,
      update: input.update,
    }),
  };
}

function subscribeHook(
  lifecycle: Map<RuntimeEvent['type'], import('@octocodeai/agent-core').LifecycleBus<unknown>>,
  customizationId: string,
  hook: AgentHookV1,
  state: LifecycleExecutionState,
): () => void {
  const bus = ensureNativeLifecycleBus(lifecycle, hook.event);
  return bus.subscribe({
    id: `api:${customizationId}:hook:${hook.id}`,
    source: 'builtin',
    ...(hook.priority === undefined ? {} : { priority: hook.priority }),
    timeoutMs: hook.timeoutMs ?? 30_000,
    handler: async (event) => adaptDecision(await trackLifecycleExecution(
      Promise.resolve(hook.handle(
        projectSensitiveLifecycleEventV1(event, hook.event) as AgentLifecycleSensitiveEventByTypeV1,
        Object.freeze({ signal: state.owned.signal }),
      )),
      state,
    )),
  });
}

function subscribeObserver(
  lifecycle: Map<RuntimeEvent['type'], import('@octocodeai/agent-core').LifecycleBus<unknown>>,
  customizationId: string,
  observer: AgentEventObserverV1,
  state: LifecycleExecutionState,
): () => void {
  const bus = ensureNativeLifecycleBus(lifecycle, observer.event);
  return bus.subscribe({
    id: `api:${customizationId}:event:${observer.id}`,
    source: 'builtin',
    ...(observer.priority === undefined ? {} : { priority: observer.priority }),
    timeoutMs: observer.timeoutMs ?? 30_000,
    handler: async (event) => {
      await trackLifecycleExecution(
        Promise.resolve(observer.observe(
          projectObservedLifecycleEventV1(event, observer.event) as AgentLifecycleObservedEventByTypeV1,
          Object.freeze({ signal: state.owned.signal }),
        )),
        state,
      );
      return { kind: 'continue' };
    },
  });
}

function adaptDecision(value: AgentHookDecisionV1 | void): LifecycleDecision<unknown> {
  if (value === undefined) return { kind: 'continue' };
  if (value.kind === 'rewrite') return { kind: 'rewrite', payload: value.payload };
  return value;
}


interface LifecycleExecutionState {
  readonly owned: AbortController;
  readonly pending: Set<Promise<void>>;
}

function trackLifecycleExecution<T>(
  operation: Promise<T>,
  state: LifecycleExecutionState,
): Promise<T> {
  let settlement: Promise<void>;
  settlement = operation.then(
    () => undefined,
    () => undefined,
  ).finally(() => state.pending.delete(settlement));
  state.pending.add(settlement);
  return operation;
}
