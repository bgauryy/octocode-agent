import type { AgentEventEnvelope } from './events.js';
import type { SessionId } from './identity.js';
import type { JsonSchema } from './tools.js';
export interface ModelToolDefinition { readonly name: string; readonly description: string; readonly inputSchema: JsonSchema; }
export interface ModelToolCall { readonly id: string; readonly name: string; readonly input: unknown; }
export type ModelMessage =
  | { readonly role: 'system' | 'user'; readonly content: string; readonly toolCallId?: never; readonly toolCalls?: never }
  | { readonly role: 'assistant'; readonly content: string; readonly toolCallId?: never; readonly toolCalls?: readonly ModelToolCall[] }
  | { readonly role: 'tool'; readonly content: string; readonly toolCallId: string; readonly toolCalls?: never };
export interface ModelRequest { readonly messages: readonly ModelMessage[]; readonly model?: { readonly providerId: string; readonly modelId: string }; readonly thinkingLevel?: string; readonly tools?: readonly ModelToolDefinition[]; readonly toolChoice?: 'auto' | 'none' | { readonly name: string }; }
export type ModelDelta = { readonly type: 'text'; readonly text: string } | { readonly type: 'thinking'; readonly text: string } | ({ readonly type: 'tool-call' } & ModelToolCall);
export interface ModelResponse { readonly stop: 'complete' | 'tool' | 'cancelled' | 'length' | 'error'; readonly usage: { readonly inputTokens: number; readonly outputTokens: number }; readonly retryAfterMs?: number; }
export interface ModelPort { run(request: ModelRequest, context: { readonly signal: AbortSignal; readonly emit?: (delta: ModelDelta) => Promise<void> }): Promise<ModelResponse>; }
export interface ProcessPort { execute(request: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly stdin: string; readonly timeoutMs: number }, signal: AbortSignal): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }>; }
export interface TranscriptPort { append(sessionId: SessionId, entry: { readonly role: string; readonly content: string; readonly visibility: 'model' | 'transcript' | 'diagnostics' }): Promise<void>; read(sessionId: SessionId): Promise<readonly { readonly role: string; readonly content: string; readonly visibility: string }[]>; }
export interface RuntimeEventSink { emit(event: AgentEventEnvelope): Promise<void>; }
export interface TrustPolicy { snapshot(cwd: string): Promise<{ readonly workspace: 'trusted' | 'untrusted' | 'unknown'; readonly managedOnly: boolean }>; }
