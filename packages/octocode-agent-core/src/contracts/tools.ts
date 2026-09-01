import type { SessionId, ToolCallId, TurnId } from './identity.js';
import type { RuntimeMode, RuntimeOutputFormat, TrustSnapshot } from './events.js';
import { RuntimeFailure } from './errors.js';

export interface JsonSchema {
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly patternProperties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
  readonly propertyNames?: JsonSchema;
  readonly items?: JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
  readonly contains?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
  readonly else?: JsonSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minContains?: number;
  readonly maxContains?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly [key: string]: unknown;
}
export type ToolEffect = 'read' | 'network' | 'process' | 'write' | 'destructive';
export type EffectSet = readonly [ToolEffect, ...ToolEffect[]];
export interface ToolConcurrencyLane {
  readonly lane: string;
  readonly maxActive: number;
}
const TOOL_EFFECT_ORDER: readonly ToolEffect[] = ['read', 'network', 'process', 'write', 'destructive'];
export function createEffectSet(...effects: readonly ToolEffect[]): EffectSet {
  const invalid = effects.find((effect) => !TOOL_EFFECT_ORDER.includes(effect));
  if (invalid !== undefined) throw new RuntimeFailure('validation', `Unknown tool effect: ${String(invalid)}`);
  const unique = new Set(effects);
  const canonical = TOOL_EFFECT_ORDER.filter((effect) => unique.has(effect));
  if (canonical.length === 0) throw new RuntimeFailure('validation', 'Tool effects require at least one capability');
  return Object.freeze(canonical) as unknown as EffectSet;
}
export interface ToolPolicyResolution { readonly effects: EffectSet; readonly trust: 'none' | 'workspace' | 'managed'; readonly approval: 'never' | 'on-request' | 'always'; }
export interface ToolPolicyMetadata extends ToolPolicyResolution { readonly plan: 'allowed' | 'forbidden' | 'required'; readonly resolve?: (input: unknown) => ToolPolicyResolution; readonly lockTarget?: (input: unknown) => readonly string[]; readonly concurrency?: (input: unknown) => ToolConcurrencyLane | undefined; }
export interface ToolExecutionUpdate { readonly version: 1; readonly kind: 'progress' | 'status' | 'details'; readonly message?: string; readonly value?: unknown; }
export interface ExecutionContext { readonly sessionId: SessionId; readonly turnId?: TurnId; readonly cwd: string; readonly mode: RuntimeMode; readonly outputFormat?: RuntimeOutputFormat; readonly trust: TrustSnapshot; readonly signal: AbortSignal; }
export interface ToolExecutionInput { readonly input: unknown; readonly callId: ToolCallId; readonly context: ExecutionContext; readonly signal: AbortSignal; readonly update: (update: ToolExecutionUpdate) => Promise<void>; }
export interface ToolResult { readonly ok: boolean; readonly content: unknown; readonly detailsVersion: number; readonly category?: string; }
export interface ToolDefinition { readonly name: string; readonly label: string; readonly description: string; readonly schemaVersion: number; readonly inputSchema: JsonSchema; readonly outputSchema: JsonSchema; readonly outputVersion: number; readonly policy: ToolPolicyMetadata; readonly presentation?: { readonly callLabel?: string; readonly resultLabel?: string }; execute(input: ToolExecutionInput): Promise<ToolResult>; }
