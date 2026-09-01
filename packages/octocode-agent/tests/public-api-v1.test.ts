import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  defineOctocodeAgentV1,
  launchOctocodeAgentV1,
} from '../src/api/v1.js';
import type {
  AgentControlEventByTypeV1,
  AgentControlPayloadMapV1,
  AgentLifecycleObservedEventByTypeV1,
  AgentLifecycleSensitiveEventByTypeV1,
  AgentPortableCustomizationFactoryV1,
  AgentPortableContributionSetV1,
} from '../src/api/v1.js';
import type {
  AgentPresentationEventV1,
  AgentPresentationFactoryV1,
  AgentPresentationInputEventV1,
  AgentPresentationPortV1,
} from '../src/presentation/v1.js';

function customTool(name = 'echo', id = `tool.${name}`) {
  return {
    id,
    name,
    label: 'Echo',
    description: 'Return the supplied input.',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { value: { type: 'string' } },
    },
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: {
      effects: ['read'] as const,
      trust: 'none',
      approval: 'never',
      plan: 'allowed',
    },
    execute: vi.fn(async () => ({
      ok: true,
      content: { value: 'echo' },
      detailsVersion: 1,
    })),
  };
}

function fullCustomization() {
  return {
    schemaVersion: 1,
    id: 'com.acme.review-agent',
    productPolicyOverlay: {
      mode: 'append',
      content: 'Apply the Acme review policy.',
    },
    tools: [customTool()],
    hooks: [{
      id: 'guard-tool-request',
      event: 'tool.requested',
      handle: vi.fn(async () => ({ kind: 'continue' as const })),
    }],
    events: [{
      id: 'audit-tool-result',
      event: 'tool.ended',
      observe: vi.fn(async () => undefined),
    }],
    compaction: {
      inputTokenThreshold: 4_096,
      summarize: vi.fn(async () => ({
        summary: 'Acme compaction summary',
        retainedEventIds: [],
      })),
    },
    presentation: vi.fn(() => presentationPort()),
    dispose: vi.fn(async () => undefined),
  };
}

function presentationPort(): AgentPresentationPortV1 {
  return {
    inputOwnership: 'external',
    start: async () => undefined,
    accept: (_event: AgentPresentationEventV1) => undefined,
    subscribeInput: (_listener: (event: AgentPresentationInputEventV1) => void | Promise<void>) => () => undefined,
    snapshot: () => ({ working: 'idle' }),
    stop: async () => undefined,
  };
}

