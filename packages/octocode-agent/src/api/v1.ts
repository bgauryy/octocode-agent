import { launchNativeAgent } from '../native-launcher.js';
import { createAgentControlV1 } from '../native-api-control.js';
import { disposeNativeCustomization } from '../native-customization.js';
import {
  parseNativePortableCustomizationDescriptorV1,
  resolveNativePortableCustomizationV1,
  type NativePortableCustomizationDescriptorV1,
} from '../native-portable-customization.js';
import type {
  AgentPresentationFactoryV1,
  AgentPresentationPortV1,
} from '../presentation/v1.js';

export type JsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly JsonValueV1[]
  | { readonly [key: string]: JsonValueV1 };

export interface JsonSchemaV1 {
  readonly [key: string]: JsonValueV1 | undefined;
}

export interface AgentAbortSignalV1 {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AgentReadableV1 extends AsyncIterable<unknown> {
  readonly isTTY?: boolean;
}

export interface AgentWritableV1 {
  write(chunk: string | Uint8Array): unknown;
}

export type AgentEnvironmentV1 = Readonly<Record<string, string | undefined>>;

export type AgentToolEffectV1 =
  | 'read'
  | 'network'
  | 'process'
  | 'write'
  | 'destructive';

export interface AgentToolExecutionInputV1 {
  readonly input: unknown;
  readonly callId: string;
  readonly context: Readonly<{
    sessionId: string;
    turnId?: string;
    cwd: string;
    mode: string;
    outputFormat?: string;
    trust: unknown;
  }>;
  readonly signal: AgentAbortSignalV1;
  readonly update: (update: Readonly<{
    version: 1;
    kind: 'progress' | 'status' | 'details';
    message?: string;
    value?: unknown;
  }>) => Promise<void>;
}

export interface AgentToolV1 {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly inputSchema: JsonSchemaV1;
  readonly outputSchema: JsonSchemaV1;
  readonly outputVersion: number;
  readonly policy: Readonly<{
    effects: readonly [AgentToolEffectV1, ...AgentToolEffectV1[]];
    trust: 'none' | 'workspace' | 'managed';
    approval: 'never' | 'on-request' | 'always';
    plan: 'allowed' | 'forbidden' | 'required';
  }>;
  execute(input: AgentToolExecutionInputV1): Promise<Readonly<{
    ok: boolean;
    content: unknown;
    detailsVersion: number;
    category?: string;
  }>>;
}

export type AgentLifecycleEventTypeV1 =
  | 'session.starting'
  | 'session.stopping'
  | 'input.received'
  | 'tool.requested'
  | 'permission.requested'
  | 'tool.ended'
  | 'context.compaction-started'
  | 'context.compacted'
  | 'worker.started'
  | 'worker.stopped'
  | 'agent.ended';

export type AgentControlEventTypeV1 =
  | 'runtime.ready' | 'runtime.stopping' | 'runtime.stopped' | 'runtime.failed'
  | 'session.starting' | 'session.started' | 'session.switching' | 'session.forked'
  | 'session.tree-changed' | 'session.metadata-changed' | 'session.stopping'
  | 'session.before-switch' | 'session.before-fork'
  | 'input.received' | 'input.transformed' | 'input.handled' | 'input.queued' | 'input.rejected'
  | 'agent.starting' | 'agent.started' | 'agent.settled' | 'agent.ended'
  | 'turn.started' | 'turn.ended'
  | 'message.started' | 'message.delta' | 'message.ended'
  | 'tool.requested' | 'permission.requested' | 'tool.blocked' | 'tool.started'
  | 'tool.updated' | 'tool.ended'
  | 'worker.started' | 'worker.stopped'
  | 'model.selected' | 'model.thinking-level-selected'
  | 'provider.request-started' | 'provider.response-received' | 'provider.failed'
  | 'context.appended' | 'context.usage-changed' | 'context.compaction-started'
  | 'context.compaction-retrying' | 'context.compacted' | 'context.compaction-failed'
  | 'ui.interaction-requested' | 'ui.interaction-resolved' | 'ui.notification'
  | 'ui.status-changed' | 'ui.presentation-changed'
  | 'resources.discovering' | 'resources.discovered'
  | 'trust.resolving' | 'trust.resolved'
  | 'prompt.assembling' | 'prompt.assembled' | 'context.preparing' | 'agent.before-start'
  | 'settings.changed' | 'plugin.lifecycle';

export interface AgentPublicEventMetadataV1 {
  readonly id: string;
  readonly type: string;
  readonly phase: 'before' | 'permission' | 'after' | 'notification';
  readonly sessionId: string;
  readonly timestamp: number;
  readonly cwd?: string;
  readonly mode: 'interactive' | 'print' | 'json' | 'rpc' | 'headless' | 'acp';
  readonly outputFormat?: 'text' | 'json';
  readonly model?: Readonly<{ providerId: string; modelId: string }>;
  readonly trust: Readonly<{
    workspace: 'trusted' | 'untrusted' | 'unknown';
    managedOnly: boolean;
  }>;
  readonly [key: string]: unknown;
}

export interface AgentOpaqueRedactedPayloadV1 {
  readonly callId?: string | number | boolean | null;
  readonly name?: string | number | boolean | null;
  readonly outcome?: string | number | boolean | null;
  readonly category?: string | number | boolean | null;
  readonly source?: string | number | boolean | null;
  readonly workerId?: string | number | boolean | null;
  readonly turnId?: string | number | boolean | null;
  readonly stop?: string | number | boolean | null;
  readonly status?: string | number | boolean | null;
  readonly current?: string | number | boolean | null;
  readonly total?: string | number | boolean | null;
  readonly attempt?: string | number | boolean | null;
}

interface AgentKnownControlPayloadMapV1 {
  readonly 'runtime.ready': Readonly<Record<string, never>>;
  readonly 'runtime.stopping': Readonly<Record<string, never>>;
  readonly 'runtime.stopped': Readonly<Record<string, never>>;
  readonly 'runtime.failed': Readonly<Record<string, never>>;
  readonly 'session.starting': Readonly<Record<string, never>>;
  readonly 'session.stopping': Readonly<Record<string, never>>;
  readonly 'input.received': Readonly<{ source?: string }>;
  readonly 'input.queued': Readonly<Record<string, never>>;
  readonly 'input.rejected': Readonly<Record<string, never>>;
  readonly 'agent.ended': Readonly<{ turnId: string; stop: string }>;
  readonly 'turn.started': Readonly<{ turnId: string }>;
  readonly 'turn.ended': Readonly<{ turnId: string; stop: string }>;
  readonly 'tool.requested': Readonly<{ callId: string; name: string }>;
  readonly 'permission.requested': Readonly<{ callId: string; name: string }>;
  readonly 'tool.blocked': Readonly<{ callId: string; name: string; category?: string }>;
  readonly 'tool.started': Readonly<{ callId: string; name: string }>;
  readonly 'tool.updated': Readonly<{ callId: string; name: string }>;
  readonly 'tool.ended': Readonly<{ callId: string; name: string; outcome: string; category?: string }>;
  readonly 'worker.started': Readonly<{ workerId: string }>;
  readonly 'worker.stopped': Readonly<{ workerId: string }>;
  readonly 'context.compaction-started': Readonly<Record<string, never>>;
  readonly 'context.compacted': Readonly<Record<string, never>>;
  readonly 'context.compaction-failed': Readonly<{ category: string }>;
  readonly 'context.usage-changed': Readonly<Record<string, never>>;
  readonly 'context.appended': Readonly<Record<string, never>>;
  readonly 'message.started': Readonly<{ attempt: number }>;
  readonly 'message.delta': Readonly<{ name?: string }>;
  readonly 'message.ended': Readonly<{ status: 'complete' | 'cancelled' | 'error' }>;
  readonly 'provider.request-started': Readonly<{ attempt: number }>;
  readonly 'provider.response-received': Readonly<{ attempt: number; stop: string }>;
  readonly 'provider.failed': Readonly<{ attempt?: number; category?: string }>;
}

export type AgentControlPayloadMapV1 = Readonly<{
  [TType in AgentControlEventTypeV1]: TType extends keyof AgentKnownControlPayloadMapV1
    ? AgentKnownControlPayloadMapV1[TType]
    : Readonly<AgentOpaqueRedactedPayloadV1>;
}>;

export interface AgentLifecycleSensitivePayloadMapV1 {
  readonly 'session.starting': Readonly<{ reason?: string }>;
  readonly 'session.stopping': Readonly<{ reason?: string }>;
  readonly 'input.received': Readonly<{ text: string; kind?: 'steer' | 'follow-up'; source?: string }>;
  readonly 'tool.requested': Readonly<{ callId: string; name: string; input: unknown; origin?: 'runtime' }>;
  readonly 'permission.requested': Readonly<{ callId: string; name: string; input: unknown; policy: unknown }>;
  readonly 'tool.ended': Readonly<{
    callId: string;
    name: string;
    outcome: 'success' | 'failed' | 'blocked' | 'cancelled' | 'error';
    input?: unknown;
    result?: unknown;
    error?: unknown;
    message?: string;
    category?: string;
  }>;
  readonly 'context.compaction-started': Readonly<{ reason: 'manual' | 'threshold' | 'overflow' }>;
  readonly 'context.compacted': Readonly<{ reason: 'manual' | 'threshold' | 'overflow'; summary: string }>;
  readonly 'worker.started': Readonly<{ workerId: string; agentType?: string; state: 'running' }>;
  readonly 'worker.stopped': Readonly<{
    workerId: string;
    agentType?: string;
    state: 'succeeded' | 'failed' | 'aborted' | 'killed';
  }>;
  readonly 'agent.ended': Readonly<{ turnId: string; stop: string }>;
}

export type AgentLifecycleRedactedPayloadMapV1 = Readonly<{
  [TEvent in AgentLifecycleEventTypeV1]: AgentControlPayloadMapV1[TEvent];
}>;

export interface AgentLifecycleEventV1<
  TEvent extends AgentLifecycleEventTypeV1 = AgentLifecycleEventTypeV1,
  TClassification extends 'sensitive' | 'redacted' = 'sensitive' | 'redacted',
> extends AgentPublicEventMetadataV1 {
  readonly schemaVersion: 1;
  readonly type: TEvent;
  readonly eventType: TEvent;
  readonly dataClassification: TClassification;
  readonly payload: TClassification extends 'sensitive'
    ? AgentLifecycleSensitivePayloadMapV1[TEvent]
    : AgentLifecycleRedactedPayloadMapV1[TEvent];
}

export type AgentLifecycleSensitiveEventByTypeV1 = {
  [TEvent in AgentLifecycleEventTypeV1]: AgentLifecycleEventV1<TEvent, 'sensitive'>;
}[AgentLifecycleEventTypeV1];

export type AgentLifecycleObservedEventByTypeV1 = {
  [TEvent in AgentLifecycleEventTypeV1]: AgentLifecycleEventV1<TEvent, 'redacted'>;
}[AgentLifecycleEventTypeV1];

export type AgentHookDecisionV1 =
  | { readonly kind: 'continue' | 'allow' | 'no-decision' }
  | { readonly kind: 'deny' | 'stop'; readonly reason: string }
  | { readonly kind: 'rewrite'; readonly payload: unknown }
  | { readonly kind: 'context'; readonly text: string };

export interface AgentHookV1 {
  readonly id: string;
  readonly event: AgentLifecycleEventTypeV1;
  readonly priority?: number;
  readonly timeoutMs?: number;
  handle(
    event: AgentLifecycleSensitiveEventByTypeV1,
    context: Readonly<{ signal: AgentAbortSignalV1 }>,
  ): Promise<AgentHookDecisionV1 | void>;
}

export interface AgentEventObserverV1 {
  readonly id: string;
  readonly event: AgentLifecycleEventTypeV1;
  readonly priority?: number;
  readonly timeoutMs?: number;
  observe(
    event: AgentLifecycleObservedEventByTypeV1,
    context: Readonly<{ signal: AgentAbortSignalV1 }>,
  ): Promise<void> | void;
}

export interface AgentCompactionMessageV1 {
  readonly eventId: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: unknown;
}

export interface AgentCompactionV1 {
  readonly inputTokenThreshold?: number;
  readonly summarize?: (input: Readonly<{
    messages: readonly AgentCompactionMessageV1[];
    reason: 'manual' | 'threshold' | 'overflow';
    attempt: number;
    context: readonly string[];
    signal: AgentAbortSignalV1;
  }>) => Promise<Readonly<{
    summary: string;
    retainedEventIds: readonly string[];
  }>>;
}

export interface ProductPolicyOverlayV1 {
  readonly mode: 'prepend' | 'append' | 'replace';
  readonly content: string;
}

export type AgentPortableContributionSelectorV1 =
  | `tool:${string}`
  | `hook:${string}`
  | `event:${string}`
  | 'compaction';

export interface AgentPortableCustomizationEntrypointV1 {
  readonly kind: 'module';
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly integrity: `sha256-${string}`;
}

/**
 * A callback-free factory descriptor that can be verified and activated in both
 * the root process and a native worker. The module must be a self-contained ESM
 * file; its transitive imports are part of the caller's trust boundary.
 */
export interface AgentPortableCustomizationV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly entrypoint: AgentPortableCustomizationEntrypointV1;
  readonly config?: JsonValueV1;
  readonly workerContributions: readonly AgentPortableContributionSelectorV1[];
}

