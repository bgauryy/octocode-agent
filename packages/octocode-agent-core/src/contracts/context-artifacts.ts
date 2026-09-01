export type ContextArtifactKind =
  | 'conversation-summary'
  | 'provider-compaction'
  | 'plan-snapshot'
  | 'feature-summary'
  | 'skill-manifest'
  | 'memory-lead'
  | 'semantic-evidence'
  | 'tool-contract'
  | 'tool-result-summary';

export type ContextAuthority = 'product' | 'user' | 'project' | 'external-data';
export type ContextTrust = 'trusted' | 'untrusted' | 'unknown';
export type ContextScope = 'session' | 'turn' | 'task' | 'path';
export type ContextVisibility = 'hidden-policy' | 'inspectable' | 'transcript';
export type ContextRehydration = 'always' | 'on-trigger' | 'summary-only' | 'never';
export type ContextCacheClass = 'stable' | 'epoch' | 'dynamic' | 'never-cache';
export type ContextFreshnessState = 'fresh' | 'stale' | 'unknown';
export type ContextRetentionClass = 'turn' | 'session' | 'workspace-ttl' | 'pinned';

export interface ContextContentRefV1 {
  readonly uri: string;
  readonly mediaType?: string;
}

export interface ContextFreshnessV1 {
  readonly state: ContextFreshnessState;
  readonly checkedAt: number;
  readonly sourceVersion?: string;
}

export type ContextRetentionV1 =
  | { readonly class: 'turn' | 'session' | 'pinned'; readonly expiresAt?: never }
  | { readonly class: 'workspace-ttl'; readonly expiresAt: number };

interface ContextArtifactBaseV1 {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly kind: ContextArtifactKind;
  readonly authority: ContextAuthority;
  readonly trust: ContextTrust;
  readonly scope: ContextScope;
  readonly visibility: ContextVisibility;
  readonly rehydrate: ContextRehydration;
  readonly digest: string;
  readonly sourceIds: readonly string[];
  readonly sourceRevision?: string;
  readonly freshness: ContextFreshnessV1;
  readonly tokenBudget?: number;
  readonly retention: ContextRetentionV1;
  readonly supersedes: readonly string[];
  readonly cacheClass: ContextCacheClass;
}

export type ContextArtifactV1 = ContextArtifactBaseV1 & (
  | { readonly inlineContent: string; readonly contentRef?: never }
  | { readonly inlineContent?: never; readonly contentRef: ContextContentRefV1 }
);

export interface ContextManifestV1 {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly artifacts: readonly ContextArtifactV1[];
}

export type ContextDropReason =
  | 'duplicate-id'
  | 'duplicate-content'
  | 'superseded'
  | 'unresolved-reference'
  | 'digest-mismatch'
  | 'artifact-token-budget'
  | 'total-token-budget';

export interface ContextDropReceiptV1 {
  readonly artifactId: string;
  readonly reason: ContextDropReason;
  readonly detail?: string;
}

export interface ContextProjectionBlockV1 {
  readonly artifactId: string;
  readonly kind: ContextArtifactKind;
  readonly cacheClass: ContextCacheClass;
  readonly content: string;
  readonly upperBoundTokens: number;
}

export interface ContextProjectionV1 {
  readonly schemaVersion: 1;
  readonly manifest: ContextManifestV1;
  readonly blocks: readonly ContextProjectionBlockV1[];
  readonly dropped: readonly ContextDropReceiptV1[];
  readonly budget: {
    readonly maxTokens: number;
    readonly usedTokensUpperBound: number;
    readonly method: string;
    readonly exact: boolean;
  };
  readonly stablePrefixDigest: string;
}

export type ContextProjectionPhase = 'initial' | 'compaction';

/** Content-free evidence that a validated context projection reached the runtime. */
export interface ContextProjectionReceiptV1 {
  readonly phase: ContextProjectionPhase;
  readonly sourceCount: number;
  readonly projectedCount: number;
  readonly droppedCount: number;
  readonly stablePrefixDigest: string;
}

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_CONTENT_LENGTH = 256 * 1024;
const MAX_REFERENCE_LENGTH = 4_096;
const MAX_MEDIA_TYPE_LENGTH = 256;
const MAX_SOURCE_IDS = 256;
const MAX_SUPERSEDES = 256;
const MAX_ARTIFACTS = 512;
const MAX_PROJECTION_TEXT_LENGTH = 512 * 1024;
const MAX_TOKEN_BUDGET = 10_000_000;
const SHA256 = /^[a-f0-9]{64}$/u;

