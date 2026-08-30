import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceAgentRoot } from '@octocodeai/octocode-shared/paths';
import { ToolRegistry } from '@octocodeai/agent-core';
import { listNativeSkillInventory, listNativeSkillSummaries, registerNativeSkillTool } from '../src/native-skills.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${description}`);
}

const execution = (input: unknown, cwd: string) => ({
  input,
  callId: 'call:skill-discovery' as never,
  context: { sessionId: 's' as never, cwd, mode: 'headless' as const, trust: { workspace: 'trusted' as const, managedOnly: false }, signal: new AbortController().signal },
  signal: new AbortController().signal,
  update: async () => undefined,
});

describe('native Skill discovery policy', () => {
  it('inventories foreign Skills but exposes only canonical Octocode Skills by default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-discovery-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode-home');
    const workspace = path.join(root, 'repo', 'packages', 'app');
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeSkill(path.join(octocodeHome, 'agent', 'skills'), 'native-user', 'Native user skill.');
    writeSkill(path.join(workspaceAgentRoot(path.join(root, 'repo'), octocodeHome), 'skills'), 'native-workspace', 'Native workspace skill.');
    writeSkill(path.join(home, '.agents', 'skills'), 'foreign-user', 'Foreign user skill.');
    writeSkill(path.join(workspace, '.pi', 'skills'), 'foreign-workspace', 'Foreign workspace skill.');

    const options = { cwd: workspace, homeDir: home, octocodeHome };
    const inventory = listNativeSkillInventory(options);

    expect(inventory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'native-user', vendor: 'octocode', scope: 'user', enabled: true, path: expect.stringContaining('SKILL.md'), hash: expect.stringMatching(/^sha256:/), revision: expect.stringMatching(/^sha256:/) }),
      expect.objectContaining({ name: 'native-workspace', vendor: 'octocode', scope: 'workspace', enabled: true }),
      expect.objectContaining({ name: 'foreign-user', vendor: 'agents', scope: 'user', enabled: false }),
      expect.objectContaining({ name: 'foreign-workspace', vendor: 'pi', scope: 'workspace', enabled: false }),
    ]));
    expect(listNativeSkillSummaries(options).map(({ name }) => name)).toEqual(['native-user', 'native-workspace']);
  });

  it('lets the explicit enablement callback override source defaults', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-policy-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const foreignRoot = path.join(home, '.agents', 'skills');
    writeSkill(foreignRoot, 'foreign', 'Foreign skill.');

    expect(listNativeSkillSummaries({ cwd: root, homeDir: home, octocodeHome: path.join(root, 'octocode-home') })).toEqual([]);
    expect(listNativeSkillSummaries({ cwd: root, homeDir: home, octocodeHome: path.join(root, 'octocode-home'), isEnabled: () => true }))
      .toEqual([{ name: 'foreign', description: 'Foreign skill.' }]);
  });

  it('re-reads enablement before every tool action so settings changes apply without restarting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-live-policy-'));
    roots.push(root);
    const home = path.join(root, 'home');
    writeSkill(path.join(home, '.agents', 'skills'), 'foreign', 'Foreign skill.');
    let enabled = false;
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, {
      cwd: root,
      homeDir: home,
      octocodeHome: path.join(root, 'octocode-home'),
      isEnabled: () => enabled,
    });
    const tool = registry.get('skill')!;

    expect(await tool.execute(execution({ action: 'list' }, root)))
      .toMatchObject({ content: { skills: [] } });
    enabled = true;
    expect(await tool.execute(execution({ action: 'list' }, root)))
      .toMatchObject({ content: { skills: [{ name: 'foreign' }] } });
    enabled = false;
    await expect(tool.execute(execution({ action: 'load', name: 'foreign' }, root)))
      .rejects.toThrow('Unknown or disabled skill: foreign');
  });

  it('discovers a Skill source root created after tool registration without restarting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-live-root-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const octocodeHome = path.join(root, 'octocode-home');
    const managedRoot = path.join(octocodeHome, 'agent', 'skills');
    const registry = new ToolRegistry();
    registerNativeSkillTool(registry, { cwd: root, homeDir: home, octocodeHome });
    const tool = registry.get('skill')!;

    expect(await tool.execute(execution({ action: 'list' }, root)))
      .toMatchObject({ content: { skills: [] } });
    writeSkill(managedRoot, 'late-skill', 'Late skill.');

    expect(await tool.execute(execution({ action: 'list' }, root)))
      .toMatchObject({ content: { skills: [expect.objectContaining({ name: 'late-skill' })] } });
    expect(await tool.execute(execution({ action: 'load', name: 'late-skill' }, root)))
      .toMatchObject({ content: { name: 'late-skill', instructions: 'Late skill.' } });
  });

  it('inventories global workspace Skills but disables them when the workspace is untrusted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skill-untrusted-'));
    roots.push(root);
    const workspace = path.join(root, 'repo', 'packages', 'app');
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeSkill(path.join(workspaceAgentRoot(path.join(root, 'repo'), path.join(root, 'octocode-home')), 'skills'), 'workspace-skill', 'Workspace skill.');

    const inventory = listNativeSkillInventory({
      cwd: workspace,
      homeDir: path.join(root, 'home'),
      octocodeHome: path.join(root, 'octocode-home'),
      workspaceTrusted: false,
    });

    expect(inventory.entries).toContainEqual(expect.objectContaining({ name: 'workspace-skill', vendor: 'octocode', scope: 'workspace', enabled: false }));
    expect(listNativeSkillSummaries({
      cwd: workspace,
      homeDir: path.join(root, 'home'),
      octocodeHome: path.join(root, 'octocode-home'),
      workspaceTrusted: false,
    })).toEqual([]);
  });
});
