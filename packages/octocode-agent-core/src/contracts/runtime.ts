import type { RuntimeErrorData } from './errors.js';
import type { RuntimeEvent } from './events.js';
import type { SessionId } from './identity.js';
import type { ModelMessage } from './ports.js';

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
  compact(input: { readonly reason: 'manual' | 'threshold' | 'overflow'; readonly messages: readonly ModelMessage[]; readonly signal: AbortSignal }): Promise<{ readonly summary: string; readonly messages: readonly ModelMessage[] }>;
  cancel?(reason?: string): void | Promise<void>;
}

export type RuntimeCommand =
  | { readonly type: 'input.submit' | 'input.steer' | 'input.follow-up'; readonly text: string }
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
  | { readonly type: 'tools.list' }
  | { readonly type: 'tools.activate'; readonly name: string }
  | { readonly type: 'runtime.snapshot' }
  | { readonly type: 'runtime.stop' };
export type RuntimeCommandResult = { readonly ok: true; readonly data?: unknown } | { readonly ok: false; readonly error: RuntimeErrorData };
export interface RuntimeSnapshot { readonly schemaVersion: 1; readonly state: 'created' | 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed'; readonly sessionId: SessionId; readonly activeTurn: boolean; readonly model: { readonly providerId: string; readonly modelId: string } | null; readonly thinkingLevel: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number; readonly cacheWriteInputTokens?: number }; readonly revision: number; }
export interface AgentRuntime { start(): Promise<void>; submit(input: string): Promise<void>; cancel(reason?: string): Promise<void>; execute(command: RuntimeCommand): Promise<RuntimeCommandResult>; snapshot(): RuntimeSnapshot; subscribe(listener: (event: RuntimeEvent) => void): () => void; stop(): Promise<void>; }