const KINDS = new Set<ContextArtifactKind>([
  'conversation-summary',
  'provider-compaction',
  'plan-snapshot',
  'feature-summary',
  'skill-manifest',
  'memory-lead',
  'semantic-evidence',
  'tool-contract',
  'tool-result-summary',
]);
const AUTHORITIES = new Set<ContextAuthority>(['product', 'user', 'project', 'external-data']);
const TRUST = new Set<ContextTrust>(['trusted', 'untrusted', 'unknown']);
const SCOPES = new Set<ContextScope>(['session', 'turn', 'task', 'path']);
const VISIBILITY = new Set<ContextVisibility>(['hidden-policy', 'inspectable', 'transcript']);
const REHYDRATION = new Set<ContextRehydration>(['always', 'on-trigger', 'summary-only', 'never']);
const CACHE_CLASSES = new Set<ContextCacheClass>(['stable', 'epoch', 'dynamic', 'never-cache']);
const FRESHNESS = new Set<ContextFreshnessState>(['fresh', 'stale', 'unknown']);
const RETENTION = new Set<ContextRetentionClass>(['turn', 'session', 'workspace-ttl', 'pinned']);
const DROP_REASONS = new Set<ContextDropReason>([
  'duplicate-id',
  'duplicate-content',
  'superseded',
  'unresolved-reference',
  'digest-mismatch',
  'artifact-token-budget',
  'total-token-budget',
]);
const DATA_ONLY_KINDS = new Set<ContextArtifactKind>([
  'conversation-summary',
  'provider-compaction',
  'plan-snapshot',
  'feature-summary',
  'skill-manifest',
  'memory-lead',
  'semantic-evidence',
  'tool-result-summary',
]);
const DYNAMIC_ONLY_KINDS = new Set<ContextArtifactKind>([
  'plan-snapshot',
  'skill-manifest',
  'memory-lead',
  'semantic-evidence',
  'tool-result-summary',
]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], name: string): void => {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key)))
    throw new TypeError(`Invalid context ${name} field`);
};

const boundedString = (value: unknown, name: string, maximum = MAX_IDENTIFIER_LENGTH): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\0'))
    throw new TypeError(`Invalid context ${name}`);
  return value;
};

const finiteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const positiveInteger = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum;

const rotateRight = (value: number, count: number): number =>
  (value >>> count) | (value << (32 - count));