export interface AgentPortableContributionSetV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly productPolicyOverlay?: ProductPolicyOverlayV1;
  readonly tools?: readonly AgentToolV1[];
  readonly hooks?: readonly AgentHookV1[];
  readonly events?: readonly AgentEventObserverV1[];
  readonly compaction?: AgentCompactionV1;
  readonly dispose?: () => Promise<void> | void;
}

export interface AgentPortableCustomizationFactoryContextV1 {
  readonly schemaVersion: 1;
  readonly target: 'root' | 'worker';
  readonly config?: JsonValueV1;
}

export type AgentPortableCustomizationFactoryV1 = (
  context: AgentPortableCustomizationFactoryContextV1,
) => AgentPortableContributionSetV1 | Promise<AgentPortableContributionSetV1>;

export interface AgentControlSnapshotV1 {
  readonly schemaVersion: 1;
  readonly state: 'created' | 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed';
  readonly sessionId: string;
  readonly activeTurn: boolean;
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
  readonly thinkingLevel: string | null;
  readonly usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  }>;
  readonly revision: number;
}

export interface AgentControlEventV1<
  TType extends AgentControlEventTypeV1 = AgentControlEventTypeV1,
> extends AgentPublicEventMetadataV1 {
  readonly schemaVersion: 1;
  readonly type: TType;
  readonly dataClassification: 'redacted';
  readonly payload: AgentControlPayloadMapV1[TType];
}