describe('Octocode Agent public API v1 definition', () => {
  it('publishes discriminated control, sensitive-hook, and redacted-observer event DTOs', () => {
    type ControlToolEnded = Extract<AgentControlEventByTypeV1, { type: 'tool.ended' }>;
    type SensitiveToolRequested = Extract<AgentLifecycleSensitiveEventByTypeV1, {
      eventType: 'tool.requested';
    }>;
    type ObservedInput = Extract<AgentLifecycleObservedEventByTypeV1, {
      eventType: 'input.received';
    }>;

    expectTypeOf<keyof AgentControlPayloadMapV1>()
      .toEqualTypeOf<AgentControlEventByTypeV1['type']>();
    expectTypeOf<ControlToolEnded['payload']>()
      .toEqualTypeOf<Readonly<{
        callId: string;
        name: string;
        outcome: string;
        category?: string;
      }>>();
    expectTypeOf<SensitiveToolRequested['dataClassification']>().toEqualTypeOf<'sensitive'>();
    expectTypeOf<SensitiveToolRequested['payload']>()
      .toMatchTypeOf<Readonly<{ callId: string; name: string; input: unknown }>>();
    expectTypeOf<ObservedInput['dataClassification']>().toEqualTypeOf<'redacted'>();
    expectTypeOf<keyof ObservedInput['payload']>().toEqualTypeOf<'source'>();
  });

  it('publishes a self-contained portable module factory authoring contract', () => {
    const factory: AgentPortableCustomizationFactoryV1 = async (context) => ({
      schemaVersion: 1,
      id: 'com.acme.portable',
      productPolicyOverlay: { mode: 'append', content: context.target },
    });
    expectTypeOf<Awaited<ReturnType<typeof factory>>>()
      .toEqualTypeOf<AgentPortableContributionSetV1>();
  });

  it('accepts the complete v1 surface and deeply freezes declarative state', () => {
    const input = fullCustomization();
    const definition = defineOctocodeAgentV1(input as never);

    expect(definition).toEqual(input);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.productPolicyOverlay)).toBe(true);
    expect(Object.isFrozen(definition.tools)).toBe(true);
    expect(Object.isFrozen(definition.tools?.[0])).toBe(true);
    expect(Object.isFrozen(definition.tools?.[0]?.inputSchema)).toBe(true);
    expect(Object.isFrozen(definition.hooks)).toBe(true);
    expect(Object.isFrozen(definition.events)).toBe(true);
    expect(Object.isFrozen(definition.compaction)).toBe(true);

    expect(Reflect.set(definition, 'id', 'com.acme.mutated')).toBe(false);
    expect(() => (definition.tools as unknown as Array<ReturnType<typeof customTool>>)
      .push(customTool('later'))).toThrow(TypeError);
    expect(input).not.toBe(definition);
  });

  it.each(['prepend', 'append', 'replace'] as const)(
    'accepts product policy overlay mode %s',
    (mode) => {
      expect(defineOctocodeAgentV1({
        schemaVersion: 1,
        id: `com.acme.${mode}`,
        productPolicyOverlay: { mode, content: `${mode} policy` },
      })).toMatchObject({ productPolicyOverlay: { mode } });
    },
  );

  it.each([
    ['unknown schema version', { schemaVersion: 2, id: 'com.acme.agent' }, /schemaVersion|version/i],
    ['unknown top-level key', { schemaVersion: 1, id: 'com.acme.agent', secret: true }, /secret|unknown/i],
    ['empty id', { schemaVersion: 1, id: '' }, /id/i],
    ['path-like id', { schemaVersion: 1, id: '../acme' }, /id/i],
    ['unknown overlay mode', {
      schemaVersion: 1,
      id: 'com.acme.agent',
      productPolicyOverlay: { mode: 'merge', content: 'policy' },
    }, /mode/i],
    ['unknown overlay key', {
      schemaVersion: 1,
      id: 'com.acme.agent',
      productPolicyOverlay: { mode: 'append', content: 'policy', priority: 100 },
    }, /priority|unknown/i],
  ])('rejects %s', (_label, input, message) => {
    expect(() => defineOctocodeAgentV1(input as never)).toThrow(message as RegExp);
  });

  it('rejects duplicate additive tool names', () => {
    expect(() => defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.duplicates',
      tools: [customTool('echo', 'tool.echo-one'), customTool('echo', 'tool.echo-two')],
    } as never)).toThrow(/duplicate.*tool|tool.*echo/i);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe compaction threshold %s',
    (inputTokenThreshold) => {
      expect(() => defineOctocodeAgentV1({
        schemaVersion: 1,
        id: 'com.acme.compaction',
        compaction: { inputTokenThreshold },
      } as never)).toThrow(/compaction|threshold|token/i);
    },
  );

  it.each([
    ['hook authority', {
      hooks: [{
        id: 'unsafe-hook',
        event: 'tool.requested',
        authority: ['rewrite', 'stop'],
        handle: async () => ({ kind: 'continue' }),
      }],
    }, /authority|unknown/i],
    ['event rewrite', {
      events: [{
        id: 'unsafe-event',
        event: 'tool.ended',
        rewrite: true,
        observe: async () => undefined,
      }],
    }, /rewrite|observe|unknown/i],
  ])('derives fixed authority and rejects caller-supplied %s fields', (_label, contribution, message) => {
    expect(() => defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.fixed-authority',
      ...contribution,
    } as never)).toThrow(message);
  });

  it('uses canonical runtime event names for compaction', () => {
    expect(() => defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.compaction-events',
      events: [
        { id: 'before', event: 'context.compaction-started', observe: () => undefined },
        { id: 'after', event: 'context.compacted', observe: () => undefined },
      ],
    })).not.toThrow();

    expect(() => defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.noncanonical-events',
      events: [{ id: 'before', event: 'compaction-started', observe: () => undefined }],
    } as never)).toThrow(/unsupported|event/i);
  });
});

