import type { RuntimeErrorData } from './errors.js';
import type { RuntimeEvent } from './events.js';
import type { ContextProjectionReceiptV1 } from './context-artifacts.js';
import type { SessionId } from './identity.js';
import type { ModelMessage, ModelRequest } from './ports.js';
import type { RuntimeUserInputV1 } from './user-input.js';

export interface RuntimePlanPolicySnapshot {
  readonly authority: 'runtime';
  readonly revision: number;
  readonly active: boolean;
}

export interface RuntimePlanStateProvider {
  snapshot(): RuntimePlanPolicySnapshot;
}

export interface RuntimePlanStateUpdater {
  update(snapshot: RuntimePlanPolicySnapshot): void;
}
export interface RuntimeCompactionPort {
  compact(input: { readonly reason: 'manual' | 'threshold' | 'overflow'; readonly messages: readonly ModelMessage[]; readonly stablePrefix: readonly ModelMessage[]; readonly context: readonly string[]; readonly signal: AbortSignal }): Promise<{ readonly summary: string; readonly messages: readonly ModelMessage[]; readonly contextProjectionReceipt?: ContextProjectionReceiptV1 }>;
  cancel?(reason?: string): void | Promise<void>;
}

export interface RuntimeContextTokenMeterPort {
  measure(request: ModelRequest, context: { readonly signal: AbortSignal }): number | Promise<number>;
}

export type RuntimeCommand =
  | ({ readonly type: 'input.submit' | 'input.steer' | 'input.follow-up' } & (
      | { readonly text: string; readonly input?: never }
      | { readonly input: RuntimeUserInputV1; readonly text?: never }
    ))
  | { readonly type: 'input.cancel'; readonly reason?: string }
  | { readonly type: 'session.create'; readonly id?: string; readonly name?: string }
  | { readonly type: 'session.resume' | 'session.switch' | 'session.fork'; readonly id: string }
  | { readonly type: 'session.navigate'; readonly direction: 'parent' | 'child' | 'previous' | 'next' }
  | { readonly type: 'session.name'; readonly name: string }
  | { readonly type: 'session.export' }
  | { readonly type: 'model.select'; readonly providerId: string; readonly modelId: string }
  | { readonly type: 'model.thinking'; readonly level: string }
  | { readonly type: 'context.compact'; readonly reason: 'manual' | 'threshold' | 'overflow' }
  | { readonly type: 'context.cancel-compaction' }
  | { readonly type: 'context.usage' }
  | { readonly type: 'context.append'; readonly eventId: string; readonly text: string; readonly provenance: 'peer-attributed-data' }
  | { readonly type: 'tool.execute'; readonly operationId: string; readonly name: string; readonly input: unknown; readonly signal?: AbortSignal }
  | { readonly type: 'tools.list' }
  | { readonly type: 'tools.activate'; readonly name: string }
  | { readonly type: 'monitoring.snapshot' }
  | { readonly type: 'runtime.snapshot' }
  | { readonly type: 'runtime.stop' };
export type RuntimeCommandResult = { readonly ok: true; readonly data?: unknown } | { readonly ok: false; readonly error: RuntimeErrorData };
export interface MonitoringAggregate { readonly count: number; readonly sum: number; readonly min: number | null; readonly max: number | null; }
export interface NativeMonitoringContributionV1 {
  readonly cache?: {
    readonly hits: number;
    readonly misses: number;
    readonly loads: number;
    readonly loadFailures: number;
    readonly expirations: number;
    readonly evictions: number;
    readonly entries: number;
    readonly maxEntries: number;
    readonly ttlMs: number;
  };
}
export interface NativeMonitoringPort { snapshot(): NativeMonitoringContributionV1; }
export interface MonitoringSnapshotV1 {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly sessionId: SessionId;
  readonly model: { readonly providerId: string; readonly modelId: string } | null;
  readonly usage: RuntimeSnapshot['usage'];
  readonly provider: {
    readonly requests: number;
    readonly responses: number;
    readonly failures: number;
    readonly retries: number;
    readonly cancellations: number;
    readonly durationMs: MonitoringAggregate;
    readonly ttftMs: MonitoringAggregate;
    readonly byErrorCategory: Readonly<Partial<Record<RuntimeErrorData['category'], number>>>;
  };
  readonly native?: NativeMonitoringContributionV1;
}
export interface RuntimeSnapshot { readonly schemaVersion: 1; readonly state: 'created' | 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed'; readonly sessionId: SessionId; readonly activeTurn: boolean; readonly model: { readonly providerId: string; readonly modelId: string } | null; readonly thinkingLevel: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number; readonly cacheWriteInputTokens?: number }; readonly revision: number; }
export interface AgentRuntime { start(): Promise<void>; submit(input: string | RuntimeUserInputV1): Promise<void>; cancel(reason?: string): Promise<void>; execute(command: RuntimeCommand): Promise<RuntimeCommandResult>; snapshot(): RuntimeSnapshot; subscribe(listener: (event: RuntimeEvent) => void): () => void; stop(): Promise<void>; }