export type AgentControlEventByTypeV1 = {
  [TType in AgentControlEventTypeV1]: AgentControlEventV1<TType>;
}[AgentControlEventTypeV1];

export interface AgentControlV1 {
  submit(input: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
  snapshot(): AgentControlSnapshotV1;
  subscribe(listener: (event: AgentControlEventByTypeV1) => void): () => void;
  stop(): Promise<void>;
}

export interface OctocodeAgentCustomizationV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly productPolicyOverlay?: ProductPolicyOverlayV1;
  readonly tools?: readonly AgentToolV1[];
  readonly hooks?: readonly AgentHookV1[];
  readonly events?: readonly AgentEventObserverV1[];
  readonly compaction?: AgentCompactionV1;
  readonly portable?: AgentPortableCustomizationV1;
  readonly presentation?: AgentPresentationFactoryV1;
  readonly dispose?: () => Promise<void> | void;
}

export interface LaunchOctocodeAgentV1Options {
  readonly argv?: readonly string[];
  readonly customization?: OctocodeAgentCustomizationV1;
  readonly env?: AgentEnvironmentV1;
  readonly cwd?: string;
  readonly stdin?: AgentReadableV1;
  readonly stdout?: AgentWritableV1;
  readonly stderr?: AgentWritableV1;
  readonly version?: string;
  readonly onControl?: (control: AgentControlV1) => void;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_TYPES = new Set<AgentLifecycleEventTypeV1>([
  'session.starting',
  'session.stopping',
  'input.received',
  'tool.requested',
  'permission.requested',
  'tool.ended',
  'context.compaction-started',
  'context.compacted',
  'worker.started',
  'worker.stopped',
  'agent.ended',
]);

export function defineOctocodeAgentV1(
  input: OctocodeAgentCustomizationV1,
): Readonly<OctocodeAgentCustomizationV1> {
  assertPlainObject(input, 'customization');
  assertKeys(input, [
    'schemaVersion', 'id', 'productPolicyOverlay', 'tools', 'hooks', 'events',
    'compaction', 'portable', 'presentation', 'dispose',
  ], 'customization');
  if (input.schemaVersion !== 1) throw new TypeError('customization.schemaVersion must be 1');
  assertId(input.id, 'customization.id');
  if (input.productPolicyOverlay !== undefined) validateOverlay(input.productPolicyOverlay);
  validateContributions(input.tools, 'tools', validateTool);
  validateContributions(input.hooks, 'hooks', validateHook);
  validateContributions(input.events, 'events', validateObserver);
  if (input.compaction !== undefined) validateCompaction(input.compaction);
  if (input.portable !== undefined) {
    const portable = parsePortable(input.portable);
    if (portable.id !== input.id)
      throw new TypeError('customization.portable.id must match customization.id');
    if (input.productPolicyOverlay !== undefined || input.tools !== undefined ||
        input.hooks !== undefined || input.events !== undefined || input.compaction !== undefined)
      throw new TypeError('customization.portable cannot be combined with inline runtime contributions');
  }
  if (input.presentation !== undefined && typeof input.presentation !== 'function')
    throw new TypeError('customization.presentation must be a function');
  if (input.dispose !== undefined && typeof input.dispose !== 'function')
    throw new TypeError('customization.dispose must be a function');
  const ids = [
    ...(input.tools ?? []).map(({ id }) => `tool:${id}`),
    ...(input.hooks ?? []).map(({ id }) => `hook:${id}`),
    ...(input.events ?? []).map(({ id }) => `event:${id}`),
  ];
  if (new Set(ids).size !== ids.length) throw new TypeError('customization contribution ids must be unique');
  const toolNames = (input.tools ?? []).map(({ name }) => name);
  if (new Set(toolNames).size !== toolNames.length)
    throw new TypeError(`duplicate custom tool name ${toolNames.find((name, index) => toolNames.indexOf(name) !== index)}`);
  return deepFreeze(cloneCustomization(input));
}

export async function launchOctocodeAgentV1(
  options: LaunchOctocodeAgentV1Options = {},
): Promise<number> {
  assertPlainObject(options, 'launch options');
  assertKeys(options, [
    'argv', 'customization', 'env', 'cwd', 'stdin', 'stdout', 'stderr', 'version',
    'onControl',
  ], 'launch options');
  if (options.onControl !== undefined && typeof options.onControl !== 'function')
    throw new TypeError('launch options.onControl must be a function');
  const definition = options.customization === undefined
    ? undefined
    : defineOctocodeAgentV1(options.customization);
  const argv = Object.freeze([...(options.argv ?? [])]);
  if (argv.includes('--allow-workers') && customizationHasCallbacks(definition))
    throw new TypeError('callback customizations are unavailable with --allow-workers');
  const env = { ...(options.env ?? process.env) };
  const portableResolution = definition?.portable === undefined
    ? undefined
    : await resolveNativePortableCustomizationV1(
        definition.portable as NativePortableCustomizationDescriptorV1,
        { target: 'root' },
      );
  const customization = portableResolution === undefined
    ? definition
    : mergePortableCustomization(definition!, portableResolution.customization);
  const controlSubscriptions = new Set<() => void>();
  try {
    return await launchNativeAgent(argv, {
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin as import('node:stream').Readable }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout as import('node:stream').Writable }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr as import('node:stream').Writable }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.onControl === undefined ? {} : {
      onRuntime: (runtime) => {
        const control = createAgentControlV1(runtime, controlSubscriptions);
        options.onControl!(control);
      },
    }),
    ...(customization === undefined ? {} : { customization }),
    ...(portableResolution === undefined
      ? {}
      : { workerCustomization: portableResolution.descriptor }),
    ...(customization?.presentation === undefined
      ? {}
      : {
          createTerminal: (context: {
            cwd: string;
            alternateOutput: boolean;
            reducedMotion: boolean;
          }) => customization.presentation!({ schemaVersion: 1, ...context }) as AgentPresentationPortV1,
        }),
    });
  } finally {
    for (const unsubscribe of controlSubscriptions) unsubscribe();
    controlSubscriptions.clear();
    await disposeNativeCustomization(customization);
  }
}