/** Host-neutral SHA-256 used for artifact integrity and cache-prefix identity. */
export function contextSha256(value: string): string {
  const bytes = [...new TextEncoder().encode(value)];
  const bitLength = BigInt(bytes.length) * 8n;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56n; shift >= 0n; shift -= 8n)
    bytes.push(Number((bitLength >> shift) & 0xffn));

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ] as const;
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] = (
        ((bytes[wordOffset] ?? 0) << 24)
        | ((bytes[wordOffset + 1] ?? 0) << 16)
        | ((bytes[wordOffset + 2] ?? 0) << 8)
        | (bytes[wordOffset + 3] ?? 0)
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + bigSigma1 + choice + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function contentRef(value: unknown): ContextContentRefV1 {
  if (!record(value)) throw new TypeError('Invalid context artifact contentRef');
  exactKeys(value, ['uri', 'mediaType'], 'artifact contentRef');
  return {
    uri: boundedString(value.uri, 'artifact contentRef uri', MAX_REFERENCE_LENGTH),
    ...(value.mediaType === undefined
      ? {}
      : { mediaType: boundedString(value.mediaType, 'artifact contentRef mediaType', MAX_MEDIA_TYPE_LENGTH) }),
  };
}

function freshness(value: unknown): ContextFreshnessV1 {
  if (!record(value)) throw new TypeError('Invalid context artifact freshness');
  exactKeys(value, ['state', 'checkedAt', 'sourceVersion'], 'artifact freshness');
  if (!FRESHNESS.has(value.state as ContextFreshnessState))
    throw new TypeError('Invalid context artifact freshness state');
  if (!finiteTimestamp(value.checkedAt)) throw new TypeError('Invalid context artifact freshness checkedAt');
  return {
    state: value.state as ContextFreshnessState,
    checkedAt: value.checkedAt,
    ...(value.sourceVersion === undefined
      ? {}
      : { sourceVersion: boundedString(value.sourceVersion, 'artifact freshness sourceVersion', 1_024) }),
  };
}

function retention(value: unknown, checkedAt: number): ContextRetentionV1 {
  if (!record(value)) throw new TypeError('Invalid context artifact retention');
  exactKeys(value, ['class', 'expiresAt'], 'artifact retention');
  if (!RETENTION.has(value.class as ContextRetentionClass))
    throw new TypeError('Invalid context artifact retention class');
  if (value.class === 'workspace-ttl') {
    if (!finiteTimestamp(value.expiresAt) || value.expiresAt <= checkedAt)
      throw new TypeError('Invalid context artifact retention expiresAt');
    return { class: 'workspace-ttl', expiresAt: value.expiresAt };
  }
  if (value.expiresAt !== undefined) throw new TypeError('Invalid context artifact retention expiresAt');
  return { class: value.class as 'turn' | 'session' | 'pinned' };
}

function uniqueStrings(value: unknown, name: string, maximum: number, requireValue: boolean): string[] {
  if (!Array.isArray(value) || value.length > maximum || (requireValue && value.length === 0))
    throw new TypeError(`Invalid context artifact ${name}`);
  const decoded = value.map((entry) => boundedString(entry, `artifact ${name}`, 1_024));
  if (new Set(decoded).size !== decoded.length) throw new TypeError(`Invalid context artifact ${name}`);
  return decoded;
}

export function assertContextArtifact(value: unknown): ContextArtifactV1 {
  if (!record(value)) throw new TypeError('Invalid context artifact');
  exactKeys(value, [
    'schemaVersion', 'artifactId', 'kind', 'authority', 'trust', 'scope', 'visibility', 'rehydrate',
    'inlineContent', 'contentRef', 'digest', 'sourceIds', 'sourceRevision', 'freshness', 'tokenBudget',
    'retention', 'supersedes', 'cacheClass',
  ], 'artifact');
  if (value.schemaVersion !== 1) throw new TypeError('Invalid context artifact schemaVersion');
  if (!KINDS.has(value.kind as ContextArtifactKind)) throw new TypeError('Invalid context artifact kind');
  if (!AUTHORITIES.has(value.authority as ContextAuthority)) throw new TypeError('Invalid context artifact authority');
  if (!TRUST.has(value.trust as ContextTrust)) throw new TypeError('Invalid context artifact trust');
  if (!SCOPES.has(value.scope as ContextScope)) throw new TypeError('Invalid context artifact scope');
  if (!VISIBILITY.has(value.visibility as ContextVisibility)) throw new TypeError('Invalid context artifact visibility');
  if (!REHYDRATION.has(value.rehydrate as ContextRehydration)) throw new TypeError('Invalid context artifact rehydrate');
  if (!CACHE_CLASSES.has(value.cacheClass as ContextCacheClass)) throw new TypeError('Invalid context artifact cache class');

  const artifactId = boundedString(value.artifactId, 'artifactId');
  const kind = value.kind as ContextArtifactKind;
  const hasInline = typeof value.inlineContent === 'string';
  const hasReference = value.contentRef !== undefined;
  if (hasInline === hasReference) throw new TypeError('Invalid context artifact content: exactly one inlineContent or contentRef is required');
  const inlineContent = hasInline
    ? boundedString(value.inlineContent, 'artifact inlineContent', MAX_CONTENT_LENGTH)
    : undefined;
  const decodedReference = hasReference ? contentRef(value.contentRef) : undefined;
  const digest = boundedString(value.digest, 'artifact digest', 64);
  if (!SHA256.test(digest)) throw new TypeError('Invalid context artifact digest');
  if (inlineContent !== undefined && contextSha256(inlineContent) !== digest)
    throw new TypeError('Invalid context artifact digest for inlineContent');
  const sourceIds = uniqueStrings(value.sourceIds, 'sourceIds', MAX_SOURCE_IDS, true);
  const decodedFreshness = freshness(value.freshness);
  const supersedes = uniqueStrings(value.supersedes, 'supersedes', MAX_SUPERSEDES, false);
  if (supersedes.includes(artifactId)) throw new TypeError('Invalid context artifact supersedes self-reference');
  if (value.tokenBudget !== undefined && !positiveInteger(value.tokenBudget, MAX_TOKEN_BUDGET))
    throw new TypeError('Invalid context artifact tokenBudget');

  if (DATA_ONLY_KINDS.has(kind)
    && (value.authority === 'product' || value.visibility === 'hidden-policy'))
    throw new TypeError(`Invalid context artifact data-only authority for ${kind}`);
  if (DYNAMIC_ONLY_KINDS.has(kind)
    && value.cacheClass !== 'dynamic' && value.cacheClass !== 'never-cache')
    throw new TypeError(`Invalid context artifact cache class for ${kind}`);

  const base: ContextArtifactBaseV1 = {
    schemaVersion: 1,
    artifactId,
    kind,
    authority: value.authority as ContextAuthority,
    trust: value.trust as ContextTrust,
    scope: value.scope as ContextScope,
    visibility: value.visibility as ContextVisibility,
    rehydrate: value.rehydrate as ContextRehydration,
    digest,
    sourceIds,
    ...(value.sourceRevision === undefined
      ? {}
      : { sourceRevision: boundedString(value.sourceRevision, 'artifact sourceRevision', 1_024) }),
    freshness: decodedFreshness,
    ...(value.tokenBudget === undefined ? {} : { tokenBudget: value.tokenBudget }),
    retention: retention(value.retention, decodedFreshness.checkedAt),
    supersedes,
    cacheClass: value.cacheClass as ContextCacheClass,
  };
  return inlineContent === undefined
    ? { ...base, contentRef: decodedReference! }
    : { ...base, inlineContent };
}

export function assertContextManifest(value: unknown): ContextManifestV1 {
  if (!record(value)) throw new TypeError('Invalid context manifest');
  exactKeys(value, ['schemaVersion', 'generatedAt', 'artifacts'], 'manifest');
  if (value.schemaVersion !== 1) throw new TypeError('Invalid context manifest schemaVersion');
  if (!finiteTimestamp(value.generatedAt)) throw new TypeError('Invalid context manifest generatedAt');
  if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS)
    throw new TypeError('Invalid context manifest artifacts');
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    // Duplicate and superseded identities are candidates resolved deterministically by the assembler.
    artifacts: value.artifacts.map(assertContextArtifact),
  };
}

