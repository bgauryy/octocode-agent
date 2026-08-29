import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeOctocodeDb, getMcpEnablement, getSkillEnablement, octocodeDbPath, openOctocodeDb } from '@octocodeai/octocode-awareness/mcp-state';
import { createNativeInteractionBroker } from '../src/native-interactions.js';
import { createNativeCapabilityComposition, createNativeSettingsCapabilityControl } from '../src/native-tools.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('native MCP/Skill production composition', () => {
  it('maps safe single-field elicitation through the interaction broker and declines secrets or URLs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capabilities-'));
    roots.push(root);
    const interactions = createNativeInteractionBroker();
    const handler = vi.fn(async () => ({ status: 'accepted' as const, value: 'blue' }));
    interactions.attach(handler);
    const composition = createNativeCapabilityComposition({ cwd: root, env: { OCTOCODE_HOME: path.join(root, 'home') }, interactions, workspaceTrust: 'trusted' });

    await expect(composition.mcp.elicit!({
      server: 'fixture', message: 'Choose a color', mode: 'form',
      requestedSchema: { type: 'object', required: ['color'], properties: { color: { type: 'string', enum: ['blue', 'green'] } } },
    })).resolves.toEqual({ action: 'accept', content: { color: 'blue' } });
    await expect(composition.mcp.elicit!({
      server: 'fixture', message: 'Token', mode: 'form',
      requestedSchema: { type: 'object', properties: { apiToken: { type: 'string' } } },
    })).resolves.toEqual({ action: 'decline' });
    await expect(composition.mcp.elicit!({ server: 'fixture', message: 'Open', mode: 'url', url: 'https://example.test' }))
      .resolves.toEqual({ action: 'decline' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('installs, updates, enables, disables, refreshes, and removes a workspace-contained skill with provenance', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-composition-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    const source = path.join(root, 'sources', 'demo');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\nFirst.');
    const interactions = createNativeInteractionBroker();
    interactions.attach(async () => ({ status: 'accepted', value: true }));
    const env = { OCTOCODE_HOME: path.join(root, 'home') };
    const composition = createNativeCapabilityComposition({ cwd: root, env, interactions, workspaceTrust: 'trusted' });
    const lifecycle = composition.skills.lifecycle!;

    const install = await lifecycle.mutate({ action: 'install', name: 'demo', source, managedRoot: lifecycle.managedRoot });
    expect(install.provenance).toMatchObject({ scope: 'workspace', operation: 'install', source: fs.realpathSync(source) });
    expect(fs.readFileSync(path.join(lifecycle.managedRoot, 'demo', 'SKILL.md'), 'utf8')).toContain('First.');
    fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill.\n---\nSecond.');
    await lifecycle.mutate({ action: 'update', name: 'demo', source, managedRoot: lifecycle.managedRoot });
    expect(fs.readFileSync(path.join(lifecycle.managedRoot, 'demo', 'SKILL.md'), 'utf8')).toContain('Second.');

    await lifecycle.mutate({ action: 'disable', name: 'demo', managedRoot: lifecycle.managedRoot });
    const dbFile = octocodeDbPath(env);
    const db = openOctocodeDb(dbFile);
    expect(getSkillEnablement(db, root, 'demo', true)).toBe(false);
    closeOctocodeDb(dbFile);
    await lifecycle.mutate({ action: 'enable', name: 'demo', managedRoot: lifecycle.managedRoot });
    const refreshed = await lifecycle.mutate({ action: 'refresh', managedRoot: lifecycle.managedRoot });
    expect(refreshed.provenance).toMatchObject({ operation: 'refresh', count: expect.any(Number) });
    await lifecycle.mutate({ action: 'remove', name: 'demo', managedRoot: lifecycle.managedRoot });
    expect(fs.existsSync(path.join(lifecycle.managedRoot, 'demo'))).toBe(false);
  });

  it('fails closed when workspace trust or interactive authorization is absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capabilities-deny-'));
    roots.push(root);
    const composition = createNativeCapabilityComposition({ cwd: root, env: { OCTOCODE_HOME: path.join(root, 'home') }, interactions: createNativeInteractionBroker(), workspaceTrust: 'untrusted' });
    await expect(composition.skills.authorizeMutation!({ action: 'remove', name: 'demo', managedRoot: composition.skills.lifecycle!.managedRoot })).resolves.toBe(false);
    await expect(composition.mcp.elicit!({ server: 'fixture', message: 'Value', mode: 'form', requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } }))
      .resolves.toEqual({ action: 'decline' });
  });

  it('rejects a managed skill root redirected outside the workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capabilities-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capabilities-link-outside-'));
    roots.push(root, outside);
    fs.symlinkSync(outside, path.join(root, '.octocode'));
    expect(() => createNativeCapabilityComposition({ cwd: root, env: { OCTOCODE_HOME: path.join(root, 'home') }, interactions: createNativeInteractionBroker(), workspaceTrust: 'trusted' }))
      .toThrow(/managed skill root.*workspace/i);
  });

  it('shares MCP and Skill lifecycle authorities with the settings control plane', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-settings-capabilities-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    fs.mkdirSync(path.join(root, '.octocode', 'agent', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(root, '.octocode', 'agent', 'mcp', 'servers.json'), JSON.stringify({ docs: { command: 'docs-mcp' } }));
    const interactions = createNativeInteractionBroker();
    interactions.attach(async () => ({ status: 'accepted', value: true }));
    const env = { OCTOCODE_HOME: path.join(root, 'home') };
    const composition = createNativeCapabilityComposition({ cwd: root, env, interactions, workspaceTrust: 'trusted' });
    const control = createNativeSettingsCapabilityControl({ cwd: root, env, skills: composition.skills });
    const before = control.snapshot();
    expect(before.mcpServers).toContainEqual(expect.objectContaining({ name: 'docs', enabled: true }));
    const changed = await control.mutate({ requestId: 'disable-docs', expectedRevision: before.revision, action: { op: 'set-mcp-server-enabled', server: 'docs', enabled: false } });
    expect(changed.ok).toBe(true);
    const dbFile = octocodeDbPath(env);
    const db = openOctocodeDb(dbFile);
    expect(getMcpEnablement(db, root, 'docs', undefined, true)).toBe(false);
    closeOctocodeDb(dbFile);
    await expect(control.mutate({ requestId: 'stale', expectedRevision: before.revision, action: { op: 'set-mcp-server-enabled', server: 'docs', enabled: true } })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/changed/i) });
  });
});
