import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/lite/cli.js';
import { openAwarenessLite } from '../../src/lite/index.js';

let workspace: string;
let stdout: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-lite-cli-'));
  process.env.OCTOCODE_DB_PATH = join(workspace, 'octocode.sqlite3');
  stdout = '';
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.OCTOCODE_DB_PATH;
  await rm(workspace, { recursive: true, force: true });
});

function jsonOut<T>(): T {
  return JSON.parse(stdout) as T;
}

describe('plan CLI (Phase 1)', () => {
  it('shares one coordination store with in-process hosts', () => {
    expect(runCli(['plan', 'create', '--workspace', workspace, '--title', 'Cross-host plan'])).toBe(0);
    const plan = jsonOut<{ planId: string }>();

    const aw = openAwarenessLite({ workspace });
    try {
      expect(aw.getPlan(plan.planId).title).toBe('Cross-host plan');
      aw.sendMessage({ fromAgentId: 'pi-agent', toAgentId: 'external-agent', text: 'shared inbox' });
      aw.storeMemory({ label: 'DECISION', text: 'Use the shared coordination runtime', tags: ['shared'] });
    } finally {
      aw.close();
    }

    stdout = '';
    expect(runCli(['message', 'inbox', '--workspace', workspace, '--agent-id', 'external-agent'])).toBe(0);
    expect(jsonOut<Array<{ text: string }>>()).toMatchObject([{ text: 'shared inbox' }]);

    stdout = '';
    expect(runCli(['memory', 'recall', '--workspace', workspace, '--query', 'coordination runtime'])).toBe(0);
    expect(jsonOut<Array<{ text: string }>>()).toMatchObject([{ text: 'Use the shared coordination runtime' }]);
  });

  it('creates, lists, shows, marks done, and abandons a plan via CLI', () => {
    // Create
    expect(runCli(['plan', 'create', '--workspace', workspace, '--title', 'My Plan', '--goal', 'ship it'])).toBe(0);
    const plan = jsonOut<{ planId: string; title: string; goal: string; status: string; sourceKind: null; sourceKey: null }>();
    expect(plan.title).toBe('My Plan');
    expect(plan.goal).toBe('ship it');
    expect(plan.status).toBe('OPEN');
    expect(plan.sourceKind).toBeNull();

    // List
    stdout = '';
    expect(runCli(['plan', 'list', '--workspace', workspace])).toBe(0);
    expect(jsonOut<Array<{ planId: string }>>()).toHaveLength(1);

    // Show
    stdout = '';
    expect(runCli(['plan', 'show', '--workspace', workspace, '--plan-id', plan.planId])).toBe(0);
    expect(jsonOut<{ planId: string; status: string }>()).toMatchObject({ planId: plan.planId, status: 'OPEN' });

    // Done (after adding + verifying all tasks)
    stdout = '';
    expect(runCli(['task', 'add', '--workspace', workspace, '--plan-id', plan.planId, '--title', 'Do work', '--check', 'yarn test'])).toBe(0);
    const task = jsonOut<{ taskId: string }>();
    stdout = '';
    expect(runCli(['task', 'done', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a'])).toBe(0);
    stdout = '';
    expect(runCli(['check', 'mark', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a', '--message', 'passed'])).toBe(0);
    stdout = '';
    expect(runCli(['plan', 'done', '--workspace', workspace, '--plan-id', plan.planId])).toBe(0);
    expect(jsonOut<{ status: string }>().status).toBe('DONE');
  });

  it('abandons a plan and cancels unfinished tasks via plan CLI', () => {
    // Create plan and tasks
    expect(runCli(['plan', 'create', '--workspace', workspace, '--title', 'Abandon Plan'])).toBe(0);
    const plan = jsonOut<{ planId: string }>();
    stdout = '';
    expect(runCli(['task', 'add', '--workspace', workspace, '--plan-id', plan.planId, '--title', 'Task 1'])).toBe(0);
    const task1 = jsonOut<{ taskId: string }>();
    stdout = '';
    expect(runCli(['task', 'add', '--workspace', workspace, '--plan-id', plan.planId, '--title', 'Task 2'])).toBe(0);
    const task2 = jsonOut<{ taskId: string }>();

    // Abandon
    stdout = '';
    expect(runCli(['plan', 'abandon', '--workspace', workspace, '--plan-id', plan.planId, '--agent-id', 'agent-a', '--reason', 'no longer needed'])).toBe(0);
    const result = jsonOut<{ plan: { status: string }; cancelled: number }>();
    expect(result.plan.status).toBe('ABANDONED');
    expect(result.cancelled).toBe(2);

    // Verify CANCELLED status via task list
    stdout = '';
    expect(runCli(['task', 'list', '--workspace', workspace, '--plan-id', plan.planId, '--status', 'CANCELLED'])).toBe(0);
    const cancelled = jsonOut<Array<{ taskId: string }>>();
    expect(cancelled.map((t) => t.taskId)).toEqual(expect.arrayContaining([task1.taskId, task2.taskId]));
  });

  it('shows schema includes plan commands', () => {
    expect(runCli(['schema', '--workspace', workspace])).toBe(0);
    const schema = jsonOut<{ commands: Record<string, string[]> }>();
    expect(schema.commands.plan).toContain('show --plan-id');
    expect(schema.commands.plan).toContain('abandon --plan-id --agent-id [--reason]');
  });
});
