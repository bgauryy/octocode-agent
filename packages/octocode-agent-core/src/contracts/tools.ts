import type { SessionId, ToolCallId, TurnId } from './identity.js';
import type { TrustSnapshot } from './events.js';

export interface JsonSchema { readonly type?: string; readonly properties?: Readonly<Record<string, JsonSchema>>; readonly required?: readonly string[]; readonly items?: JsonSchema; readonly enum?: readonly unknown[]; readonly additionalProperties?: boolean | JsonSchema; readonly [key: string]: unknown; }
export type ToolEffect = 'read' | 'write' | 'network' | 'process' | 'destructive';
export interface ToolPolicyMetadata { readonly effect: ToolEffect; readonly trust: 'none' | 'workspace' | 'managed'; readonly approval: 'never' | 'on-request' | 'always'; readonly plan: 'allowed' | 'forbidden' | 'required'; readonly lockTarget?: (input: unknown) => readonly string[]; }
export interface ToolExecutionUpdate { readonly version: 1; readonly kind: 'progress' | 'status' | 'details'; readonly message?: string; readonly value?: unknown; }
export interface ExecutionContext { readonly sessionId: SessionId; readonly turnId?: TurnId; readonly cwd: string; readonly mode: 'interactive' | 'print' | 'json' | 'rpc' | 'headless'; readonly trust: TrustSnapshot; readonly signal: AbortSignal; }
export interface ToolExecutionInput { readonly input: unknown; readonly callId: ToolCallId; readonly context: ExecutionContext; readonly signal: AbortSignal; readonly update: (update: ToolExecutionUpdate) => Promise<void>; }
export interface ToolResult { readonly ok: boolean; readonly content: unknown; readonly detailsVersion: number; readonly category?: string; }
export interface ToolDefinition { readonly name: string; readonly label: string; readonly description: string; readonly schemaVersion: number; readonly inputSchema: JsonSchema; readonly outputSchema: JsonSchema; readonly outputVersion: number; readonly policy: ToolPolicyMetadata; readonly presentation?: { readonly callLabel?: string; readonly resultLabel?: string }; execute(input: ToolExecutionInput): Promise<ToolResult>; }