describe('Octocode Agent public API v1 launch boundary', () => {
  it.each([
    ['tools', { tools: [customTool()] }],
    ['hooks', {
      hooks: [{
        id: 'guard-tool-request',
        event: 'tool.requested',
        handle: async () => ({ kind: 'continue' }),
      }],
    }],
    ['events', {
      events: [{
        id: 'audit-tool-result',
        event: 'tool.ended',
        observe: async () => undefined,
      }],
    }],
    ['compaction summarizer', {
      compaction: {
        inputTokenThreshold: 4_096,
        summarize: async () => ({ summary: 'summary', retainedEventIds: [] }),
      },
    }],
    ['presentation factory', {
      presentation: () => presentationPort(),
    }],
    ['dispose callback', { dispose: async () => undefined }],
  ])('fails closed for --allow-workers with %s callbacks', async (_label, contribution) => {
    const customization = defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.root-only',
      ...contribution,
    } as never);

    await expect(launchOctocodeAgentV1({
      argv: ['run', '--allow-workers', 'review this'],
      customization,
    })).rejects.toThrow(/allow-workers|worker.*callback|callback.*worker/i);
  });

  it('rejects unknown launch options instead of exposing launcher dependencies', async () => {
    await expect(launchOctocodeAgentV1({
      argv: ['run', '--help'],
      createRuntime: () => undefined,
    } as never)).rejects.toThrow(/createRuntime|unknown/i);
  });

  it('disposes API-owned customization when launcher startup fails before runtime composition', async () => {
    const dispose = vi.fn(async () => undefined);
    const customization = defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.startup-failure',
      dispose,
    });
    await expect(launchOctocodeAgentV1({
      argv: ['review this'],
      cwd: `/tmp/octocode-missing-${Date.now()}/child`,
      customization,
    })).rejects.toThrow();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('accepts a closed portable worker descriptor without the legacy environment budget', () => {
    const customization = defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.portable',
      portable: {
        schemaVersion: 1,
        id: 'com.acme.portable',
        entrypoint: {
          kind: 'module',
          moduleUrl: 'file:///tmp/acme-portable.mjs',
          exportName: 'activate',
          integrity: `sha256-${'a'.repeat(64)}`,
        },
        config: { policy: 'x'.repeat(17 * 1_024) },
        workerContributions: ['tool:review', 'hook:guard', 'event:audit', 'compaction'],
      },
    });
    expect(customization.portable?.workerContributions).toHaveLength(4);
    expect(Object.isFrozen(customization.portable)).toBe(true);
  });

  it('rejects portable identity drift and ambiguous inline runtime callbacks', () => {
    const portable = {
      schemaVersion: 1 as const,
      id: 'com.acme.other',
      entrypoint: {
        kind: 'module' as const,
        moduleUrl: 'file:///tmp/acme-portable.mjs',
        exportName: 'activate',
        integrity: `sha256-${'a'.repeat(64)}` as const,
      },
      workerContributions: [] as const,
    };
    expect(() => defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.portable',
      portable,
    })).toThrow(/id.*match/i);
    expect(() => defineOctocodeAgentV1({
      schemaVersion: 1,
      id: 'com.acme.other',
      portable,
      tools: [customTool()],
    } as never)).toThrow(/portable.*inline|inline.*portable/i);
  });

  it('publishes the renderer-neutral presentation v1 source entry', async () => {
    await expect(import('../src/presentation/v1.js')).resolves.toBeTypeOf('object');

    const factory: AgentPresentationFactoryV1 = () => presentationPort();
    expect(factory({
      schemaVersion: 1,
      cwd: process.cwd(),
      alternateOutput: false,
      reducedMotion: false,
    }).inputOwnership).toBe('external');
  });
});
