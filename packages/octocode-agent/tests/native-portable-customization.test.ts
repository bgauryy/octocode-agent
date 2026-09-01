import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseNativePortableCustomizationDescriptorV1,
  resolveNativePortableCustomizationV1,
  resolveNativeResolvedPortableCustomizationV1,
  selectNativePortableCustomizationForWorkerV1,
  type NativePortableCustomizationDescriptorV1,
} from '../src/native-portable-customization.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixtureModule(source: string): Promise<{ url: string; integrity: `sha256-${string}` }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-portable-'));
  roots.push(root);
  const file = path.join(root, 'customization.mjs');
  await fs.writeFile(file, source);
  const bytes = await fs.readFile(file);
  return {
    url: pathToFileURL(file).href,
    integrity: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function descriptor(
  module: { url: string; integrity: `sha256-${string}` },
  overrides: Partial<NativePortableCustomizationDescriptorV1> = {},
): NativePortableCustomizationDescriptorV1 {
  return {
    schemaVersion: 1,
    id: 'com.acme.portable',
    entrypoint: {
      kind: 'module',
      moduleUrl: module.url,
      exportName: 'activate',
      integrity: module.integrity,
    },
    config: { greeting: 'hello' },
    workerContributions: ['tool:portableTool', 'hook:pre-tool', 'event:audit', 'compaction'],
    ...overrides,
  };
}

const moduleSource = `
export async function activate(context) {
  if (context.schemaVersion !== 1) throw new Error('bad context');
  return {
    schemaVersion: 1,
    id: 'com.acme.portable',
    productPolicyOverlay: { mode: 'append', content: context.config.greeting },
    tools: [{
      id: 'portableTool', name: 'portableTool', label: 'Portable', description: 'Portable tool',
      schemaVersion: 1, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputVersion: 1,
      policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
      execute: async () => ({ ok: true, content: context.target, detailsVersion: 1 }),
    }, {
      id: 'rootOnly', name: 'rootOnly', label: 'Root', description: 'Root-only tool',
      schemaVersion: 1, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputVersion: 1,
      policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
      execute: async () => ({ ok: true, content: 'root', detailsVersion: 1 }),
    }],
    hooks: [{ id: 'pre-tool', event: 'tool.requested', handle: async () => ({ kind: 'continue' }) }],
    events: [{ id: 'audit', event: 'tool.ended', observe: async () => undefined }],
    compaction: {
      inputTokenThreshold: 4096,
      summarize: async () => ({ summary: 'portable', retainedEventIds: [] }),
    },
    dispose: async () => undefined,
  };
}
`;

describe('native portable customization', () => {
  it('resolves an exact-hash module factory and produces a deterministic callback-free manifest', async () => {
    const module = await fixtureModule(moduleSource);
    const first = await resolveNativePortableCustomizationV1(descriptor(module), { target: 'root' });
    const second = await resolveNativePortableCustomizationV1(descriptor(module), {
      target: 'worker',
      expectedManifestSha256: first.descriptor.manifestSha256,
    });

    expect(first.descriptor.entrypoint.moduleUrl).toMatch(/^file:\/\//u);
    expect(fileURLToPath(first.descriptor.entrypoint.moduleUrl)).toBe(await fs.realpath(fileURLToPath(module.url)));
    expect(first.descriptor.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.descriptor.manifestSha256).toBe(first.descriptor.manifestSha256);
    await expect(resolveNativeResolvedPortableCustomizationV1(first.descriptor, { target: 'worker' }))
      .resolves.toMatchObject({ descriptor: { manifestSha256: first.descriptor.manifestSha256 } });
    expect(first.customization.tools?.map(({ name }) => name)).toEqual(['portableTool', 'rootOnly']);
    expect(JSON.stringify(first.manifest)).not.toContain('execute');
    expect(JSON.stringify(first.manifest)).not.toContain('summarize');
  });

  it('filters explicit worker selectors and intersects tool names with delegated capabilities', async () => {
    const module = await fixtureModule(moduleSource);
    const resolved = await resolveNativePortableCustomizationV1(descriptor(module), { target: 'worker' });
    const selected = selectNativePortableCustomizationForWorkerV1(resolved, {
      allowedTools: ['portableTool'],
      allowedContributions: ['tool:portableTool', 'hook:pre-tool', 'compaction'],
    });

    expect(selected.tools?.map(({ name }) => name)).toEqual(['portableTool']);
    expect(selected.hooks?.map(({ id }) => id)).toEqual(['pre-tool']);
    expect(selected.events).toBeUndefined();
    expect(selected.compaction?.summarize).toBeTypeOf('function');
    expect(selected.productPolicyOverlay?.content).toBe('hello');
    expect(selected.dispose).toBeTypeOf('function');
  });

  it('rejects malformed descriptors, non-JSON config, duplicate selectors, and hash drift', async () => {
    const module = await fixtureModule(moduleSource);
    expect(() => parseNativePortableCustomizationDescriptorV1({
      ...descriptor(module),
      extra: true,
    })).toThrow(/closed|unknown/i);
    expect(() => parseNativePortableCustomizationDescriptorV1({
      ...descriptor(module),
      config: { invalid: undefined },
    })).toThrow(/json/i);
    expect(() => parseNativePortableCustomizationDescriptorV1({
      ...descriptor(module),
      workerContributions: ['tool:portableTool', 'tool:portableTool'],
    })).toThrow(/duplicate/i);
    await expect(resolveNativePortableCustomizationV1(descriptor(module, {
      entrypoint: { ...descriptor(module).entrypoint, integrity: `sha256-${'0'.repeat(64)}` },
    }), { target: 'root' })).rejects.toThrow(/integrity/i);
  });

  it('rejects manifest drift and selectors that do not identify returned contributions', async () => {
    const module = await fixtureModule(moduleSource);
    await expect(resolveNativePortableCustomizationV1(descriptor(module), {
      target: 'worker',
      expectedManifestSha256: '0'.repeat(64),
    })).rejects.toThrow(/manifest/i);
    const invalid = descriptor(module, { workerContributions: ['tool:missing'] });
    await expect(resolveNativePortableCustomizationV1(invalid, { target: 'root' }))
      .rejects.toThrow(/selector/i);
  });

  it('disposes an activated factory result when post-activation validation fails', async () => {
    const module = await fixtureModule(`
      export async function activate() {
        return {
          schemaVersion: 1,
          id: 'com.acme.portable',
          tools: [],
          dispose: async () => { globalThis.__octocodePortableDisposed = true; },
        };
      }
    `);
    delete (globalThis as { __octocodePortableDisposed?: boolean }).__octocodePortableDisposed;
    await expect(resolveNativePortableCustomizationV1(descriptor(module, {
      workerContributions: ['tool:missing'],
    }), { target: 'root' })).rejects.toThrow(/selector/i);
    expect((globalThis as { __octocodePortableDisposed?: boolean }).__octocodePortableDisposed).toBe(true);
  });

  it.each([1, 4_095, 2_000_001])('enforces the public compaction threshold range for %s', async (threshold) => {
    const module = await fixtureModule(`
      export async function activate() {
        return {
          schemaVersion: 1,
          id: 'com.acme.portable',
          compaction: { inputTokenThreshold: ${threshold} },
        };
      }
    `);
    await expect(resolveNativePortableCustomizationV1(descriptor(module, {
      workerContributions: ['compaction'],
    }), { target: 'root' })).rejects.toThrow(/compaction.*threshold/i);
  });
});
