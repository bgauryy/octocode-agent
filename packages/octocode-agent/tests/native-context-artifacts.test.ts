import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createEffectSet,
  type ModelRequest,
} from '@octocodeai/agent-core';
import {
  assembleNativeContextArtifacts,
  type NativeContextArtifactSources,
} from '../src/native-context-artifacts.js';
import {
  createDefaultNativeRuntime,
  parseNativeArgs,
} from '../src/native-launcher.js';

const sources = (memory: string): NativeContextArtifactSources => ({
  generatedAt: 42,
  plan: {
    authority: 'runtime',
    planId: 'plan:test',
    scope: { sessionId: 'session:test', workspace: '/workspace' },
    revision: 3,
    phase: 'active',
    steps: [{ id: 'step:1', text: 'Verify projection', status: 'doing' }],
  },
  skills: [{ name: 'research', description: 'Ground claims in exact source.' }],
  memoryLeads: [{ id: 'memory:1', text: memory, sourceRevision: '7' }],
  tools: [{ name: 'file', description: 'Read bounded workspace files.', schemaVersion: 1 }],
});

describe('native context artifact composition', () => {
  it('assembles dynamic summaries as data-only blocks with receipts outside the stable prefix', () => {
    const first = assembleNativeContextArtifacts(sources('first lead'), { maxTokens: 100_000 });
    const second = assembleNativeContextArtifacts(sources('changed lead'), { maxTokens: 100_000 });

    expect(first.projection.blocks.map(({ kind }) => kind)).toEqual([
      'feature-summary',
      'memory-lead',
      'plan-snapshot',
      'skill-manifest',
    ]);
    expect(first.messages).toHaveLength(4);
    expect(first.messages.every(({ role }) => role === 'user')).toBe(true);
    expect(first.messages.every(({ content }) => content.includes('instruction-role="data"'))).toBe(true);
    expect(first.projection.dropped).toEqual([]);
    expect(second.projection.stablePrefixDigest).toBe(first.projection.stablePrefixDigest);
  });

  it('projects artifacts into the production provider request without changing the stable prompt prefix', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-context-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-context-workspace-'));
    const requests: ModelRequest[] = [];
    const projections: ReturnType<typeof assembleNativeContextArtifacts>['projection'][] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: 'fixture',
      label: 'Fixture',
      description: 'Fixture tool summary.',
      schemaVersion: 1,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', additionalProperties: false },
      outputVersion: 1,
      policy: {
        effects: createEffectSet('read'),
        trust: 'none',
        approval: 'never',
        plan: 'allowed',
      },
      execute: async () => ({ ok: true, content: {}, detailsVersion: 1 }),
    }, 'native-context-artifacts.test');
    const runtime = await createDefaultNativeRuntime({
      env: { OCTOCODE_HOME: home },
      cwd,
      args: parseNativeArgs(['--no-session']),
      tools,
      contextArtifacts: sources('provider-visible lead'),
      onContextProjection: (projection) => projections.push(projection),
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return {
            stop: 'complete',
            usage: {
              inputTokens: 11,
              outputTokens: 2,
              cachedInputTokens: 7,
              cacheWriteInputTokens: 3,
            },
          };
        },
      },
    });

    await runtime.submit('inspect context');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.cache).toEqual({ stablePrefixMessageCount: 1 });
    expect(requests[0]?.messages[0]?.role).toBe('system');
    expect(requests[0]?.messages.slice(1, -1).every(({ role }) => role === 'user')).toBe(true);
    expect(requests[0]?.messages.some(({ content }) => content.includes('provider-visible lead'))).toBe(true);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.dropped).toEqual([]);
    await runtime.stop();
  });
});
