import type { ModelRef, TrustSnapshot } from './events.js';
import type { SessionId, TurnId } from './identity.js';

export type SemanticContextSliceKind = 'symbol' | 'relation' | 'type' | 'diagnostic' | 'source';
export type SemanticContextProof = 'ast' | 'lsp' | 'text';
export type SemanticContextFreshness = 'fresh' | 'stale' | 'unknown';
export type SemanticContextDegradationCode =
  | 'language-server-missing'
  | 'language-server-stale'
  | 'unsupported-language'
  | 'dependency-graph-unavailable'
  | 'budget-exhausted'
  | 'duplicate-evidence';

export interface SemanticSourceRangeV1 {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface SemanticContextProvenanceV1 {
  readonly workspaceRoot: string;
  /** Canonical workspace-relative path. Host adapters must contain LSP URIs before projection. */
  readonly path: string;
  readonly range?: SemanticSourceRangeV1;
  readonly sha256: string;
  readonly proof: SemanticContextProof;
  readonly tool: string;
  readonly server?: string;
  readonly serverVersion?: string;
  readonly observedAt: number;
  readonly complete: boolean;
}

export interface SemanticContextSliceV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: SemanticContextSliceKind;
  readonly content: string;
  readonly provenance: SemanticContextProvenanceV1;
  readonly freshness: {
    readonly state: SemanticContextFreshness;
    readonly checkedAt: number;
    readonly documentVersion?: string;
  };
}

export interface SemanticContextDegradationV1 {
  readonly code: SemanticContextDegradationCode;
  readonly fallback: 'text' | 'none';
  readonly detail?: string;
}

export interface SemanticContextManifestV1 {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly generatedAt: number;
  readonly slices: readonly SemanticContextSliceV1[];
  readonly degradations: readonly SemanticContextDegradationV1[];
}

export interface SemanticContextRequestV1 {
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly workspaceRoot: string;
  readonly query: string;
  readonly iteration: number;
  readonly budget: { readonly maxTokens: number };
  readonly trust: TrustSnapshot;
  readonly model?: ModelRef;
  readonly signal: AbortSignal;
}

/**
 * Host adapter for AST/LSP evidence. The return is deliberately unknown: core
 * strictly decodes every provider response before it can reach model context.
 */
export interface SemanticContextProviderPort {
  prepare(request: SemanticContextRequestV1): Promise<unknown>;
}

export interface ContextTokenMeasurement {
  readonly upperBoundTokens: number;
  readonly method: string;
  readonly exact: boolean;
}

export interface ContextTokenMeter {
  measure(text: string, model?: ModelRef): ContextTokenMeasurement;
}

export interface SemanticContextRuntimeOptions {
  readonly provider: SemanticContextProviderPort;
  readonly maxTokens?: number;
  readonly tokenMeter?: ContextTokenMeter;
}

export interface SemanticContextValidationOptions {
  readonly workspaceRoot: string;
  readonly maxSlices?: number;
}

const MAX_SLICES = 64;
const MAX_DEGRADATIONS = 32;
const MAX_QUERY_LENGTH = 16_384;
const MAX_CONTENT_LENGTH = 65_536;
const MAX_DETAIL_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 512;
const SHA256 = /^[a-f0-9]{64}$/u;
const KINDS = new Set<SemanticContextSliceKind>(['symbol', 'relation', 'type', 'diagnostic', 'source']);
const PROOFS = new Set<SemanticContextProof>(['ast', 'lsp', 'text']);
const FRESHNESS = new Set<SemanticContextFreshness>(['fresh', 'stale', 'unknown']);
const DEGRADATIONS = new Set<SemanticContextDegradationCode>([
  'language-server-missing',
  'language-server-stale',
  'unsupported-language',
  'dependency-graph-unavailable',
  'budget-exhausted',
  'duplicate-evidence',
]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const finiteTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const boundedString = (value: unknown, name: string, maximum = MAX_IDENTIFIER_LENGTH): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0'))
    throw new TypeError(`Invalid semantic context ${name}`);
  return value;
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], name: string): void => {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new TypeError(`Invalid semantic context ${name} field`);
};

function sourceRange(value: unknown): SemanticSourceRangeV1 {
  if (!record(value)) throw new TypeError('Invalid semantic context range');
  exactKeys(value, ['startLine', 'startColumn', 'endLine', 'endColumn'], 'range');
  const startLine = value.startLine;
  const startColumn = value.startColumn;
  const endLine = value.endLine;
  const endColumn = value.endColumn;
  if (!nonNegativeInteger(startLine) || startLine < 1 || !nonNegativeInteger(endLine) || endLine < startLine
    || !nonNegativeInteger(startColumn) || !nonNegativeInteger(endColumn)
    || (endLine === startLine && endColumn < startColumn)) throw new TypeError('Invalid semantic context range');
  return { startLine, startColumn, endLine, endColumn };
}

