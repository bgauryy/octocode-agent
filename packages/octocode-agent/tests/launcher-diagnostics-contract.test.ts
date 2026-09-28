import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceAgentRoot } from '@octocodeai/agent-contracts/paths';

import { helpReport, main } from '../src/launcher.js';

const temporaryRoots: string[] = [];

function fixture(): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  globalAgent: string;
  projectAgent: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-diagnostics-'));
  temporaryRoots.push(root);
  const home = path.join(root, 'home');
  const octocodeHome = path.join(root, 'octocode-home');
  const repository = path.join(root, 'repository');
  const cwd = path.join(repository, 'packages', 'app');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    env: { HOME: home, OCTOCODE_HOME: octocodeHome },
    globalAgent: path.join(octocodeHome, 'agent'),
    projectAgent: workspaceAgentRoot(repository, octocodeHome),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('launcher setup and doctor contract', () => {
  it('separates discovery setup from credential authentication in help', () => {
    const lines = helpReport().split('\n');
    const setupIndex = lines.findIndex((line) => line.trimStart().startsWith('setup '));
    const setupHelp = lines.slice(setupIndex, setupIndex + 2).join(' ');
    const authHelp = lines.find((line) => line.trimStart().startsWith('auth '));
    const doctorHelp = lines.find((line) => line.trimStart().startsWith('doctor '));

    expect(setupHelp).toMatch(/managed discovery/i);
    expect(setupHelp).not.toMatch(/credential/i);
    expect(authHelp).toMatch(/credential/i);
    expect(doctorHelp).toMatch(/runtime.*credentials.*managed discovery/i);
  });

  it('reports managed discovery health independently from missing credentials', async () => {
    const { cwd, env } = fixture();
    const setupOut = vi.fn();

    await expect(main(['setup', '--fix', '--scope', 'all'], { cwd, env, out: setupOut })).resolves.toBe(0);
    expect(fs.existsSync(path.join(env.OCTOCODE_HOME!, '.env'))).toBe(false);

    const out = vi.fn();
    await expect(main(['doctor', '--json'], { cwd, env, out })).resolves.toBe(1);
    const report = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(report.checks.map((check: { name: string }) => check.name)).toEqual([
      'runtime',
      'credentials',
      'managed-discovery',
    ]);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'credentials',
      ok: false,
    }));
    const discovery = report.checks.find((check: { name: string }) => check.name === 'managed-discovery');
    expect(discovery).toMatchObject({ ok: true });
    expect(discovery.detail).toEqual(expect.any(String));
    expect(discovery.detail.length).toBeGreaterThan(0);
  });

  it('fails doctor with the exact invalid managed discovery source', async () => {
    const { cwd, env, projectAgent } = fixture();
    const credentialedEnv = { ...env, OPENAI_API_KEY: 'test-key' };
    await expect(main(['setup', '--fix', '--scope', 'all'], {
      cwd,
      env: credentialedEnv,
      out: vi.fn(),
    })).resolves.toBe(0);
    const invalidMcp = path.join(projectAgent, 'mcp', 'servers.json');
    fs.writeFileSync(invalidMcp, '{ invalid json\n');

    const out = vi.fn();
    await expect(main(['doctor', '--json'], { cwd, env: credentialedEnv, out })).resolves.toBe(1);
    const report = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(report.healthy).toBe(false);
    const discovery = report.checks.find((check: { name: string }) => check.name === 'managed-discovery');
    expect(discovery).toMatchObject({ ok: false });
    expect(discovery.detail).toContain(invalidMcp);
    expect(discovery.detail).toMatch(/invalid/i);
  });

  it('inspects the requested setup scope without requiring --fix', async () => {
    const { cwd, env, projectAgent } = fixture();
    await expect(main(['setup', '--fix', '--scope', 'project'], {
      cwd,
      env,
      out: vi.fn(),
    })).resolves.toBe(0);

    const out = vi.fn();
    await expect(main(['setup', '--scope', 'project', '--json'], { cwd, env, out })).resolves.toBe(0);
    const report = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(report.allGood).toBe(true);
    expect(report.checks).toHaveLength(3);
    expect(report.checks.every((check: { name: string }) => check.name.startsWith(projectAgent))).toBe(true);
  });

  it('ignores removed repository-local managed discovery files', async () => {
    const { cwd, env } = fixture();
    const credentialedEnv = { ...env, OPENAI_API_KEY: 'test-key' };
    const nestedAgent = path.join(cwd, '.octocode', 'agent');
    fs.mkdirSync(nestedAgent, { recursive: true });
    const invalidMcp = path.join(nestedAgent, 'mcp.json');
    fs.writeFileSync(invalidMcp, '{ invalid json\n');

    const out = vi.fn();
    await expect(main(['doctor', '--json'], { cwd, env: credentialedEnv, out })).resolves.toBe(0);
    const report = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    const discovery = report.checks.find((check: { name: string }) => check.name === 'managed-discovery');
    expect(discovery).toMatchObject({ ok: true });
    expect(discovery.detail).not.toContain(invalidMcp);
  });
});