function customizationHasCallbacks(value: Readonly<OctocodeAgentCustomizationV1> | undefined): boolean {
  return value !== undefined && Boolean(
    !value.portable && (value.presentation || value.dispose || value.tools?.length || value.hooks?.length ||
    value.events?.length || value.compaction?.summarize),
  );
}

function cloneCustomization(input: OctocodeAgentCustomizationV1): OctocodeAgentCustomizationV1 {
  return {
    schemaVersion: 1,
    id: input.id,
    ...(input.productPolicyOverlay === undefined ? {} : {
      productPolicyOverlay: { ...input.productPolicyOverlay },
    }),
    ...(input.tools === undefined ? {} : {
      tools: input.tools.map((tool) => ({
        ...tool,
        inputSchema: cloneJson(tool.inputSchema),
        outputSchema: cloneJson(tool.outputSchema),
        policy: { ...tool.policy, effects: [...tool.policy.effects] },
      })),
    }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks.map((hook) => ({ ...hook })) }),
    ...(input.events === undefined ? {} : { events: input.events.map((event) => ({ ...event })) }),
    ...(input.compaction === undefined ? {} : { compaction: { ...input.compaction } }),
    ...(input.portable === undefined ? {} : { portable: parsePortable(input.portable) }),
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    ...(input.dispose === undefined ? {} : { dispose: input.dispose }),
  };
}