function provenance(value: unknown, workspaceRoot: string): SemanticContextProvenanceV1 {
  if (!record(value)) throw new TypeError('Invalid semantic context provenance');
  exactKeys(value, ['workspaceRoot', 'path', 'range', 'sha256', 'proof', 'tool', 'server', 'serverVersion', 'observedAt', 'complete'], 'provenance');
  if (value.workspaceRoot !== workspaceRoot) throw new TypeError('Invalid semantic context provenance workspaceRoot');
  const sourcePath = boundedString(value.path, 'provenance path', 4_096);
  if (sourcePath.startsWith('/') || sourcePath.startsWith('\\') || /^[A-Za-z]:/u.test(sourcePath)
    || sourcePath.includes('\\') || sourcePath.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw new TypeError('Invalid semantic context provenance path');
  const sha256 = boundedString(value.sha256, 'provenance sha256', 64);
  if (!SHA256.test(sha256)) throw new TypeError('Invalid semantic context provenance sha256');
  if (!PROOFS.has(value.proof as SemanticContextProof)) throw new TypeError('Invalid semantic context provenance proof');
  if (!finiteTimestamp(value.observedAt)) throw new TypeError('Invalid semantic context provenance observedAt');
  if (typeof value.complete !== 'boolean') throw new TypeError('Invalid semantic context provenance complete');
  return {
    workspaceRoot,
    path: sourcePath,
    ...(value.range === undefined ? {} : { range: sourceRange(value.range) }),
    sha256,
    proof: value.proof as SemanticContextProof,
    tool: boundedString(value.tool, 'provenance tool'),
    ...(value.server === undefined ? {} : { server: boundedString(value.server, 'provenance server') }),
    ...(value.serverVersion === undefined ? {} : { serverVersion: boundedString(value.serverVersion, 'provenance serverVersion') }),
    observedAt: value.observedAt,
    complete: value.complete,
  };
}

function slice(value: unknown, workspaceRoot: string): SemanticContextSliceV1 {
  if (!record(value)) throw new TypeError('Invalid semantic context slice');
  exactKeys(value, ['schemaVersion', 'id', 'kind', 'content', 'provenance', 'freshness'], 'slice');
  if (value.schemaVersion !== 1) throw new TypeError('Invalid semantic context slice schemaVersion');
  if (!KINDS.has(value.kind as SemanticContextSliceKind)) throw new TypeError('Invalid semantic context slice kind');
  const freshnessValue = value.freshness;
  if (!record(freshnessValue)) throw new TypeError('Invalid semantic context freshness');
  exactKeys(freshnessValue, ['state', 'checkedAt', 'documentVersion'], 'freshness');
  if (!FRESHNESS.has(freshnessValue.state as SemanticContextFreshness)) throw new TypeError('Invalid semantic context freshness state');
  if (!finiteTimestamp(freshnessValue.checkedAt)) throw new TypeError('Invalid semantic context freshness checkedAt');
  return {
    schemaVersion: 1,
    id: boundedString(value.id, 'slice id'),
    kind: value.kind as SemanticContextSliceKind,
    content: boundedString(value.content, 'slice content', MAX_CONTENT_LENGTH),
    provenance: provenance(value.provenance, workspaceRoot),
    freshness: {
      state: freshnessValue.state as SemanticContextFreshness,
      checkedAt: freshnessValue.checkedAt,
      ...(freshnessValue.documentVersion === undefined ? {} : {
        documentVersion: boundedString(freshnessValue.documentVersion, 'freshness documentVersion', 1_024),
      }),
    },
  };
}

function degradation(value: unknown): SemanticContextDegradationV1 {
  if (!record(value)) throw new TypeError('Invalid semantic context degradation');
  exactKeys(value, ['code', 'fallback', 'detail'], 'degradation');
  if (!DEGRADATIONS.has(value.code as SemanticContextDegradationCode)) throw new TypeError('Invalid semantic context degradation code');
  if (value.fallback !== 'text' && value.fallback !== 'none') throw new TypeError('Invalid semantic context degradation fallback');
  return {
    code: value.code as SemanticContextDegradationCode,
    fallback: value.fallback,
    ...(value.detail === undefined ? {} : { detail: boundedString(value.detail, 'degradation detail', MAX_DETAIL_LENGTH) }),
  };
}

export function assertSemanticContextManifest(
  value: unknown,
  options: SemanticContextValidationOptions,
): SemanticContextManifestV1 {
  if (!record(value)) throw new TypeError('Invalid semantic context manifest');
  exactKeys(value, ['schemaVersion', 'query', 'generatedAt', 'slices', 'degradations'], 'manifest');
  if (value.schemaVersion !== 1) throw new TypeError('Invalid semantic context schemaVersion');
  if (!finiteTimestamp(value.generatedAt)) throw new TypeError('Invalid semantic context generatedAt');
  if (!Array.isArray(value.slices) || value.slices.length > (options.maxSlices ?? MAX_SLICES))
    throw new TypeError('Invalid semantic context slices');
  if (!Array.isArray(value.degradations) || value.degradations.length > MAX_DEGRADATIONS)
    throw new TypeError('Invalid semantic context degradations');
  const slices = value.slices.map((entry) => slice(entry, options.workspaceRoot));
  const ids = new Set<string>();
  for (const entry of slices) {
    if (ids.has(entry.id)) throw new TypeError(`duplicate semantic context slice id: ${entry.id}`);
    ids.add(entry.id);
  }
  return {
    schemaVersion: 1,
    query: boundedString(value.query, 'query', MAX_QUERY_LENGTH),
    generatedAt: value.generatedAt,
    slices,
    degradations: value.degradations.map(degradation),
  };
}
