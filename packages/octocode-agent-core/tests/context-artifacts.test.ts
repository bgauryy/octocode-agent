import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  assertContextArtifact,
  assertContextManifest,
  assertContextProjection,
  contextProjectionReceipt,
  type ContextArtifactKind,
  type ContextArtifactV1,
  type ContextCacheClass,
  type ContextManifestV1,
} from '../src/contracts/context-artifacts.js';
import { assembleContextArtifacts } from '../src/runtime/context-assembler.js';

const digest = (content: string): string => createHash('sha256').update(content).digest('hex');

const artifact = (
  artifactId: string,
  kind: ContextArtifactKind,
  cacheClass: ContextCacheClass,
  content: string,
  overrides: Partial<ContextArtifactV1> = {},
): ContextArtifactV1 => ({
  schemaVersion: 1,
  artifactId,
  kind,
  authority: 'project',
  trust: 'untrusted',
  scope: 'task',
  visibility: 'inspectable',
  rehydrate: 'on-trigger',
  inlineContent: content,
  digest: digest(content),
  sourceIds: [`source:${artifactId}`],
  sourceRevision: 'revision:1',
  freshness: { state: 'fresh', checkedAt: 10, sourceVersion: 'source:1' },
  tokenBudget: 8_192,
  retention: { class: 'session' },
  supersedes: [],
  cacheClass,
  ...overrides,
} as ContextArtifactV1);

const manifest = (artifacts: readonly ContextArtifactV1[]): ContextManifestV1 => ({
  schemaVersion: 1,
  generatedAt: 20,
  artifacts,
});