function parsePortable(input: AgentPortableCustomizationV1): AgentPortableCustomizationV1 {
  // The native parser is the single strict validator for the transport form.
  return parseNativePortableCustomizationDescriptorV1(input) as AgentPortableCustomizationV1;
}

function mergePortableCustomization(
  definition: Readonly<OctocodeAgentCustomizationV1>,
  portable: Readonly<OctocodeAgentCustomizationV1>,
): Readonly<OctocodeAgentCustomizationV1> {
  const rootDispose = definition.dispose;
  const portableDispose = portable.dispose;
  return deepFreeze({
    ...portable,
    ...(definition.presentation === undefined ? {} : { presentation: definition.presentation }),
    ...(rootDispose === undefined && portableDispose === undefined
      ? {}
      : {
          dispose: async () => {
            await portableDispose?.();
            await rootDispose?.();
          },
        }),
  });
}

function validateOverlay(value: ProductPolicyOverlayV1): void {
  assertPlainObject(value, 'productPolicyOverlay');
  assertKeys(value, ['mode', 'content'], 'productPolicyOverlay');
  if (!['prepend', 'append', 'replace'].includes(value.mode))
    throw new TypeError('productPolicyOverlay.mode is invalid');
  if (typeof value.content !== 'string' || !value.content.trim())
    throw new TypeError('productPolicyOverlay.content must be non-empty');
  if (Buffer.byteLength(value.content) > 128 * 1024)
    throw new TypeError('productPolicyOverlay.content exceeds 128 KiB');
}

