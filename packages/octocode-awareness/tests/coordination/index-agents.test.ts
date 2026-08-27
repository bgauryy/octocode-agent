import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAwarenessStore, type AwarenessStore } from '../../src/coordination/index.js';
import { recordSession } from '@octocodeai/octocode-shared/schema';

let workspace: string;
let aw: AwarenessStore;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-lite-'));
  process.env.OCTOCODE_DB_PATH = join(workspace, 'octocode.sqlite3');
  aw = openAwarenessStore({ workspace });
});

afterEach(async () => {
  aw.close();
  delete process.env.OCTOCODE_DB_PATH;
  await rm(workspace, { recursive: true, force: true });
});

describe('agent naming', () => {
  it('generates funny host-tagged names and detects hosts from env', async () => {
    const { detectAgentHost, generateAgentName } = await import('../../src/coordination/index.js');
    expect(detectAgentHost({ CLAUDECODE: '1' })).toBe('claude');
    expect(detectAgentHost({ CURSOR_TRACE_ID: 'x', TERM_PROGRAM: 'vscode' })).toBe('cursor');
    expect(detectAgentHost({ CODEX_THREAD_ID: 'x' })).toBe('codex');
    expect(detectAgentHost({ TERM_PROGRAM: 'vscode' })).toBe('vscode');
    expect(detectAgentHost({ OCTOCODE_AGENT_HOST: 'octo', CLAUDECODE: '1' })).toBe('octo');
    expect(detectAgentHost({})).toBe('agent');
    expect(generateAgentName({ CLAUDECODE: '1' })).toMatch(/^clawde-\w+$/);
    expect(generateAgentName({ OCTOCODE_AGENT_HOST: 'octo' })).toMatch(/^octo-\w+$/);
    expect(generateAgentName({ CURSOR_AGENT: '1' })).toMatch(/^cursea-\w+$/);
  });

  it('joinAgent defaults to a generated host-tagged name and keeps it on rejoin', () => {
    const joined = aw.joinAgent({ agentId: 'anon-1' });
    expect(joined.name).toMatch(/^[a-z]+-\w+$/);
    const rejoined = aw.joinAgent({ agentId: 'anon-1' });
    expect(rejoined.name).toBe(joined.name);
    // Explicit names always win, including over a previously generated one.
    expect(aw.joinAgent({ agentId: 'anon-1', name: 'my-bot' }).name).toBe('my-bot');
    expect(aw.joinAgent({ agentId: 'named', name: 'Alice' }).name).toBe('Alice');
  });

  it('creates the shared agent/session tables in the same file as lite tables', () => {
    const raw = new DatabaseSync(aw.dbPath);
    try {
      const names = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(names).toEqual(expect.arrayContaining([
        'plans', 'tasks', 'locks', 'work_presence', 'handoffs', 'memories', 'agents', 'messages', 'message_receipts',
        'octocode_meta', 'agent_sessions', 'mcp_server_overrides', 'mcp_tool_overrides', 'skill_overrides', 'mcp_catalog_state',
      ]));
      // and the shared recordSession() works on the very same file.
      recordSession(raw, { sessionId: 'sess-1', workspacePath: workspace, cwd: workspace });
      const row = raw.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get('sess-1') as {
        workspace_path: string;
      };
      expect(row.workspace_path).toBe(workspace);
    } finally {
      raw.close();
    }
  });
});

describe('AwarenessStore cross-workspace isolation (single global file)', () => {
  let root: string;
  let dbPath: string;
  let repoA: string;
  let repoB: string;
  let a: AwarenessStore;
  let b: AwarenessStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aw-lite-iso-'));
    // ONE shared db file, two distinct workspaces — the global-store model.
    dbPath = join(root, 'octocode.sqlite3');
    repoA = join(root, 'repo-a');
    repoB = join(root, 'repo-b');
    a = openAwarenessStore({ workspace: repoA, dbPath });
    b = openAwarenessStore({ workspace: repoB, dbPath });
  });

  afterEach(async () => {
    a.close();
    b.close();
    await rm(root, { recursive: true, force: true });
  });

  it('scopes plans, memories, and handoffs to their own workspace', () => {
    a.createPlan({ title: 'plan-a' });
    b.createPlan({ title: 'plan-b' });
    a.storeMemory({ label: 'L', text: 'mem-a' });
    a.addHandoff({ agentId: 'x', summary: 'handoff-a' });

    expect(a.listPlans().map((p) => p.title)).toEqual(['plan-a']);
    expect(b.listPlans().map((p) => p.title)).toEqual(['plan-b']);
    expect(a.recallMemory({}).map((m) => m.text)).toEqual(['mem-a']);
    expect(b.recallMemory({})).toHaveLength(0);
    expect(b.listHandoffs()).toHaveLength(0);
    expect(a.status().plans).toBe(1);
    expect(b.status().plans).toBe(1);
  });

  it('keeps the same relative file lock independent across workspaces', () => {
    a.acquireLock({ filePath: 'src/app.ts', agentId: 'agent-a' });
    // Same relative path, different repo → no conflict (absolute paths differ,
    // and rows are workspace-scoped).
    expect(() => b.acquireLock({ filePath: 'src/app.ts', agentId: 'agent-b' })).not.toThrow();
    expect(a.listLocks()).toHaveLength(1);
    expect(b.listLocks()).toHaveLength(1);
    expect(a.listLocks()[0]?.agentId).toBe('agent-a');
    expect(b.listLocks()[0]?.agentId).toBe('agent-b');
  });

  it('lets the same agent id exist in two workspaces (composite key)', () => {
    a.joinAgent({ agentId: 'shared-id', name: 'in-a' });
    b.joinAgent({ agentId: 'shared-id', name: 'in-b' });
    expect(a.listAgents().map((ag) => ag.name)).toEqual(['in-a']);
    expect(b.listAgents().map((ag) => ag.name)).toEqual(['in-b']);
  });

  it('does not resolve another workspace task by id', () => {
    const plan = a.createPlan({ title: 'p' });
    const task = a.addTask({ planId: plan.planId, title: 't' });
    expect(a.getTask(task.taskId).title).toBe('t');
    expect(() => b.getTask(task.taskId)).toThrow(/task not found/);
  });
});
