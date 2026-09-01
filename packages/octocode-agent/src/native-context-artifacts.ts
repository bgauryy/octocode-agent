import {
  assembleContextArtifacts,
  contextSha256,
  type ContextArtifactV1,
  type ContextManifestV1,
  type ContextProjectionV1,
  type ModelMessage,
} from '@octocodeai/agent-core';
import type { RuntimePlanSnapshot } from './native-plan.js';
import type { NativeSkillSummary } from './native-skills.js';

export interface NativeContextMemoryLead {
  readonly id: string;
  readonly text: string;
  readonly sourceRevision?: string;
}

export interface NativeContextToolSummary {
  readonly name: string;
  readonly description: string;
  readonly schemaVersion: number;
}

export interface NativeContextArtifactSources {
  readonly generatedAt?: number;
  readonly plan?: RuntimePlanSnapshot;
  readonly skills?: readonly NativeSkillSummary[];
  readonly memoryLeads?: readonly NativeContextMemoryLead[];
  readonly tools?: readonly NativeContextToolSummary[];
  readonly conversationSummary?: {
    readonly text: string;
    readonly sourceRevision?: string;
  };
}

export interface NativeContextArtifactAssembly {
  readonly projection: ContextProjectionV1;
  readonly messages: readonly ModelMessage[];
}

const DEFAULT_CONTEXT_ARTIFACT_BUDGET = 32_768;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function artifact(
  input: Omit<ContextArtifactV1, 'schemaVersion' | 'digest' | 'inlineContent' | 'contentRef'> & {
    readonly content: string;
  },
): ContextArtifactV1 {
  const { content, ...metadata } = input;
  return {
    schemaVersion: 1,
    ...metadata,
    digest: contextSha256(content),
    inlineContent: content,
  };
}

function nativeArtifacts(sources: NativeContextArtifactSources, generatedAt: number): ContextArtifactV1[] {
  const artifacts: ContextArtifactV1[] = [];
  if (sources.conversationSummary !== undefined) {
    artifacts.push(artifact({
      artifactId: `conversation-summary:${contextSha256(sources.conversationSummary.text)}`,
      kind: 'conversation-summary',
      authority: 'external-data',
      trust: 'unknown',
      scope: 'session',
      visibility: 'inspectable',
      rehydrate: 'always',
      sourceIds: ['native.compaction'],
      ...(sources.conversationSummary.sourceRevision === undefined
        ? {}
        : { sourceRevision: sources.conversationSummary.sourceRevision }),
      freshness: { state: 'fresh', checkedAt: generatedAt },
      retention: { class: 'session' },
      supersedes: [],
      cacheClass: 'epoch',
      content: sources.conversationSummary.text,
    }));
  }
  if (sources.plan !== undefined) {
    const content = json({ schemaVersion: 1, type: 'native.plan-summary', plan: sources.plan });
    artifacts.push(artifact({
      artifactId: `${sources.plan.planId}:${sources.plan.revision}`,
      kind: 'plan-snapshot',
      authority: 'project',
      trust: 'trusted',
      scope: 'session',
      visibility: 'inspectable',
      rehydrate: 'always',
      sourceIds: [sources.plan.planId],
      sourceRevision: String(sources.plan.revision),
      freshness: { state: 'fresh', checkedAt: generatedAt },
      retention: { class: 'session' },
      supersedes: [],
      cacheClass: 'dynamic',
      content,
    }));
  }
  if (sources.skills !== undefined && sources.skills.length > 0) {
    const content = json({ schemaVersion: 1, type: 'native.skill-manifest', skills: sources.skills });
    artifacts.push(artifact({
      artifactId: `skill-manifest:${contextSha256(content)}`,
      kind: 'skill-manifest',
      authority: 'project',
      trust: 'unknown',
      scope: 'session',
      visibility: 'inspectable',
      rehydrate: 'on-trigger',
      sourceIds: ['native.skill-discovery'],
      freshness: { state: 'fresh', checkedAt: generatedAt },
      retention: { class: 'session' },
      supersedes: [],
      cacheClass: 'dynamic',
      content,
    }));
  }
  if (sources.tools !== undefined && sources.tools.length > 0) {
    const tools = [...sources.tools].sort((left, right) => left.name.localeCompare(right.name));
    const content = json({ schemaVersion: 1, type: 'native.tool-summary', tools });
    artifacts.push(artifact({
      artifactId: `tool-summary:${contextSha256(content)}`,
      kind: 'feature-summary',
      authority: 'project',
      trust: 'trusted',
      scope: 'session',
      visibility: 'inspectable',
      rehydrate: 'always',
      sourceIds: ['native.tool-registry'],
      freshness: { state: 'fresh', checkedAt: generatedAt },
      retention: { class: 'session' },
      supersedes: [],
      cacheClass: 'dynamic',
      content,
    }));
  }
  for (const lead of sources.memoryLeads ?? []) {
    artifacts.push(artifact({
      artifactId: lead.id,
      kind: 'memory-lead',
      authority: 'external-data',
      trust: 'unknown',
      scope: 'task',
      visibility: 'inspectable',
      rehydrate: 'on-trigger',
      sourceIds: [lead.id],
      ...(lead.sourceRevision === undefined ? {} : { sourceRevision: lead.sourceRevision }),
      freshness: { state: 'unknown', checkedAt: generatedAt },
      retention: { class: 'session' },
      supersedes: [],
      cacheClass: 'dynamic',
      content: lead.text,
    }));
  }
  return artifacts;
}

export function assembleNativeContextArtifacts(
  sources: NativeContextArtifactSources,
  options: { readonly maxTokens?: number } = {},
): NativeContextArtifactAssembly {
  const generatedAt = sources.generatedAt ?? Date.now();
  const manifest: ContextManifestV1 = {
    schemaVersion: 1,
    generatedAt,
    artifacts: nativeArtifacts(sources, generatedAt),
  };
  const projection = assembleContextArtifacts(manifest, {
    maxTokens: options.maxTokens ?? DEFAULT_CONTEXT_ARTIFACT_BUDGET,
  });
  return {
    projection,
    messages: projection.blocks.map(({ content }) => ({ role: 'user' as const, content })),
  };
}