function validateTool(value: AgentToolV1): void {
  assertPlainObject(value, 'tool');
  assertKeys(value, [
    'id', 'name', 'label', 'description', 'schemaVersion', 'inputSchema',
    'outputSchema', 'outputVersion', 'policy', 'execute',
  ], 'tool');
  assertId(value.id, 'tool.id');
  assertId(value.name, 'tool.name');
  if (typeof value.label !== 'string' || !value.label.trim()) throw new TypeError('tool.label is required');
  if (typeof value.description !== 'string' || !value.description.trim()) throw new TypeError('tool.description is required');
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1) throw new TypeError('tool.schemaVersion is invalid');
  if (!Number.isSafeInteger(value.outputVersion) || value.outputVersion < 1) throw new TypeError('tool.outputVersion is invalid');
  assertPlainObject(value.inputSchema, 'tool.inputSchema');
  assertPlainObject(value.outputSchema, 'tool.outputSchema');
  assertPlainObject(value.policy, 'tool.policy');
  assertKeys(value.policy, ['effects', 'trust', 'approval', 'plan'], 'tool.policy');
  if (!Array.isArray(value.policy.effects) || value.policy.effects.length === 0) throw new TypeError('tool.policy.effects is required');
  const effects = value.policy.effects;
  if (effects.some((effect) => !['read', 'network', 'process', 'write', 'destructive'].includes(effect)) ||
      new Set(effects).size !== effects.length)
    throw new TypeError('tool.policy.effects is invalid');
  if (!['none', 'workspace', 'managed'].includes(value.policy.trust))
    throw new TypeError('tool.policy.trust is invalid');
  if (!['never', 'on-request', 'always'].includes(value.policy.approval))
    throw new TypeError('tool.policy.approval is invalid');
  if (!['allowed', 'forbidden', 'required'].includes(value.policy.plan))
    throw new TypeError('tool.policy.plan is invalid');
  if (typeof value.execute !== 'function') throw new TypeError('tool.execute must be a function');
}