function projectionBlock(value: unknown): ContextProjectionBlockV1 {
  if (!record(value)) throw new TypeError('Invalid context projection block');
  exactKeys(value, ['artifactId', 'kind', 'cacheClass', 'content', 'upperBoundTokens'], 'projection block');
  if (!KINDS.has(value.kind as ContextArtifactKind)) throw new TypeError('Invalid context projection block kind');
  if (!CACHE_CLASSES.has(value.cacheClass as ContextCacheClass)) throw new TypeError('Invalid context projection block cacheClass');
  if (!positiveInteger(value.upperBoundTokens, MAX_TOKEN_BUDGET))
    throw new TypeError('Invalid context projection block upperBoundTokens');
  return {
    artifactId: boundedString(value.artifactId, 'projection block artifactId'),
    kind: value.kind as ContextArtifactKind,
    cacheClass: value.cacheClass as ContextCacheClass,
    content: boundedString(value.content, 'projection block content', MAX_PROJECTION_TEXT_LENGTH),
    upperBoundTokens: value.upperBoundTokens,
  };
}

function dropReceipt(value: unknown): ContextDropReceiptV1 {
  if (!record(value)) throw new TypeError('Invalid context projection drop receipt');
  exactKeys(value, ['artifactId', 'reason', 'detail'], 'projection drop receipt');
  if (!DROP_REASONS.has(value.reason as ContextDropReason))
    throw new TypeError('Invalid context projection drop reason');
  return {
    artifactId: boundedString(value.artifactId, 'projection drop artifactId'),
    reason: value.reason as ContextDropReason,
    ...(value.detail === undefined
      ? {}
      : { detail: boundedString(value.detail, 'projection drop detail', 2_048) }),
  };
}

export const CONTEXT_CACHE_CLASS_ORDER: Readonly<Record<ContextCacheClass, number>> = Object.freeze({
  stable: 0,
  epoch: 1,
  dynamic: 2,
  'never-cache': 3,
});

export function contextStablePrefixDigest(blocks: readonly ContextProjectionBlockV1[]): string {
  return contextSha256(JSON.stringify(blocks
    .filter(({ cacheClass }) => cacheClass === 'stable' || cacheClass === 'epoch')
    .map(({ artifactId, kind, cacheClass, content }) => ({ artifactId, kind, cacheClass, content }))));
}

