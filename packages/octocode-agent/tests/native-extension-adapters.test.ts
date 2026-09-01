import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeExtensionsController } from '../src/native-extensions.js';
import {
  NativeHookCommandExecutor,
  createNativeFilesystemExtensionsOptions,
  discoverNativeFilesystemExtensions,
} from '../src/native-extension-adapters.js';

function fixture(): { root: string; home: string; workspace: string; plugins: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-extensions-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const plugins = path.join(root, 'plugins');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
  fs.mkdirSync(plugins, { recursive: true });
  return { root, home, workspace, plugins };
}

describe('native filesystem extension adapters', () => {
  it('discovers sorted immediate user/workspace plugin roots by default and denies untrusted workspace plugins', async () => {
    const paths = fixture();
    const writePlugin = (base: string, directory: string, name: string) => {
      const root = path.join(base, '.codex', 'plugins', directory);
      fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version: '1', octocode: { apiVersion: '1', permissions: [], contributes: {} } }));
      return root;
    };
    writePlugin(paths.workspace, 'z-last', 'workspace-plugin');
    writePlugin(paths.home, 'b-second', 'user-b');
    writePlugin(paths.home, 'a-first', 'user-a');
    fs.mkdirSync(path.join(paths.home, '.codex', 'plugins', 'ignored'), { recursive: true });

    const discovered = await discoverNativeFilesystemExtensions({ home: paths.home, workspace: paths.workspace, workspaceTrusted: false });
    expect(discovered.plugins.map(({ manifest, trust }) => [manifest.id, trust])).toEqual([
      ['user-a', 'trusted'], ['user-b', 'trusted'], ['workspace-plugin', 'denied'],
    ]);

    const explicit = writePlugin(paths.root, 'explicit', 'explicit-only');
    const selected = await discoverNativeFilesystemExtensions({ home: paths.home, workspace: paths.workspace, workspaceTrusted: true, pluginRoots: [explicit] });
    expect(selected.plugins.map(({ manifest }) => manifest.id)).toEqual(['explicit-only']);
  });

  it('discovers exact Codex hooks, rejects inert declarative tools, and preserves hash review invalidation', async () => {
    const paths = fixture();
    const hookFile = path.join(paths.workspace, '.codex', 'hooks.json');
    fs.writeFileSync(hookFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^edit$', hooks: [{ type: 'command', command: 'check', timeout: 2 }] }] } }));
    const pluginRoot = path.join(paths.plugins, 'example');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'contributions'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'example', version: '1.0.0', hooks: './hooks.json', octocode: {
        apiVersion: '1', activationEvents: ['onSessionStart'], permissions: ['tools.register'],
        contributes: { tools: ['./contributions/tools.json'] },
      },
    }));
    fs.writeFileSync(path.join(pluginRoot, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }));
    fs.writeFileSync(path.join(pluginRoot, 'contributions', 'tools.json'), JSON.stringify([{ id: 'search', description: 'safe' }]));

    const first = await discoverNativeFilesystemExtensions({
      home: paths.home, workspace: paths.workspace, pluginRoots: [pluginRoot], workspaceTrusted: true,
    });
    expect(first.hooks).toHaveLength(2);
    expect(first.hooks[0]?.configuration.hooks.PreToolUse?.[0]?.handlers[0]).toMatchObject({ type: 'command', timeoutSeconds: 2 });
    expect(first.plugins[0]?.manifest).toMatchObject({ id: 'example', contributions: [{ kind: 'tool', path: './contributions/tools.json' }] });

    const reviewedHashes = {
      ...Object.fromEntries(first.hooks.map((entry) => [entry.source.id, entry.source.normalizedHash])),
      example: first.plugins[0]!.manifestHash,
    };
    const controller = new NativeExtensionsController(createNativeFilesystemExtensionsOptions({
      home: paths.home, workspace: paths.workspace, pluginRoots: [pluginRoot], workspaceTrusted: true, reviewedHashes,
      pluginGrants: { example: ['tools.register'] },
    }));
    await controller.discover();
    await expect(controller.activateEligible()).rejects.toThrow(/requires an executable activation API/);
    expect(controller.snapshot().contributions).toEqual([]);

    fs.writeFileSync(path.join(pluginRoot, 'contributions', 'tools.json'), JSON.stringify([{ id: 'search', description: 'changed' }]));
    const stalePlugin = new NativeExtensionsController(createNativeFilesystemExtensionsOptions({
      home: paths.home, workspace: paths.workspace, pluginRoots: [pluginRoot], workspaceTrusted: true, reviewedHashes,
      pluginGrants: { example: ['tools.register'] },
    }));
    await stalePlugin.discover();
    expect(stalePlugin.snapshot().plugins[0]).toMatchObject({ review: 'stale' });
    await expect(stalePlugin.activate('example')).rejects.toThrow(/reviewed and trusted/i);

    fs.writeFileSync(hookFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'changed' }] }] } }));
    const changed = new NativeExtensionsController(createNativeFilesystemExtensionsOptions({
      home: paths.home, workspace: paths.workspace, pluginRoots: [pluginRoot], workspaceTrusted: true, reviewedHashes,
      pluginGrants: { example: ['tools.register'] },
    }));
    await changed.discover();
    expect(changed.snapshot().hooks.entries[0]).toMatchObject({ executable: false });
  });

  it('fails closed for untrusted workspace hooks, malformed manifests, and symlink escapes', async () => {
    const paths = fixture();
    fs.writeFileSync(path.join(paths.workspace, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }));
    const untrusted = await discoverNativeFilesystemExtensions({ home: paths.home, workspace: paths.workspace, workspaceTrusted: false });
    expect(untrusted.hooks[0]?.source.trust).toBe('denied');

    const pluginRoot = path.join(paths.plugins, 'bad');
    fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'bad', version: '1', octocode: { apiVersion: '1', permissions: ['tools.register'], contributes: { tools: ['./escape.json'] } } }));
    fs.symlinkSync(path.join(paths.root, 'outside.json'), path.join(pluginRoot, 'escape.json'));
    fs.writeFileSync(path.join(paths.root, 'outside.json'), '{}');
    await expect(discoverNativeFilesystemExtensions({ home: paths.home, workspace: paths.workspace, pluginRoots: [pluginRoot], workspaceTrusted: true })).rejects.toThrow(/contained|symlink/i);

    fs.rmSync(path.join(pluginRoot, 'escape.json'));
    fs.writeFileSync(path.join(pluginRoot, 'escape.json'), '{}');
    fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), '{');
    await expect(discoverNativeFilesystemExtensions({ home: paths.home, workspace: paths.workspace, pluginRoots: [pluginRoot], workspaceTrusted: true })).rejects.toThrow(/malformed json/i);
  });

  it('executes a real reviewed command with JSON stdin, minimal env, typed output, bounds, timeout, and cancellation', async () => {
    const paths = fixture();
    const script = path.join(paths.root, 'hook.mjs');
    fs.writeFileSync(script, `let input=''; for await (const c of process.stdin) input+=c; process.stdout.write(JSON.stringify({continue:true,hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:JSON.parse(input).reason},env:Object.keys(process.env)}));`);
    const executor = new NativeHookCommandExecutor({ cwd: paths.workspace, allowShell: true, timeoutGraceMs: 20 });
    const result = await executor.execute({ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, timeoutSeconds: 2, async: false }, { reason: 'blocked' });
    expect(result.decision).toEqual({ kind: 'deny', reason: 'blocked' });
    expect(result.output).toMatchObject({ env: expect.not.arrayContaining(['OPENAI_API_KEY', 'OCTOCODE_API_KEY']) });

    const slow = path.join(paths.root, 'slow.mjs');
    fs.writeFileSync(slow, `setInterval(()=>{},1000);`);
    await expect(executor.execute({ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slow)}`, timeoutSeconds: 0.02, async: false }, {})).rejects.toThrow(/timed out/i);
    const controller = new AbortController();
    const live = executor.execute({ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(slow)}`, timeoutSeconds: 2, async: false }, {}, controller.signal);
    setTimeout(() => controller.abort('cancelled'), 20);
    await expect(live).rejects.toThrow(/cancelled/i);

    const noisy = path.join(paths.root, 'noisy.mjs');
    fs.writeFileSync(noisy, `process.stdout.write('12345');`);
    const bounded = new NativeHookCommandExecutor({ cwd: paths.workspace, allowShell: true, maxOutputBytes: 4, timeoutGraceMs: 20 });
    await expect(bounded.execute({ type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(noisy)}`, timeoutSeconds: 2, async: false }, {})).rejects.toThrow(/output exceeds/i);
  });
});