function validateHook(value: AgentHookV1): void {
  assertPlainObject(value, 'hook');
  assertKeys(value, ['id', 'event', 'priority', 'timeoutMs', 'handle'], 'hook');
  assertId(value.id, 'hook.id');
  assertEvent(value.event, 'hook.event');
  validateSubscriptionTiming(value, 'hook');
  if (typeof value.handle !== 'function') throw new TypeError('hook.handle must be a function');
}

function validateObserver(value: AgentEventObserverV1): void {
  assertPlainObject(value, 'event observer');
  assertKeys(value, ['id', 'event', 'priority', 'timeoutMs', 'observe'], 'event observer');
  assertId(value.id, 'event.id');
  assertEvent(value.event, 'event.event');
  validateSubscriptionTiming(value, 'event');
  if (typeof value.observe !== 'function') throw new TypeError('event.observe must be a function');
}

function validateSubscriptionTiming(value: { priority?: number; timeoutMs?: number }, label: string): void {
  if (value.priority !== undefined && (!Number.isSafeInteger(value.priority) || value.priority < -10_000 || value.priority > 10_000))
    throw new TypeError(`${label}.priority is invalid`);
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60_000))
    throw new TypeError(`${label}.timeoutMs is invalid`);
}

function validateCompaction(value: AgentCompactionV1): void {
  assertPlainObject(value, 'compaction');
  assertKeys(value, ['inputTokenThreshold', 'summarize'], 'compaction');
  if (value.inputTokenThreshold !== undefined &&
      (!Number.isSafeInteger(value.inputTokenThreshold) || value.inputTokenThreshold < 4_096 || value.inputTokenThreshold > 2_000_000))
    throw new TypeError('compaction.inputTokenThreshold must be between 4096 and 2000000');
  if (value.summarize !== undefined && typeof value.summarize !== 'function')
    throw new TypeError('compaction.summarize must be a function');
}

function validateContributions<T extends { readonly id: string }>(
  values: readonly T[] | undefined,
  label: string,
  validate: (value: T) => void,
): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) throw new TypeError(`customization.${label} must be an array`);
  for (const value of values) validate(value);
  if (new Set(values.map(({ id }) => id)).size !== values.length)
    throw new TypeError(`customization.${label} ids must be unique`);
}

function assertEvent(value: unknown, label: string): asserts value is AgentLifecycleEventTypeV1 {
  if (typeof value !== 'string' || !EVENT_TYPES.has(value as AgentLifecycleEventTypeV1))
    throw new TypeError(`${label} is unsupported`);
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertPlainObject(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TypeError(`${label} has unknown field ${extras[0]}`);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
