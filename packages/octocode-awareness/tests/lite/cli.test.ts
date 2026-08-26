import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { openAwarenessLite } from '../../src/lite/index.js';
import { extractHookTargetPaths, runPreEditLockGate } from '../../src/lite/hooks.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCliEntrypoint, runCli } from '../../src/lite/cli.js';

let workspace: string;
let stdout: string;
let stderr: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-lite-cli-'));
  process.env.OCTOCODE_DB_PATH = join(workspace, 'octocode.sqlite3');
  stdout = '';
  stderr = '';
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
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

describe('isCliEntrypoint', () => {
  it('accepts symlinked bin paths used by npx and package-manager shims', async () => {
    const realCli = join(workspace, 'cli.js');
    const linkCli = join(workspace, 'octocode-awareness-lite');
    await import('node:fs/promises').then(fs => fs.writeFile(realCli, '#!/usr/bin/env node\n'));
    await symlink(realCli, linkCli);
    expect(isCliEntrypoint(pathToFileURL(realCli).href, linkCli)).toBe(true);
  });
});

describe('runCli', () => {
  it('prints help', () => {
    expect(runCli(['help'])).toBe(0);
    expect(stdout).toContain('plan create|list|show|done|abandon');
    expect(stdout).toContain('work start|touch|list|show|end');
    expect(stdout).toContain('handoff add|list|clear');
    expect(stdout).toContain('agent join|touch|leave|list');
    expect(stdout).toContain('message send|inbox|list|read');
    expect(stdout).toContain('memory store|recall|list|reindex|forget|prune');
    expect(stdout).toContain('hooks pre-edit');
    expect(stderr).toBe('');
  });

  it('supports global flags without an action', () => {
    expect(runCli(['status', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ workspace: string }>().workspace).toBe(workspace);
    expect(stderr).toBe('');
  });

  it('prints schema and runs local memory commands', () => {
    expect(runCli(['schema', '--workspace', workspace])).toBe(0);
    const schema = jsonOut<{ entities: { memory: string[]; work: string[]; handoff: string[]; agent: string[]; message: string[] }; commands: { agent: string[]; message: string[]; hooks: string[] } }>();
    expect(schema.entities.memory).toContain('memoryId');
    expect(schema.entities.work).toContain('filePath');
    expect(schema.entities.handoff).toContain('handoffId');
    expect(schema.entities.agent).toContain('agentId');
    expect(schema.entities.message).toContain('messageId');
    expect(schema.commands.agent).toContain('join --agent-id [--name] [--role] [--meta]');
    expect(schema.commands.message).toContain('send --from --text [--to] [--topic] [--file]');
    expect(schema.commands.hooks).toContain('pre-edit [--agent-id] [--host] < event.json');
    expect(schema.commands.hooks).toContain('install --host claude|codex|cursor [--project-dir] [--dry-run]');

    stdout = '';
    expect(runCli(['memory', 'store', '--workspace', workspace, '--label', 'DECISION', '--text', 'Keep lite local', '--tags', 'lite,local'])).toBe(0);
    expect(jsonOut<{ tags: string[] }>().tags).toEqual(['lite', 'local']);

    const memory = jsonOut<{ memoryId: string; tags: string[] }>();

    stdout = '';
    expect(runCli(['memory', 'recall', '--workspace', workspace, '--query', 'local'])).toBe(0);
    expect(jsonOut<Array<{ text: string }>>()[0]?.text).toBe('Keep lite local');

    stdout = '';
    expect(runCli(['status', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ memories: number }>().memories).toBe(1);

    stdout = '';
    expect(runCli(['memory', 'list', '--workspace', workspace, '--limit', '5'])).toBe(0);
    expect(jsonOut<Array<{ text: string }>>()).toMatchObject([{ text: 'Keep lite local' }]);

    stdout = '';
    expect(runCli(['memory', 'forget', '--workspace', workspace, '--memory-id', memory.memoryId])).toBe(0);
    expect(jsonOut<{ forgotten: boolean }>().forgotten).toBe(true);
  });

  it('extracts hook write targets from common host payloads', () => {
    expect(extractHookTargetPaths({ toolName: 'Write', input: { path: 'src/a.ts' } })).toEqual(['src/a.ts']);
    expect(extractHookTargetPaths({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/b.ts\n*** Move to: src/c.ts\n*** End Patch' } })).toEqual(['src/b.ts', 'src/c.ts']);
    expect(extractHookTargetPaths({ toolName: 'localSearchCode', input: { path: 'src/not-write.ts' } })).toEqual([]);
  });

  it('extracts hook write targets from arrays, query payloads, and nested tool names', () => {
    expect(extractHookTargetPaths({
      tool_input: { toolName: 'Edit', paths: ['src/a.ts', ['src/b.ts', '  ']], filePaths: ['src/c.ts'] },
    })).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);

    expect(extractHookTargetPaths({
      input: {
        queries: [
          { path: 'src/query-path.ts', filePath: 'src/query-file-path.ts' },
          { file_path: 'src/query-file-path-snake.ts', paths: ['src/query-paths.ts'], filePaths: ['src/query-filePaths.ts'], file_paths: ['src/query-file_paths.ts'] },
        ],
      },
    })).toEqual([
      'src/query-path.ts',
      'src/query-file-path.ts',
      'src/query-file-path-snake.ts',
      'src/query-paths.ts',
      'src/query-filePaths.ts',
      'src/query-file_paths.ts',
    ]);
  });

  it('blocks pre-edit hooks only when another agent owns a matching Lite lock', () => {
    const aw = openAwarenessLite({ workspace });
    try {
      aw.acquireLock({ filePath: 'README.md', agentId: 'agent-a' });
    } finally {
      aw.close();
    }

    const blocked = runPreEditLockGate({
      workspace,
      agentId: 'agent-b',
      host: 'claude',
      event: { toolName: 'Write', input: { path: 'README.md' } },
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.conflicts[0]?.lock.agentId).toBe('agent-a');

    const sameOwner = runPreEditLockGate({
      workspace,
      agentId: 'agent-a',
      host: 'claude',
      event: { toolName: 'Write', input: { path: 'README.md' } },
    });
    expect(sameOwner).toMatchObject({ ok: true, blocked: false, conflicts: [] });
  });

  it('dry-runs hooks install for Claude, Cursor, and Codex', () => {
    for (const host of ['claude', 'cursor', 'codex']) {
      stdout = '';
      expect(runCli(['hooks', 'install', '--workspace', workspace, '--host', host, '--project-dir', workspace, '--cli', '/tmp/octocode-awareness-lite.js', '--dry-run'])).toBe(0);
      const result = jsonOut<{ host: string; settingsPath: string; dryRun: boolean; resultingSettings: { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } } }>();
      expect(result.host).toBe(host);
      expect(result.dryRun).toBe(true);
      expect(result.settingsPath).toContain(host === 'claude' ? '.claude/settings.json' : `.${host}/hooks.json`);
      expect(result.resultingSettings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(' hooks pre-edit ');
    }
  });

  it('prints help for subcommands without running hook installation', () => {
    stdout = '';
    expect(runCli(['hooks', 'install', '--help', '--workspace', workspace])).toBe(0);
    expect(stdout).toContain('Hook install:');
    expect(stdout).toContain('--dry-run first');
    expect(existsSync(join(workspace, '.claude', 'settings.json'))).toBe(false);
  });

  it('runs hooks pre-edit as a JSON CLI gate', () => {
    expect(runCli(['lock', 'acquire', '--workspace', workspace, '--file', 'README.md', '--agent-id', 'agent-a'])).toBe(0);

    stdout = '';
    expect(runCli(['hooks', 'pre-edit', '--workspace', workspace, '--agent-id', 'agent-b', '--event-json', JSON.stringify({ toolName: 'Write', input: { path: 'README.md' } })])).toBe(2);
    expect(jsonOut<{ blocked: boolean; conflicts: Array<{ lock: { agentId: string } }> }>()).toMatchObject({
      blocked: true,
      conflicts: [{ lock: { agentId: 'agent-a' } }],
    });
  });

  it('runs stale-agent and prune commands as dry-run by default', () => {
    expect(runCli(['agent', 'join', '--workspace', workspace, '--agent-id', 'agent-a'])).toBe(0);
    stdout = '';
    expect(runCli(['agent', 'list', '--workspace', workspace, '--stale-after', '1d'])).toBe(0);
    expect(jsonOut<Array<{ agentId: string }>>()).toEqual([]);

    stdout = '';
    expect(runCli(['memory', 'store', '--workspace', workspace, '--label', 'GOTCHA', '--text', 'old memory'])).toBe(0);
    const memory = jsonOut<{ memoryId: string }>();
    stdout = '';
    expect(runCli(['message', 'send', '--workspace', workspace, '--from', 'agent-a', '--text', 'old message'])).toBe(0);
    const message = jsonOut<{ messageId: string }>();

    const aw = openAwarenessLite({ workspace });
    try {
      const db = new DatabaseSync(aw.dbPath);
      try {
        const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        db.prepare('UPDATE memories SET created_at = ? WHERE memory_id = ?').run(old, memory.memoryId);
        db.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?').run(old, message.messageId);
      } finally {
        db.close();
      }
    } finally {
      aw.close();
    }

    stdout = '';
    expect(runCli(['memory', 'prune', '--workspace', workspace, '--older-than', '1d', '--label', 'GOTCHA'])).toBe(0);
    expect(jsonOut<{ dryRun: boolean; matched: number; deleted: number }>()).toMatchObject({ dryRun: true, matched: 1, deleted: 0 });

    stdout = '';
    expect(runCli(['memory', 'prune', '--workspace', workspace, '--older-than', '1d', '--label', 'GOTCHA', '--confirm'])).toBe(0);
    expect(jsonOut<{ dryRun: boolean; matched: number; deleted: number }>()).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });

    stdout = '';
    expect(runCli(['message', 'prune', '--workspace', workspace, '--older-than', '1d'])).toBe(0);
    expect(jsonOut<{ dryRun: boolean; matched: number; deleted: number }>()).toMatchObject({ dryRun: true, matched: 1, deleted: 0 });

    stdout = '';
    expect(runCli(['message', 'prune', '--workspace', workspace, '--older-than', '1d', '--confirm'])).toBe(0);
    expect(jsonOut<{ dryRun: boolean; matched: number; deleted: number }>()).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });
  });

  it('runs the agent/message JSON flow', () => {
    expect(runCli(['agent', 'join', '--workspace', workspace, '--agent-id', 'agent-a', '--name', 'Alice', '--role', 'implementer', '--meta', '{"model":"fast"}'])).toBe(0);
    expect(jsonOut<{ agentId: string; metadata: { model: string } }>()).toMatchObject({ agentId: 'agent-a', metadata: { model: 'fast' } });

    stdout = '';
    expect(runCli(['agent', 'join', '--workspace', workspace, '--agent-id', 'agent-b', '--name', 'Bob'])).toBe(0);
    expect(jsonOut<{ name: string }>().name).toBe('Bob');

    stdout = '';
    expect(runCli(['message', 'send', '--workspace', workspace, '--from', 'agent-a', '--to', 'agent-b', '--topic', 'review', '--text', 'please review README', '--file', 'README.md,src/index.ts'])).toBe(0);
    const message = jsonOut<{ messageId: string; files: string[] }>();
    expect(message.messageId).toMatch(/^msg_/);
    expect(message.files).toEqual(['README.md', 'src/index.ts']);

    stdout = '';
    expect(runCli(['message', 'inbox', '--workspace', workspace, '--agent-id', 'agent-b'])).toBe(0);
    expect(jsonOut<Array<{ messageId: string; text: string }>>()).toMatchObject([{ messageId: message.messageId, text: 'please review README' }]);

    stdout = '';
    expect(runCli(['message', 'read', '--workspace', workspace, '--message-id', message.messageId, '--agent-id', 'agent-b'])).toBe(0);
    expect(jsonOut<{ readAt: string | null }>().readAt).toBeTruthy();

    stdout = '';
    expect(runCli(['message', 'inbox', '--workspace', workspace, '--agent-id', 'agent-b'])).toBe(0);
    expect(jsonOut<unknown[]>()).toHaveLength(0);

    stdout = '';
    expect(runCli(['agent', 'leave', '--workspace', workspace, '--agent-id', 'agent-b'])).toBe(0);
    expect(jsonOut<{ status: string }>().status).toBe('LEFT');
  });

  it('reports command errors through the CLI dispatcher', () => {
    expect(() => runCli(['plan', 'nope', '--workspace', workspace])).toThrow('plan action must be create, list, show, done, or abandon');
    expect(() => runCli(['task', 'nope', '--workspace', workspace])).toThrow('task action must be add, list, ready, show, depend, claim, heartbeat, release, done, or reopen');
    expect(() => runCli(['lock', 'nope', '--workspace', workspace])).toThrow('lock action must be acquire, wait, prune, release, or list');
    expect(() => runCli(['work', 'nope', '--workspace', workspace])).toThrow('work action must be start, touch, list, show, or end');
    expect(() => runCli(['handoff', 'nope', '--workspace', workspace])).toThrow('handoff action must be add, list, or clear');
    expect(() => runCli(['agent', 'nope', '--workspace', workspace])).toThrow('agent action must be join, touch, leave, or list');
    expect(() => runCli(['message', 'nope', '--workspace', workspace])).toThrow('message action must be send, inbox, list, read, or prune');
    expect(() => runCli(['check', 'nope', '--workspace', workspace])).toThrow('check action must be audit or mark');
    expect(() => runCli(['hooks', 'install', '--workspace', workspace, '--host', 'pi', '--dry-run'])).toThrow('hooks install --host must be claude, codex, or cursor');
    expect(() => runCli(['hooks', 'nope', '--workspace', workspace])).toThrow('hooks action must be install or pre-edit');
    expect(() => runCli(['memory', 'nope', '--workspace', workspace])).toThrow('memory action must be store, recall, list, reindex, forget, or prune');
    expect(() => runCli(['unknown', '--workspace', workspace])).toThrow('unknown command: unknown');
  });

  it('runs remaining list and touch aliases', () => {
    expect(runCli(['agent', 'touch', '--workspace', workspace, '--agent-id', 'agent-a', '--status', 'IDLE'])).toBe(0);
    expect(jsonOut<{ status: string }>().status).toBe('IDLE');

    stdout = '';
    expect(runCli(['message', 'send', '--workspace', workspace, '--from', 'agent-a', '--text', 'broadcast'])).toBe(0);

    stdout = '';
    expect(runCli(['message', 'list', '--workspace', workspace, '--agent-id', 'agent-b', '--include-read', '--limit', '5'])).toBe(0);
    expect(jsonOut<Array<{ text: string }>>()).toMatchObject([{ text: 'broadcast' }]);

    stdout = '';
    expect(runCli(['work', 'touch', '--workspace', workspace, '--file', 'README.md', '--agent-id', 'agent-a'])).toBe(0);
    expect(jsonOut<{ filePath: string }>().filePath).toContain('README.md');
  });

  it('runs the plan/task/lock JSON flow', () => {
    expect(runCli(['plan', 'create', '--workspace', workspace, '--title', 'ship lite'])).toBe(0);
    const plan = jsonOut<{ planId: string }>();

    stdout = '';
    expect(runCli(['task', 'add', '--workspace', workspace, '--plan-id', plan.planId, '--title', 'do it', '--file', 'README.md', '--check', 'yarn test'])).toBe(0);
    const task = jsonOut<{ taskId: string; status: string; checkCommand: string }>();
    expect(task.status).toBe('OPEN');
    expect(task.checkCommand).toBe('yarn test');

    stdout = '';
    expect(runCli(['task', 'claim', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a'])).toBe(0);
    expect(jsonOut<{ status: string }>().status).toBe('CLAIMED');

    stdout = '';
    expect(runCli(['lock', 'acquire', '--workspace', workspace, '--file', 'README.md', '--agent-id', 'agent-a'])).toBe(0);
    expect(jsonOut<{ agentId: string }>().agentId).toBe('agent-a');

    stdout = '';
    expect(runCli(['work', 'start', '--workspace', workspace, '--file', 'README.md', '--agent-id', 'agent-a', '--reason', 'editing docs'])).toBe(0);
    expect(jsonOut<{ agentId: string; reason: string }>() ).toMatchObject({ agentId: 'agent-a', reason: 'editing docs' });

    stdout = '';
    expect(runCli(['work', 'list', '--workspace', workspace])).toBe(0);
    expect(jsonOut<Array<{ filePath: string }>>()).toHaveLength(1);

    stdout = '';
    expect(runCli(['handoff', 'add', '--workspace', workspace, '--agent-id', 'agent-a', '--summary', 'finish docs', '--file', 'README.md,src/index.ts'])).toBe(0);
    const handoff = jsonOut<{ handoffId: string; files: string[] }>();
    expect(handoff.files).toEqual(['README.md', 'src/index.ts']);

    stdout = '';
    expect(runCli(['handoff', 'list', '--workspace', workspace])).toBe(0);
    expect(jsonOut<Array<{ summary: string }>>()[0]?.summary).toBe('finish docs');

    stdout = '';
    expect(runCli(['status', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ work: number; handoffs: number }>()).toMatchObject({ work: 1, handoffs: 1 });

    stdout = '';
    expect(runCli(['handoff', 'clear', '--workspace', workspace, '--handoff-id', handoff.handoffId])).toBe(0);
    expect(jsonOut<{ cleared: boolean }>().cleared).toBe(true);

    stdout = '';
    expect(runCli(['work', 'end', '--workspace', workspace, '--file', 'README.md', '--agent-id', 'agent-a'])).toBe(0);
    expect(jsonOut<{ ended: boolean }>().ended).toBe(true);

    stdout = '';
    expect(runCli(['task', 'done', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a'])).toBe(0);
    expect(jsonOut<{ next: { action: string; taskId: string } }>().next).toEqual({ action: 'check.mark', taskId: task.taskId });

    stdout = '';
    expect(runCli(['check', 'audit', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ ok: boolean; pendingCount: number }>().pendingCount).toBe(1);

    stdout = '';
    expect(runCli(['task', 'reopen', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a', '--reason', 'failed once'])).toBe(0);
    expect(jsonOut<{ status: string; doneAt: string | null; verificationMessage: string }>() ).toMatchObject({ status: 'CLAIMED', doneAt: null, verificationMessage: 'failed once' });

    stdout = '';
    expect(runCli(['task', 'done', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a'])).toBe(0);

    stdout = '';
    expect(runCli(['check', 'mark', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a', '--message', 'cli test passed'])).toBe(0);
    expect(jsonOut<{ verificationMessage: string; next: { action: string; planId: string } }>()).toMatchObject({
      verificationMessage: 'cli test passed',
      next: { action: 'plan.done', planId: plan.planId },
    });

    stdout = '';
    expect(runCli(['check', 'audit', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ ok: boolean; pendingCount: number }>()).toMatchObject({ ok: true, pendingCount: 0 });

    stdout = '';
    expect(runCli(['plan', 'done', '--workspace', workspace, '--plan-id', plan.planId])).toBe(0);
    expect(jsonOut<{ status: string }>().status).toBe('DONE');
  });

  it('reports active state without mutating expired rows', () => {
    expect(runCli(['plan', 'create', '--workspace', workspace, '--title', 'Read-only status'])).toBe(0);
    const plan = jsonOut<{ planId: string }>();
    stdout = '';
    expect(runCli(['task', 'add', '--workspace', workspace, '--plan-id', plan.planId, '--title', 'leased'])).toBe(0);
    const task = jsonOut<{ taskId: string }>();
    stdout = '';
    expect(runCli(['task', 'claim', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a'])).toBe(0);
    stdout = '';
    expect(runCli(['lock', 'acquire', '--workspace', workspace, '--file', 'expired.ts', '--agent-id', 'agent-a'])).toBe(0);
    stdout = '';
    expect(runCli(['work', 'start', '--workspace', workspace, '--file', 'expired.ts', '--agent-id', 'agent-a'])).toBe(0);

    const db = new DatabaseSync(process.env.OCTOCODE_DB_PATH!);
    try {
      const expired = new Date(Date.now() - 60_000).toISOString();
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?').run(expired, task.taskId);
      db.prepare('UPDATE locks SET expires_at = ? WHERE workspace_path = ?').run(expired, workspace);
      db.prepare('UPDATE work_presence SET expires_at = ? WHERE workspace_path = ?').run(expired, workspace);
    } finally {
      db.close();
    }

    stdout = '';
    expect(runCli(['status', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ inProgressTasks: number; locks: number; work: number }>()).toMatchObject({
      inProgressTasks: 0,
      locks: 0,
      work: 0,
    });

    const inspect = new DatabaseSync(process.env.OCTOCODE_DB_PATH!);
    try {
      expect(inspect.prepare('SELECT status FROM tasks WHERE task_id = ?').get(task.taskId)).toEqual({ status: 'CLAIMED' });
      expect((inspect.prepare('SELECT COUNT(*) AS count FROM locks WHERE workspace_path = ?').get(workspace) as { count: number }).count).toBe(1);
      expect((inspect.prepare('SELECT COUNT(*) AS count FROM work_presence WHERE workspace_path = ?').get(workspace) as { count: number }).count).toBe(1);
    } finally {
      inspect.close();
    }
  });
});