export function assertContextProjection(value: unknown): ContextProjectionV1 {
  if (!record(value)) throw new TypeError('Invalid context projection');
  exactKeys(value, ['schemaVersion', 'manifest', 'blocks', 'dropped', 'budget', 'stablePrefixDigest'], 'projection');
  if (value.schemaVersion !== 1) throw new TypeError('Invalid context projection schemaVersion');
  if (!Array.isArray(value.blocks) || value.blocks.length > MAX_ARTIFACTS)
    throw new TypeError('Invalid context projection blocks');
  if (!Array.isArray(value.dropped) || value.dropped.length > MAX_ARTIFACTS * 2)
    throw new TypeError('Invalid context projection dropped');
  if (!record(value.budget)) throw new TypeError('Invalid context projection budget');
  exactKeys(value.budget, ['maxTokens', 'usedTokensUpperBound', 'method', 'exact'], 'projection budget');
  if (!positiveInteger(value.budget.maxTokens, MAX_TOKEN_BUDGET)
    || !Number.isSafeInteger(value.budget.usedTokensUpperBound)
    || Number(value.budget.usedTokensUpperBound) < 0
    || Number(value.budget.usedTokensUpperBound) > value.budget.maxTokens
    || typeof value.budget.exact !== 'boolean')
    throw new TypeError('Invalid context projection budget');
  const method = boundedString(value.budget.method, 'projection budget method', 256);
  const blocks = value.blocks.map(projectionBlock);
  const ids = new Set<string>();
  let previousOrder = -1;
  for (const block of blocks) {
    if (ids.has(block.artifactId)) throw new TypeError('Invalid context projection duplicate block artifactId');
    ids.add(block.artifactId);
    const order = CONTEXT_CACHE_CLASS_ORDER[block.cacheClass];
    if (order < previousOrder) throw new TypeError('Invalid context projection cache class order');
    previousOrder = order;
  }
  const usedTokensUpperBound = blocks.reduce((sum, block) => sum + block.upperBoundTokens, 0);
  if (usedTokensUpperBound !== value.budget.usedTokensUpperBound)
    throw new TypeError('Invalid context projection used token count');
  const stablePrefixDigest = boundedString(value.stablePrefixDigest, 'projection stablePrefixDigest', 64);
  if (!SHA256.test(stablePrefixDigest) || stablePrefixDigest !== contextStablePrefixDigest(blocks))
    throw new TypeError('Invalid context projection stable prefix digest');

  const decodedManifest = assertContextManifest(value.manifest);
  for (const block of blocks) {
    if (!decodedManifest.artifacts.some((entry) => entry.artifactId === block.artifactId
      && entry.kind === block.kind && entry.cacheClass === block.cacheClass))
      throw new TypeError(`Invalid context projection unknown artifact block: ${block.artifactId}`);
  }
  return {
    schemaVersion: 1,
    manifest: decodedManifest,
    blocks,
    dropped: value.dropped.map(dropReceipt),
    budget: {
      maxTokens: value.budget.maxTokens,
      usedTokensUpperBound,
      method,
      exact: value.budget.exact,
    },
    stablePrefixDigest,
  };
}

export function assertContextProjectionReceipt(value: unknown): ContextProjectionReceiptV1 {
  if (!record(value)) throw new TypeError('Invalid context projection receipt');
  exactKeys(
    value,
    ['phase', 'sourceCount', 'projectedCount', 'droppedCount', 'stablePrefixDigest'],
    'projection receipt',
  );
  if (value.phase !== 'initial' && value.phase !== 'compaction')
    throw new TypeError('Invalid context projection receipt phase');
  if (!Number.isSafeInteger(value.sourceCount)
    || Number(value.sourceCount) < 0
    || Number(value.sourceCount) > MAX_ARTIFACTS)
    throw new TypeError('Invalid context projection receipt sourceCount');
  if (!Number.isSafeInteger(value.projectedCount)
    || Number(value.projectedCount) < 0
    || Number(value.projectedCount) > MAX_ARTIFACTS)
    throw new TypeError('Invalid context projection receipt projectedCount');
  if (!Number.isSafeInteger(value.droppedCount)
    || Number(value.droppedCount) < 0
    || Number(value.droppedCount) > MAX_ARTIFACTS * 2)
    throw new TypeError('Invalid context projection receipt droppedCount');
  const stablePrefixDigest = boundedString(
    value.stablePrefixDigest,
    'projection receipt stablePrefixDigest',
    64,
  );
  if (!SHA256.test(stablePrefixDigest))
    throw new TypeError('Invalid context projection receipt stablePrefixDigest');
  return Object.freeze({
    phase: value.phase,
    sourceCount: value.sourceCount,
    projectedCount: value.projectedCount,
    droppedCount: value.droppedCount,
    stablePrefixDigest,
  }) as ContextProjectionReceiptV1;
}

export function contextProjectionReceipt(
  projection: ContextProjectionV1,
  phase: ContextProjectionPhase,
): ContextProjectionReceiptV1 {
  const decoded = assertContextProjection(projection);
  return assertContextProjectionReceipt({
    phase,
    sourceCount: decoded.manifest.artifacts.length,
    projectedCount: decoded.blocks.length,
    droppedCount: decoded.dropped.length,
    stablePrefixDigest: decoded.stablePrefixDigest,
  });
}
