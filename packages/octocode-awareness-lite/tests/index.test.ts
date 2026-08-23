import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAwarenessLite, type AwarenessLite } from '../src/index.js';

let workspace: string;
let aw: AwarenessLite;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'aw-lite-'));
  aw = openAwarenessLite({ workspace });
});

afterEach(async () => {
  aw.close();
  await rm(workspace, { recursive: true, force: true });
});

describe('AwarenessLite', () => {
  it('creates a local sqlite database and reports status', () => {
    const status = aw.status();

    expect(status.workspace).toBe(workspace);
    expect(status.dbPath).toBe(join(workspace, '.octocode-lite', 'awareness-lite.sqlite3'));
    expect(status).toMatchObject({
      plans: 0,
      activePlans: 0,
      tasks: 0,
      readyTasks: 0,
      inProgressTasks: 0,
      pendingChecks: 0,
      verifyTasks: 0,
      locks: 0,
      work: 0,
      memories: 0,
      handoffs: 0,
      agents: 0,
      messages: 0,
    });
  });

  it('creates plans and tasks, then claims and completes a task', () => {
    const plan = aw.createPlan({ title: 'ship lite', goal: 'plans tasks locks only' });
    const task = aw.addTask({ planId: plan.planId, title: 'add sqlite', filePath: 'src/index.ts', checkCommand: 'yarn test' });

    expect(aw.listPlans()).toHaveLength(1);
    expect(aw.listTasks({ planId: plan.planId })).toHaveLength(1);
    expect(aw.listTasks({ status: 'OPEN' })).toHaveLength(1);
    expect(task).toMatchObject({ status: 'OPEN', agentId: null, filePath: 'src/index.ts', checkCommand: 'yarn test' });
    expect(aw.status()).toMatchObject({ activePlans: 1, tasks: 1, readyTasks: 1, inProgressTasks: 0, pendingChecks: 0, verifyTasks: 0 });

    const claimed = aw.claimTask({ taskId: task.taskId, agentId: 'agent-a' });
    expect(claimed).toMatchObject({ status: 'CLAIMED', agentId: 'agent-a' });
    expect(aw.status()).toMatchObject({ activePlans: 1, tasks: 1, readyTasks: 0, inProgressTasks: 1, pendingChecks: 0, verifyTasks: 0 });

    const done = aw.doneTask({ taskId: task.taskId, agentId: 'agent-a' });
    expect(done.status).toBe('DONE');
    expect(done.doneAt).toBeTruthy();
    expect(aw.status()).toMatchObject({ activePlans: 1, tasks: 1, readyTasks: 0, inProgressTasks: 0, pendingChecks: 1, verifyTasks: 1 });
  });

  it('audits checks, reopens failed tasks, and completes verified plans', () => {
    const plan = aw.createPlan({ title: 'ship lite' });
    const task = aw.addTask({ planId: plan.planId, title: 'add checks', checkCommand: 'yarn test' });
    expect(() => aw.donePlan({ planId: plan.planId })).toThrow('plan has unfinished tasks');

    aw.doneTask({ taskId: task.taskId, agentId: 'agent-a' });
    expect(() => aw.donePlan({ planId: plan.planId })).toThrow('plan has unverified tasks');

    const audit = aw.auditChecks();
    expect(audit).toMatchObject({ ok: false, pendingCount: 1 });
    expect(audit.pending[0]).toMatchObject({ taskId: task.taskId, checkCommand: 'yarn test' });

    const reopened = aw.reopenTask({ taskId: task.taskId, agentId: 'agent-a', reason: 'lint failed' });
    expect(reopened).toMatchObject({ status: 'CLAIMED', doneAt: null, verifiedAt: null, verifiedBy: null, verificationMessage: 'lint failed' });
    expect(aw.auditChecks()).toMatchObject({ ok: true, pendingCount: 0 });

    aw.doneTask({ taskId: task.taskId, agentId: 'agent-a' });
    expect(aw.auditChecks({ agentId: 'agent-a', planId: plan.planId, minAgeMs: 0 })).toMatchObject({ ok: false, pendingCount: 1 });
    const verified = aw.markCheck({ taskId: task.taskId, agentId: 'agent-a', message: 'yarn test passed', status: 'SUCCESS' });
    expect(verified.verifiedBy).toBe('agent-a');
    expect(verified.verificationMessage).toBe('yarn test passed');
    expect(aw.auditChecks()).toMatchObject({ ok: true, pendingCount: 0 });

    const failedTask = aw.addTask({ planId: plan.planId, title: 'fails later' });
    aw.doneTask({ taskId: failedTask.taskId, agentId: 'agent-a' });
    const failed = aw.markCheck({ taskId: failedTask.taskId, agentId: 'agent-a', message: 'integration failed', status: 'FAILED' });
    expect(failed).toMatchObject({ status: 'CLAIMED', verifiedAt: null, verificationMessage: 'integration failed' });
    aw.doneTask({ taskId: failedTask.taskId, agentId: 'agent-a' });
    aw.markCheck({ taskId: failedTask.taskId, agentId: 'agent-a', message: 'integration passed' });

    expect(aw.donePlan({ planId: plan.planId }).status).toBe('DONE');
  });

  it('stores, recalls, and describes local memory', () => {
    const memory = aw.storeMemory({ label: 'GOTCHA', text: 'Use node:sqlite on Node 22.13+', tags: 'sqlite,node' });

    expect(memory.memoryId).toMatch(/^mem_/);
    expect(memory.tags).toEqual(['sqlite', 'node']);
    expect(aw.recallMemory({ query: 'sqlite' })).toHaveLength(1);
    expect(aw.recallMemory({ label: 'GOTCHA' })[0]?.text).toContain('node:sqlite');
    expect(aw.status().memories).toBe(1);
    expect(aw.forgetMemory({ memoryId: memory.memoryId })).toEqual({ forgotten: true });
    expect(aw.forgetMemory({ memoryId: memory.memoryId })).toEqual({ forgotten: false });
    expect(aw.recallMemory({ query: 'sqlite' })).toHaveLength(0);
    expect(aw.status().memories).toBe(0);
    expect(aw.schema().entities.memory).toContain('memoryId');
    expect(aw.schema().entities.work).toContain('filePath');
    expect(aw.schema().entities.handoff).toContain('handoffId');
    expect(aw.schema().entities.agent).toContain('agentId');
    expect(aw.schema().entities.message).toContain('messageId');
    expect(aw.schema().commands.memory).toContain('forget --memory-id');
    expect(aw.schema().commands.memory).toContain('prune --older-than [--label] [--confirm]');
    expect(aw.schema().commands.work).toContain('start --file --agent-id [--reason] [--ttl]');
    expect(aw.schema().commands.work).toContain('touch --file --agent-id [--reason] [--ttl]');
    expect(aw.schema().commands.handoff).toContain('add --agent-id --summary [--file]');
    expect(aw.schema().commands.agent).toContain('join --agent-id [--name] [--role] [--meta]');
    expect(aw.schema().commands.agent).toContain('list [--include-left] [--stale-after]');
    expect(aw.schema().commands.message).toContain('send --from --text [--to] [--topic] [--file]');
    expect(aw.schema().commands.message).toContain('prune --older-than [--read-only] [--confirm]');
    expect(aw.schema().commands.plan).toContain('done --plan-id [--force]');
    expect(aw.schema().commands.task).toContain('ready [--plan-id] [--limit]');
    expect(aw.schema().commands.task).toContain('heartbeat --task-id --agent-id [--lease]');
    expect(aw.schema().commands.lock).toContain('wait --file [--agent-id] [--wait] [--retry-interval]');
    expect(aw.schema().commands.work).toContain('show --file');
    expect(aw.schema().commands.check).toContain('mark --task-id --agent-id --message [--status SUCCESS|FAILED]');
    expect(aw.schemaCommand('task')).toMatchObject({ command: 'task' });
    expect(aw.schemaCommand('list')).toContain('task');
  });

  it('prevents another agent from stealing claimed tasks', () => {
    const plan = aw.createPlan({ title: 'ship lite' });
    const task = aw.addTask({ planId: plan.planId, title: 'add tasks' });
    aw.claimTask({ taskId: task.taskId, agentId: 'agent-a' });

    expect(() => aw.claimTask({ taskId: task.taskId, agentId: 'agent-b' })).toThrow('belongs to agent-a');
  });

  it('tracks task metadata, dependency readiness, leases, heartbeat, and release', () => {
    const plan = aw.createPlan({ title: 'dependency plan' });
    const dependency = aw.addTask({ planId: plan.planId, title: 'first', priority: 1 });
    const blocked = aw.addTask({
      planId: plan.planId,
      title: 'second',
      paths: 'src/index.ts,README.md',
      reasoning: 'needs first task',
      acceptance: 'second task is safe to claim',
      dependsOn: dependency.taskId,
      priority: 5,
    });

    expect(blocked).toMatchObject({
      filePath: 'src/index.ts',
      paths: ['src/index.ts', 'README.md'],
      reasoning: 'needs first task',
      acceptance: 'second task is safe to claim',
      priority: 5,
      dependencies: [dependency.taskId],
    });
    expect(aw.listReadyTasks({ planId: plan.planId }).map((task) => task.taskId)).toEqual([dependency.taskId]);
    expect(() => aw.claimTask({ taskId: blocked.taskId, agentId: 'agent-a' })).toThrow(`blocked by ${dependency.taskId}`);

    aw.doneTask({ taskId: dependency.taskId, agentId: 'agent-a' });
    aw.markCheck({ taskId: dependency.taskId, agentId: 'agent-a', message: 'unit passed' });
    expect(aw.listReadyTasks({ planId: plan.planId }).map((task) => task.taskId)).toEqual([blocked.taskId]);

    const claimed = aw.claimTask({ taskId: blocked.taskId, agentId: 'agent-b', leaseSeconds: 60 });
    expect(claimed).toMatchObject({ status: 'CLAIMED', agentId: 'agent-b' });
    expect(claimed.claimedAt).toBeTruthy();
    expect(claimed.leaseExpiresAt).toBeTruthy();
    const heartbeat = aw.heartbeatTask({ taskId: blocked.taskId, agentId: 'agent-b', leaseSeconds: 120 });
    expect(Date.parse(heartbeat.leaseExpiresAt!)).toBeGreaterThanOrEqual(Date.parse(claimed.leaseExpiresAt!));

    const released = aw.releaseTask({ taskId: blocked.taskId, agentId: 'agent-b', blockedReason: 'waiting on reviewer' });
    expect(released).toMatchObject({ status: 'OPEN', agentId: null, claimedAt: null, leaseExpiresAt: null, verificationMessage: 'waiting on reviewer' });
  });

  it('evicts expired task claim leases when listing tasks', () => {
    const plan = aw.createPlan({ title: 'lease plan' });
    const task = aw.addTask({ planId: plan.planId, title: 'lease task' });
    aw.claimTask({ taskId: task.taskId, agentId: 'agent-a', leaseSeconds: 60 });

    const db = new DatabaseSync(aw.dbPath);
    try {
      const expired = new Date(Date.now() - 1000).toISOString();
      db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?').run(expired, task.taskId);
    } finally {
      db.close();
    }

    expect(aw.listTasks({ planId: plan.planId })[0]).toMatchObject({ status: 'OPEN', agentId: null, leaseExpiresAt: null, verificationMessage: 'claim lease expired' });
  });

  it('acquires, refreshes, conflicts, and releases locks', async () => {
    await mkdir(join(workspace, 'src'));
    const lock = aw.acquireLock({ filePath: 'src/index.ts', agentId: 'agent-a', reason: 'edit', ttlSeconds: 60 });

    expect(lock.filePath).toBe(join(workspace, 'src/index.ts'));
    expect(aw.listLocks()).toHaveLength(1);
    expect(aw.acquireLock({ filePath: 'src/index.ts', agentId: 'agent-a', reason: 'refresh' }).reason).toBe('refresh');
    expect(aw.waitForLock({ filePath: 'src/index.ts', agentId: 'agent-a' })).toMatchObject({ ok: true, lockFree: true });
    expect(aw.waitForLock({ filePath: 'src/index.ts', agentId: 'agent-b', waitMs: 1, retryIntervalMs: 1 })).toMatchObject({ ok: false, lockFree: false, conflict: { agentId: 'agent-a' } });
    expect(() => aw.acquireLock({ filePath: 'src/index.ts', agentId: 'agent-b' })).toThrow('lock conflict');
    expect(aw.releaseLock({ filePath: 'src/index.ts', agentId: 'agent-a' })).toEqual({ released: true });
    expect(aw.waitForLock({ filePath: 'src/index.ts', agentId: 'agent-b' })).toMatchObject({ ok: true, lockFree: true });
    expect(aw.listLocks()).toHaveLength(0);
  });

  it('tracks manual advisory work presence', () => {
    const work = aw.startWork({ filePath: 'src/index.ts', agentId: 'agent-a', reason: 'editing lite', ttlSeconds: 60 });

    expect(work).toMatchObject({ filePath: join(workspace, 'src/index.ts'), agentId: 'agent-a', reason: 'editing lite' });
    expect(aw.status().work).toBe(1);
    expect(aw.listWork()).toHaveLength(1);
    expect(aw.listWork({ agentId: 'agent-a' })).toHaveLength(1);
    expect(aw.showWork({ filePath: 'src/index.ts' })).toHaveLength(1);
    expect(aw.startWork({ filePath: 'src/index.ts', agentId: 'agent-a', reason: 'refresh' }).reason).toBe('refresh');
    expect(aw.endWork({ filePath: 'src/index.ts', agentId: 'agent-a' })).toEqual({ ended: true });
    expect(aw.endWork({ filePath: 'src/index.ts', agentId: 'agent-a' })).toEqual({ ended: false });
    expect(aw.status().work).toBe(0);
  });

  it('stores and clears manual handoff notes', () => {
    const handoff = aw.addHandoff({ agentId: 'agent-a', summary: 'finish docs after tests', files: 'README.md,src/index.ts' });

    expect(handoff.handoffId).toMatch(/^handoff_/);
    expect(handoff.files).toEqual(['README.md', 'src/index.ts']);
    expect(aw.status().handoffs).toBe(1);
    expect(aw.listHandoffs()[0]).toMatchObject({ handoffId: handoff.handoffId, clearedAt: null });
    expect(aw.clearHandoff({ handoffId: handoff.handoffId })).toEqual({ cleared: true });
    expect(aw.clearHandoff({ handoffId: handoff.handoffId })).toEqual({ cleared: false });
    expect(aw.listHandoffs()).toHaveLength(0);
    expect(aw.listHandoffs({ includeCleared: true })[0]?.clearedAt).toBeTruthy();
    expect(aw.status().handoffs).toBe(0);
  });

  it('tracks agents and routes repository messages through the shared database', () => {
    const agentA = aw.joinAgent({ agentId: 'agent-a', name: 'Alice', role: 'implementer', metadata: { model: 'fast' } });
    const agentB = aw.joinAgent({ agentId: 'agent-b', name: 'Bob', role: 'reviewer' });

    expect(agentA).toMatchObject({ agentId: 'agent-a', name: 'Alice', status: 'ACTIVE', metadata: { model: 'fast' } });
    expect(aw.joinAgent({ agentId: 'agent-a', name: 'Alice 2' })).toMatchObject({ name: 'Alice 2', metadata: { model: 'fast' } });
    expect(agentB.role).toBe('reviewer');
    expect(aw.listAgents()).toHaveLength(2);

    const direct = aw.sendMessage({ fromAgentId: 'agent-a', toAgentId: 'agent-b', topic: 'review', text: 'please check locks', files: 'src/index.ts,README.md' });
    const broadcast = aw.sendMessage({ fromAgentId: 'agent-b', topic: 'heads-up', text: 'tests are running' });

    expect(direct.messageId).toMatch(/^msg_/);
    expect(direct.files).toEqual(['src/index.ts', 'README.md']);
    expect(aw.status()).toMatchObject({ agents: 2, messages: 2 });

    const inboxB = aw.listMessages({ agentId: 'agent-b' });
    expect(inboxB.map((message) => message.messageId)).toEqual([direct.messageId]);
    expect(aw.listMessages({ agentId: 'agent-a' }).map((message) => message.messageId)).toEqual([broadcast.messageId]);
    expect(aw.listMessages().map((message) => message.messageId)).toContain(broadcast.messageId);

    const read = aw.markMessageRead({ messageId: direct.messageId, agentId: 'agent-b' });
    expect(read.readAt).toBeTruthy();
    expect(aw.listMessages({ agentId: 'agent-b' })).toHaveLength(0);
    expect(aw.listMessages({ agentId: 'agent-b', includeRead: true })).toHaveLength(1);

    expect(aw.leaveAgent({ agentId: 'agent-b' }).status).toBe('LEFT');
    expect(aw.listAgents().map((agent) => agent.agentId)).toEqual(['agent-a']);
    expect(aw.listAgents({ includeLeft: true }).map((agent) => agent.agentId)).toContain('agent-b');
  });

  it('prunes expired locks and work before listing', () => {
    aw.acquireLock({ filePath: 'README.md', agentId: 'agent-a', ttlSeconds: 60 });
    aw.startWork({ filePath: 'README.md', agentId: 'agent-a', ttlSeconds: 60 });
    expect(aw.listLocks()).toHaveLength(1);
    expect(aw.listWork()).toHaveLength(1);

    const db = new DatabaseSync(aw.dbPath);
    try {
      const expired = new Date(Date.now() - 1000).toISOString();
      db.prepare('UPDATE locks SET expires_at = ?').run(expired);
      db.prepare('UPDATE work_presence SET expires_at = ?').run(expired);
    } finally {
      db.close();
    }

    expect(aw.pruneLocks({ dryRun: true })).toMatchObject({ dryRun: true, matched: 1, deleted: 0 });
    expect(aw.pruneLocks({ dryRun: false })).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });
    expect(aw.listLocks()).toHaveLength(0);
    expect(aw.listWork()).toHaveLength(0);
  });

  it('migrates older task tables by adding verification columns', async () => {
    aw.close();

    const legacyDb = new DatabaseSync(join(workspace, '.octocode-lite', 'awareness-lite.sqlite3'));
    try {
      legacyDb.exec(`
        DROP TABLE tasks;
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          file_path TEXT,
          status TEXT NOT NULL CHECK(status IN ('OPEN', 'CLAIMED', 'DONE')),
          agent_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          done_at TEXT
        );
      `);
    } finally {
      legacyDb.close();
    }

    aw = openAwarenessLite({ workspace });
    const columns = new DatabaseSync(aw.dbPath);
    try {
      const names = columns.prepare('PRAGMA table_info(tasks)').all().map((row) => (row as { name: string }).name);
      expect(names).toEqual(expect.arrayContaining(['paths_json', 'reasoning', 'acceptance', 'check_command', 'priority', 'dependencies_json', 'claimed_at', 'lease_expires_at', 'verified_at', 'verified_by', 'verification_message']));
    } finally {
      columns.close();
    }
  });

  it('reports stale active agents without a daemon heartbeat', () => {
    aw.joinAgent({ agentId: 'fresh-agent' });
    aw.joinAgent({ agentId: 'stale-agent' });
    aw.leaveAgent({ agentId: 'left-agent' });

    const db = new DatabaseSync(aw.dbPath);
    try {
      const stale = new Date(Date.now() - 60_000).toISOString();
      db.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').run(stale, 'stale-agent');
      db.prepare('UPDATE agents SET last_seen_at = ? WHERE agent_id = ?').run(stale, 'left-agent');
    } finally {
      db.close();
    }

    expect(aw.listAgents({ staleAfterMs: 30_000 }).map((agent) => agent.agentId)).toEqual(['stale-agent']);
    expect(aw.status({ staleAfterMs: 30_000 }).staleAgents).toBe(1);
    // status().agents counts PRESENT agents (non-LEFT, seen within the window),
    // not a raw table count: with a 30s window only fresh-agent is present.
    expect(aw.status({ staleAfterMs: 30_000 }).agents).toBe(1);
    // With the default (30 min) window, the 60s-old stale-agent still counts as
    // present, but the LEFT agent never does.
    expect(aw.status().agents).toBe(2);
  });

  it('dry-runs and confirms manual memory and message pruning', () => {
    const oldMemory = aw.storeMemory({ label: 'GOTCHA', text: 'old memory' });
    aw.storeMemory({ label: 'DECISION', text: 'new memory' });
    aw.joinAgent({ agentId: 'agent-a' });
    aw.joinAgent({ agentId: 'agent-b' });
    const oldMessage = aw.sendMessage({ fromAgentId: 'agent-a', toAgentId: 'agent-b', text: 'old message' });
    aw.sendMessage({ fromAgentId: 'agent-a', toAgentId: 'agent-b', text: 'new message' });
    aw.markMessageRead({ messageId: oldMessage.messageId, agentId: 'agent-b' });

    const db = new DatabaseSync(aw.dbPath);
    try {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE memories SET created_at = ? WHERE memory_id = ?').run(old, oldMemory.memoryId);
      db.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?').run(old, oldMessage.messageId);
    } finally {
      db.close();
    }

    expect(aw.pruneMemories({ olderThanMs: 24 * 60 * 60 * 1000, label: 'GOTCHA', dryRun: true })).toMatchObject({ dryRun: true, matched: 1, deleted: 0 });
    expect(aw.status().memories).toBe(2);
    expect(aw.pruneMemories({ olderThanMs: 24 * 60 * 60 * 1000, label: 'GOTCHA', dryRun: false })).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });
    expect(aw.recallMemory({ limit: 10 }).map((memory) => memory.text)).toEqual(['new memory']);

    expect(aw.pruneMessages({ olderThanMs: 24 * 60 * 60 * 1000, readOnly: true, dryRun: true })).toMatchObject({ dryRun: true, matched: 1, deleted: 0 });
    expect(aw.status().messages).toBe(2);
    expect(aw.pruneMessages({ olderThanMs: 24 * 60 * 60 * 1000, readOnly: true, dryRun: false })).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });
    expect(aw.listMessages({ agentId: 'agent-b', includeRead: true }).map((message) => message.text)).toEqual(['new message']);
  });

  it('handles repeated lock contention, inbox reads, relative path aliases, and reopen loops', () => {
    aw.acquireLock({ filePath: './src/../README.md', agentId: 'agent-0' });
    for (let index = 1; index <= 20; index += 1) {
      expect(() => aw.acquireLock({ filePath: 'README.md', agentId: `agent-${index}` })).toThrow('lock conflict');
    }
    expect(aw.releaseLock({ filePath: 'README.md', agentId: 'agent-0' })).toEqual({ released: true });

    aw.joinAgent({ agentId: 'agent-a' });
    aw.joinAgent({ agentId: 'agent-b' });
    for (let index = 0; index < 25; index += 1) {
      aw.sendMessage({ fromAgentId: 'agent-a', toAgentId: 'agent-b', topic: 'stress', text: `message ${index}` });
    }
    expect(aw.listMessages({ agentId: 'agent-b', topic: 'stress', limit: 100 })).toHaveLength(25);

    const plan = aw.createPlan({ title: 'stress plan' });
    const task = aw.addTask({ planId: plan.planId, title: 'stress task' });
    for (let index = 0; index < 5; index += 1) {
      aw.claimTask({ taskId: task.taskId, agentId: 'agent-a' });
      aw.doneTask({ taskId: task.taskId, agentId: 'agent-a' });
      aw.reopenTask({ taskId: task.taskId, agentId: 'agent-a', reason: `loop ${index}` });
    }
    expect(aw.listTasks({ planId: plan.planId })[0]).toMatchObject({ status: 'CLAIMED', verificationMessage: 'loop 4' });
  });
});

describe('agent naming', () => {
  it('generates funny host-tagged names and detects hosts from env', async () => {
    const { detectAgentHost, generateAgentName } = await import('../src/index.js');
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
});
