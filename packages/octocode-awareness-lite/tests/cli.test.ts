import { mkdtemp, rm } from 'node:fs/promises';
import { openAwarenessLite } from '../src/index.js';
import { extractHookTargetPaths, runPreEditLockGate } from '../src/hooks.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';

let workspace: string;
let stdout: string;
let stderr: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-lite-cli-'));
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
  await rm(workspace, { recursive: true, force: true });
});

function jsonOut<T>(): T {
  return JSON.parse(stdout) as T;
}

describe('runCli', () => {
  it('prints help', () => {
    expect(runCli(['help'])).toBe(0);
    expect(stdout).toContain('plan create|list|done');
    expect(stdout).toContain('work start|list|end');
    expect(stdout).toContain('handoff add|list|clear');
    expect(stdout).toContain('agent join|touch|leave|list');
    expect(stdout).toContain('message send|inbox|list|read');
    expect(stdout).toContain('memory store|recall|list|forget|delete');
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
    expect(runCli(['memory', 'forget', '--workspace', workspace, '--memory-id', memory.memoryId])).toBe(0);
    expect(jsonOut<{ forgotten: boolean }>().forgotten).toBe(true);
  });

  it('extracts hook write targets from common host payloads', () => {
    expect(extractHookTargetPaths({ toolName: 'Write', input: { path: 'src/a.ts' } })).toEqual(['src/a.ts']);
    expect(extractHookTargetPaths({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/b.ts\n*** Move to: src/c.ts\n*** End Patch' } })).toEqual(['src/b.ts', 'src/c.ts']);
    expect(extractHookTargetPaths({ toolName: 'localSearchCode', input: { path: 'src/not-write.ts' } })).toEqual([]);
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
      const result = jsonOut<{ host: string; settingsPath: string; resultingSettings: { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } } }>();
      expect(result.host).toBe(host);
      expect(result.settingsPath).toContain(host === 'claude' ? '.claude/settings.json' : `.${host}/hooks.json`);
      expect(result.resultingSettings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(' hooks pre-edit ');
    }
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

    stdout = '';
    expect(runCli(['check', 'audit', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ ok: boolean; pendingCount: number }>().pendingCount).toBe(1);

    stdout = '';
    expect(runCli(['task', 'reopen', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a', '--reason', 'failed once'])).toBe(0);
    expect(jsonOut<{ status: string; doneAt: string | null; verificationMessage: string }>() ).toMatchObject({ status: 'CLAIMED', doneAt: null, verificationMessage: 'failed once' });

    stdout = '';
    expect(runCli(['task', 'done', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a'])).toBe(0);

    stdout = '';
    expect(runCli(['verify', 'mark', '--workspace', workspace, '--task-id', task.taskId, '--agent-id', 'agent-a', '--message', 'cli test passed'])).toBe(0);
    expect(jsonOut<{ verificationMessage: string }>().verificationMessage).toBe('cli test passed');

    stdout = '';
    expect(runCli(['check', 'audit', '--workspace', workspace])).toBe(0);
    expect(jsonOut<{ ok: boolean; pendingCount: number }>()).toMatchObject({ ok: true, pendingCount: 0 });

    stdout = '';
    expect(runCli(['plan', 'done', '--workspace', workspace, '--plan-id', plan.planId])).toBe(0);
    expect(jsonOut<{ status: string }>().status).toBe('DONE');
  });
});
