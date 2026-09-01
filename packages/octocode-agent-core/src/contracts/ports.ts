import type { AgentEventEnvelope } from './events.js';
import type { ModelToolResultV1 } from './artifacts.js';
import { RuntimeFailure } from './errors.js';
import type { SessionId } from './identity.js';
import type { JsonSchema } from './tools.js';
import type { RuntimeUserInputV1 } from './user-input.js';
export {
  assertArtifactDescriptorV1,
  assertModelToolResultV1,
  modelToolResultTextFallback,
} from './artifacts.js';
export type {
  ArtifactDescriptorV1,
  ArtifactKind,
  ModelToolResultImagePartV1,
  ModelToolResultPartV1,
  ModelToolResultTextPartV1,
  ModelToolResultV1,
} from './artifacts.js';
export interface ModelToolDefinition { readonly name: string; readonly description: string; readonly inputSchema: JsonSchema; }
export interface ModelToolCall { readonly id: string; readonly name: string; readonly input: unknown; }
export type ModelMessage =
  | { readonly role: 'system'; readonly content: string; readonly toolCallId?: never; readonly toolCalls?: never; readonly userInput?: never; readonly result?: never }
  | { readonly role: 'user'; readonly content: string; readonly userInput?: RuntimeUserInputV1; readonly toolCallId?: never; readonly toolCalls?: never; readonly result?: never }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCallId?: never; readonly toolCalls?: readonly ModelToolCall[]; readonly result?: never }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string; readonly toolCalls?: never; readonly result?: ModelToolResultV1 };
export interface ModelRequest { readonly messages: readonly ModelMessage[]; readonly model?: { readonly providerId: string; readonly modelId: string }; readonly thinkingLevel?: string; readonly tools?: readonly ModelToolDefinition[]; readonly toolChoice?: 'auto' | 'none' | { readonly name: string }; readonly cache?: { readonly stablePrefixMessageCount: number }; }
export type ModelDelta = { readonly type: 'text'; readonly text: string } | { readonly type: 'thinking'; readonly text: string } | ({ readonly type: 'tool-call' } & ModelToolCall);
export interface ModelResponse { readonly stop: 'complete' | 'tool' | 'cancelled' | 'length' | 'error'; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cachedInputTokens?: number; readonly cacheWriteInputTokens?: number }; readonly retryAfterMs?: number; }
export class ModelContextOverflowError extends RuntimeFailure {
  readonly code = 'model-context-overflow' as const;
  constructor(readonly stage: 'input' | 'generation', message = 'Model context window exceeded') {
    super('model', message, 'unsafe');
    this.name = 'ModelContextOverflowError';
  }
}
export const isInputModelContextOverflow = (error: unknown): boolean =>
  (error instanceof ModelContextOverflowError && error.stage === 'input') ||
  (error instanceof RuntimeFailure && error.safeCause === 'input-overflow');
export interface ModelPort { run(request: ModelRequest, context: { readonly signal: AbortSignal; readonly emit?: (delta: ModelDelta) => Promise<void> }): Promise<ModelResponse>; }
export interface ProcessPort { execute(request: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly stdin: string; readonly timeoutMs: number }, signal: AbortSignal): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }>; }
export interface TranscriptPort { append(sessionId: SessionId, entry: { readonly role: string; readonly content: string; readonly visibility: 'model' | 'transcript' | 'diagnostics' }): Promise<void>; read(sessionId: SessionId): Promise<readonly { readonly role: string; readonly content: string; readonly visibility: string }[]>; }
export interface RuntimeEventSink { emit(event: AgentEventEnvelope): Promise<void>; }
export interface TrustPolicy { snapshot(cwd: string): Promise<{ readonly workspace: 'trusted' | 'untrusted' | 'unknown'; readonly managedOnly: boolean }>; }
