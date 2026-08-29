import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, RuntimeSnapshot } from '@octocodeai/agent-core';
import { discoverNativeFilesystemExtensions, resolveNativeExtensionPolicy } from '../src/native-extension-adapters.js';
import type { NativeExtensionsController } from '../src/native-extensions.js';
import { launchNativeAgent } from '../src/native-launcher.js';
import { FileSettingsStorage } from '../src/native-settings.js';
import { agentDir } from '../src/settings.js';

function runtime(): AgentRuntime {
  return {
    start: vi.fn(async () => undefined), submit: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ ok: true, data: {} })), snapshot: () => ({ state: 'ready' }) as RuntimeSnapshot,
    subscribe: () => () => undefined, stop: vi.fn(async () => undefined),
  };
}

describe('production plugin activation composition', () => {
  it('keeps unreviewed plugins inactive, activates exact reviewed+granted filesystem plugins, projects contributions, and unloads cleanly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-plugin-production-'));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'workspace');
    const pluginRoot = path.join(home, '.codex', 'plugins', 'example');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'contributions'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'example', version: '1.0.0', octocode: {
        apiVersion: '1', activationEvents: ['onSessionStart'], permissions: ['tools.register'],
        contributes: { tools: ['./contributions/tools.json'] },
      },
    }));
    fs.writeFileSync(path.join(pluginRoot, 'contributions', 'tools.json'), JSON.stringify([{ id: 'search', description: 'projected' }]));
    const env = { OCTOCODE_HOME: path.join(root, 'octocode-home'), HOME: home };
    const storage = new FileSettingsStorage(path.join(agentDir(env), 'settings.json'));
    storage.commit('0', { workspaceTrust: { [cwd]: 'trusted' } });

    let unreviewed!: NativeExtensionsController;
    await launchNativeAgent(['--print', 'hello'], {
      env, cwd, stdout: new PassThrough(),
      createRuntime: async (options) => { unreviewed = options.extensions; return runtime(); },
    });
    expect(unreviewed.snapshot()).toMatchObject({
      plugins: [{ id: 'example', active: false, review: 'review-required' }], contributions: [],
    });

    const discovered = await discoverNativeFilesystemExtensions({ home, workspace: cwd, workspaceTrusted: true });
    const hash = discovered.plugins[0]!.manifestHash;
    const current = storage.read();
    storage.commit(current.revision, {
      ...current.values,
      nativeExtensions: {
        reviewedHashes: { example: hash },
        pluginGrants: { example: ['tools.register'] },
      },
    });

    let active!: NativeExtensionsController;
    let activeProjection: unknown;
    await launchNativeAgent(['--print', 'hello'], {
      env, cwd, stdout: new PassThrough(),
      createRuntime: async (options) => {
        active = options.extensions;
        activeProjection = options.extensions.snapshot();
        return runtime();
      },
    });
    expect(activeProjection).toMatchObject({
      plugins: [{ id: 'example', active: true, review: 'approved' }],
      contributions: [{ kind: 'tool', id: 'example:search', owner: 'example', value: { description: 'projected' } }],
    });
    expect(active.snapshot()).toMatchObject({ plugins: [{ active: false, lifecycle: 'stopped' }], contributions: [], activeLeases: [] });

    let failed!: NativeExtensionsController;
    await expect(launchNativeAgent(['--print', 'hello'], {
      env, cwd, stdout: new PassThrough(),
      createRuntime: async (options) => { failed = options.extensions; throw new Error('runtime construction failed'); },
    })).rejects.toThrow('runtime construction failed');
    expect(failed.snapshot()).toMatchObject({ plugins: [{ active: false, lifecycle: 'stopped' }], contributions: [] });
  });

  it('parses persisted approvals strictly and grants nothing by default', () => {
    expect(resolveNativeExtensionPolicy({})).toEqual({ reviewedHashes: {}, pluginGrants: {} });
    expect(() => resolveNativeExtensionPolicy({ nativeExtensions: { reviewedHashes: { example: 'bad' } } })).toThrow(/review hash/i);
    expect(() => resolveNativeExtensionPolicy({ nativeExtensions: { pluginGrants: { example: ['secrets.root'] } } })).toThrow(/permission grant/i);
  });
});