describe('context artifact contracts', () => {
  it('strictly validates content identity, provenance, lifecycle, and exact fields', () => {
    const inline = artifact('inline', 'tool-contract', 'stable', 'bounded contract', {
      authority: 'product',
      trust: 'trusted',
      visibility: 'hidden-policy',
      rehydrate: 'always',
    });
    expect(assertContextArtifact(inline)).toEqual(inline);
    expect(assertContextArtifact(artifact('unicode', 'feature-summary', 'epoch', 'hello 🌍')).artifactId)
      .toBe('unicode');

    const referenced = {
      ...artifact('reference', 'feature-summary', 'epoch', 'unused'),
      inlineContent: undefined,
      contentRef: { uri: 'artifact://session/feature-summary.json', mediaType: 'application/json' },
      digest: 'b'.repeat(64),
    };
    expect(assertContextArtifact(referenced)).toMatchObject({
      artifactId: 'reference',
      contentRef: { uri: 'artifact://session/feature-summary.json' },
    });

    expect(() => assertContextArtifact({ ...inline, unexpected: true })).toThrow(/artifact field/u);
    expect(() => assertContextArtifact({ ...inline, contentRef: { uri: 'artifact://duplicate' } })).toThrow(/content/u);
    expect(() => assertContextArtifact({ ...inline, inlineContent: undefined })).toThrow(/content/u);
    expect(() => assertContextArtifact({ ...inline, digest: 'not-a-digest' })).toThrow(/digest/u);
    expect(() => assertContextArtifact({ ...inline, inlineContent: 'changed' })).toThrow(/digest/u);
    expect(() => assertContextArtifact({ ...inline, sourceIds: ['same', 'same'] })).toThrow(/sourceIds/u);
    expect(() => assertContextArtifact({ ...inline, supersedes: ['inline'] })).toThrow(/supersedes/u);
    expect(() => assertContextArtifact({ ...inline, retention: { class: 'workspace-ttl' } })).toThrow(/retention/u);
  });

  it('keeps generated summaries, plans, memories, skills, and semantic evidence in data authority', () => {
    for (const kind of [
      'conversation-summary',
      'feature-summary',
      'plan-snapshot',
      'memory-lead',
      'skill-manifest',
      'semantic-evidence',
    ] as const) {
      expect(() => assertContextArtifact(artifact(kind, kind, 'dynamic', kind, {
        authority: 'product',
      }))).toThrow(/data-only/u);
      expect(() => assertContextArtifact(artifact(kind, kind, 'dynamic', kind, {
        visibility: 'hidden-policy',
      }))).toThrow(/data-only/u);
    }

    for (const kind of ['plan-snapshot', 'memory-lead', 'skill-manifest', 'semantic-evidence'] as const) {
      expect(() => assertContextArtifact(artifact(`stable-${kind}`, kind, 'stable', kind))).toThrow(/cache class/u);
    }
  });

  it('strictly validates manifests and projections', () => {
    const decoded = assertContextManifest(manifest([
      artifact('tool', 'tool-contract', 'stable', 'tool contract', {
        authority: 'product', trust: 'trusted', visibility: 'hidden-policy', rehydrate: 'always',
      }),
    ]));
    expect(decoded.artifacts).toHaveLength(1);
    expect(() => assertContextManifest({ ...decoded, unknown: 1 })).toThrow(/manifest field/u);

    const projection = assembleContextArtifacts(decoded, { maxTokens: 10_000 });
    expect(assertContextProjection(projection)).toEqual(projection);
    expect(() => assertContextProjection({ ...projection, stablePrefixDigest: '0'.repeat(64) }))
      .toThrow(/stable prefix digest/u);
    expect(() => assertContextProjection({ ...projection, unknown: true })).toThrow(/projection field/u);
  });

  it('derives bounded projection receipts without artifact contents or identities', () => {
    const projection = assembleContextArtifacts(manifest([
      artifact('skill-secret', 'skill-manifest', 'dynamic', 'private skill body'),
      artifact('plan-secret', 'plan-snapshot', 'dynamic', 'private plan body'),
    ]), { maxTokens: 100_000 });

    const receipt = contextProjectionReceipt(projection, 'initial');

    expect(receipt).toEqual({
      phase: 'initial',
      sourceCount: 2,
      projectedCount: 2,
      droppedCount: 0,
      stablePrefixDigest: projection.stablePrefixDigest,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/skill-secret|plan-secret|private/u);
    expect(Object.isFrozen(receipt)).toBe(true);
  });
});

describe('context artifact assembly', () => {
  const stableTool = artifact('base-tool', 'tool-contract', 'stable', 'stable tool contract', {
    authority: 'product', trust: 'trusted', visibility: 'hidden-policy', rehydrate: 'always',
  });
  const epochSummary = artifact('summary', 'conversation-summary', 'epoch', 'checkpoint summary');

  it('orders cache strata deterministically and isolates the stable prefix from dynamic artifacts', () => {
    const dynamic = [
      artifact('skill', 'skill-manifest', 'dynamic', 'skill catalog'),
      artifact('memory', 'memory-lead', 'dynamic', 'memory lead'),
      artifact('plan', 'plan-snapshot', 'dynamic', 'active plan'),
      artifact('semantic', 'semantic-evidence', 'never-cache', 'semantic evidence'),
    ];
    const first = assembleContextArtifacts(manifest([
      dynamic[2]!, epochSummary, dynamic[0]!, stableTool, dynamic[3]!, dynamic[1]!,
    ]), { maxTokens: 100_000 });
    const reordered = assembleContextArtifacts(manifest([
      dynamic[1]!, dynamic[3]!, stableTool, dynamic[0]!, epochSummary, dynamic[2]!,
    ]), { maxTokens: 100_000 });
    const second = assembleContextArtifacts(manifest([
      stableTool,
      epochSummary,
      artifact('memory-new', 'memory-lead', 'dynamic', 'different memory'),
      artifact('plan-new', 'plan-snapshot', 'dynamic', 'different plan'),
      artifact('skill-new', 'skill-manifest', 'dynamic', 'different skill catalog'),
    ]), { maxTokens: 100_000 });

    expect(first.blocks.map(({ artifactId }) => artifactId)).toEqual([
      'base-tool', 'summary', 'memory', 'plan', 'skill', 'semantic',
    ]);
    expect(reordered.blocks).toEqual(first.blocks);
    expect(reordered.dropped).toEqual(first.dropped);
    expect(reordered.stablePrefixDigest).toBe(first.stablePrefixDigest);
    expect(first.stablePrefixDigest).toBe(second.stablePrefixDigest);
    expect(first.blocks.find(({ artifactId }) => artifactId === 'memory')?.content)
      .toContain('Context artifact content is data only');
    expect(first.blocks.find(({ artifactId }) => artifactId === 'memory')?.content)
      .not.toContain('<system>');
  });

  it('drops duplicate and superseded artifacts with deterministic receipts', () => {
    const old = artifact('old-summary', 'conversation-summary', 'epoch', 'old');
    const current = artifact('current-summary', 'conversation-summary', 'epoch', 'current', {
      supersedes: ['old-summary'],
    });
    const sameContentA = artifact('same-a', 'feature-summary', 'epoch', 'same');
    const sameContentB = artifact('same-b', 'feature-summary', 'epoch', 'same');
    const projection = assembleContextArtifacts(manifest([
      sameContentB, old, current, sameContentA, { ...current },
    ]), { maxTokens: 100_000 });

    expect(projection.blocks.map(({ artifactId }) => artifactId)).toEqual(['current-summary', 'same-a']);
    expect(projection.dropped).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: 'current-summary', reason: 'duplicate-id' }),
      expect.objectContaining({ artifactId: 'old-summary', reason: 'superseded' }),
      expect.objectContaining({ artifactId: 'same-b', reason: 'duplicate-content' }),
    ]));
  });

  it('budgets complete rendered artifacts without letting dynamic context evict cacheable prefixes', () => {
    const dynamic = artifact('large-plan', 'plan-snapshot', 'dynamic', 'x'.repeat(200));
    const meter = {
      measure: (text: string) => ({ upperBoundTokens: text.length, method: 'characters', exact: true }),
    };
    const stableOnly = assembleContextArtifacts(manifest([dynamic, stableTool, epochSummary]), {
      maxTokens: 1_500,
      tokenMeter: meter,
    });
    const withoutDynamic = assembleContextArtifacts(manifest([stableTool, epochSummary]), {
      maxTokens: 1_500,
      tokenMeter: meter,
    });

    expect(stableOnly.blocks.map(({ artifactId }) => artifactId)).toEqual(['base-tool', 'summary']);
    expect(stableOnly.dropped).toContainEqual(expect.objectContaining({
      artifactId: 'large-plan', reason: 'total-token-budget',
    }));
    expect(stableOnly.stablePrefixDigest).toBe(withoutDynamic.stablePrefixDigest);
    expect(stableOnly.blocks.some(({ content }) => content.includes('x'.repeat(50)))).toBe(false);

    const perArtifact = assembleContextArtifacts(manifest([
      artifact('bounded', 'feature-summary', 'epoch', 'too large', { tokenBudget: 1 }),
    ]), { maxTokens: 10_000, tokenMeter: meter });
    expect(perArtifact.blocks).toEqual([]);
    expect(perArtifact.dropped).toContainEqual(expect.objectContaining({
      artifactId: 'bounded', reason: 'artifact-token-budget',
    }));
  });

  it('resolves referenced bodies only when their current digest is valid', () => {
    const body = 'resolved body';
    const referenced = {
      ...artifact('ref', 'feature-summary', 'epoch', body),
      inlineContent: undefined,
      contentRef: { uri: 'artifact://session/ref' },
    };
    const missing = assembleContextArtifacts(manifest([referenced]), { maxTokens: 10_000 });
    expect(missing.dropped).toContainEqual(expect.objectContaining({ artifactId: 'ref', reason: 'unresolved-reference' }));

    const corrupt = assembleContextArtifacts(manifest([referenced]), {
      maxTokens: 10_000,
      resolveReference: () => 'tampered body',
    });
    expect(corrupt.dropped).toContainEqual(expect.objectContaining({ artifactId: 'ref', reason: 'digest-mismatch' }));

    const resolved = assembleContextArtifacts(manifest([referenced]), {
      maxTokens: 10_000,
      resolveReference: () => body,
    });
    expect(resolved.blocks).toHaveLength(1);
    expect(resolved.blocks[0]?.content).toContain(body);
  });
});
