import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@octocodeai/agent-core';
import { registerNativeSkillTool, type NativeSkillLifecycle } from '../src/native-skills.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const execution = (input: unknown, cwd: string, trust: 'trusted' | 'untrusted' = 'trusted') => ({
  input, callId: 'call:skill' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: trust, managedOnly: false }, signal: new AbortController().signal },
  signal: new AbortController().signal, update: async () => undefined,
});

describe('native Skill lifecycle', () => {
  it('routes authorized refresh/enable/disable/install/update/remove and preserves provenance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-admin-'));
    roots.push(root);
    const managedRoot = path.join(root, '.agents', 'skills');
    fs.mkdirSync(managedRoot, { recursive: true });
    const mutate = vi.fn(async (request) => ({ name: request.name ?? 'catalog', enabled: request.action !== 'disable', provenance: { source: request.source ?? 'managed', revision: 'sha256:abc' } }));
    const lifecycle: NativeSkillLifecycle = { managedRoot, mutate };
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, roots: [managedRoot], lifecycle, authorizeMutation: async () => true });
    const tool = registry.get('skill')!;

    for (const input of [
      { action: 'refresh' }, { action: 'enable', name: 'demo' }, { action: 'disable', name: 'demo' },
      { action: 'install', name: 'demo', source: path.join(root, 'sources', 'demo') },
      { action: 'update', name: 'demo', source: path.join(root, 'sources', 'demo') }, { action: 'remove', name: 'demo' },
    ]) {
      await expect(tool.execute(execution(input, root))).resolves.toMatchObject({ ok: true, content: { provenance: expect.any(Object) } });
    }
    expect(mutate).toHaveBeenCalledTimes(6);
  });

  it('fails closed for untrusted workspaces, absent authorization, and contained-path violations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-deny-'));
    roots.push(root);
    const managedRoot = path.join(root, '.agents', 'skills');
    fs.mkdirSync(managedRoot, { recursive: true });
    const mutate = vi.fn(async () => ({ name: 'demo', provenance: { source: 'managed' } }));
    const lifecycle: NativeSkillLifecycle = { managedRoot, mutate };
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, roots: [managedRoot], lifecycle, authorizeMutation: async () => false });
    const tool = registry.get('skill')!;

    await expect(tool.execute(execution({ action: 'enable', name: 'demo' }, root, 'untrusted'))).rejects.toMatchObject({ category: 'trust' });
    await expect(tool.execute(execution({ action: 'enable', name: 'demo' }, root))).rejects.toMatchObject({ category: 'trust' });
    await expect(tool.execute(execution({ action: 'install', name: 'demo', source: path.join(root, '..', 'escape') }, root))).rejects.toThrow(/source.*workspace/i);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refreshes the live discovery catalog after a lifecycle mutation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-refresh-'));
    roots.push(root);
    const managedRoot = path.join(root, '.agents', 'skills');
    fs.mkdirSync(managedRoot, { recursive: true });
    const lifecycle: NativeSkillLifecycle = {
      managedRoot,
      mutate: async () => {
        const installed = path.join(managedRoot, 'fresh');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(path.join(installed, 'SKILL.md'), '---\nname: fresh\ndescription: Fresh skill.\n---\nFresh.');
        return { name: 'catalog', provenance: { source: managedRoot } };
      },
    };
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, roots: [managedRoot], lifecycle, authorizeMutation: async () => true });
    const tool = registry.get('skill')!;
    expect((await tool.execute(execution({ action: 'list' }, root))).content).toMatchObject({ skills: [] });
    await tool.execute(execution({ action: 'refresh' }, root));
    expect((await tool.execute(execution({ action: 'list' }, root))).content).toMatchObject({ skills: [{ name: 'fresh' }] });
  });
});
