/**
 * Single command dispatcher shared by the CLI and in-process hosts.
 * Callers own DB/I/O lifecycles; optional values remain `undefined` because
 * library methods can distinguish omission from explicit null.
 */

import type { AgentStatus,CheckStatus,TaskStatus } from '@octocodeai/octocode-shared/entities';
import type { AwarenessStore } from './index.js';
import type { MemoryEvaluationCorpusV1,MemoryRecallModeV1 } from '../memory-hardening.js';

export interface AwarenessCommandRequest {
  command: string;
  action?: string;
  params?: Record<string, unknown>;
}

export interface AwarenessCommandOutcome {
  /** The JSON value the CLI would print. */
  result: unknown;
  /** Process/branch exit code: 0 success, 2 for a still-held `lock wait`. */
  exitCode: number;
}

type Params = Record<string, unknown>;

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length ? s : undefined;
}

function reqStr(p: Params, key: string, ctx: string): string {
  const s = str(p[key]);
  if (!s) throw new Error(`${ctx} requires ${key}`);
  return s;
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function corpus(value: unknown): MemoryEvaluationCorpusV1 | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object') throw new Error('memory evaluate corpus-json must be a JSON object');
  return parsed as MemoryEvaluationCorpusV1;
}

/** Accept a string[], a comma string, or a single string; the library splits either. */
function list(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return str(value);
}

/**
 * Execute one structured Awareness command against an already-open library
 * instance. Throws `Error` on unknown command/action or a missing required
 * param (the CLI maps that to exit 1; hosts catch it as a tool error).
 */
export function dispatchAwarenessCommand(
  aw: AwarenessStore,
  req: AwarenessCommandRequest,
): AwarenessCommandOutcome {
  const p: Params = req.params ?? {};
  const action = req.action;
  const done = (result: unknown, exitCode = 0): AwarenessCommandOutcome => ({ result, exitCode });

  switch (req.command) {
    case 'status':
      return done(aw.status({ staleAfterMs: num(p['staleAfterMs']) }));

    case 'schema': {
      if (!action) return done(aw.schema());
      if (action === 'commands' || action === 'list') return done(aw.schemaCommand(action));
      if (action === 'command') return done(aw.schemaCommand(reqStr(p, 'name', 'schema command')));
      throw new Error('schema action must be commands, list, or command --name');
    }

    case 'plan': {
      switch (action) {
        case 'create':
          return done(aw.createPlan({ title: reqStr(p, 'title', 'plan create'), goal: str(p['goal']) }));
        case 'list':
          return done(aw.listPlans());
        case 'show':
          return done(aw.getPlan(reqStr(p, 'planId', 'plan show')));
        case 'done':
          return done(aw.donePlan({ planId: reqStr(p, 'planId', 'plan done'), force: bool(p['force']) }));
        case 'abandon':
          return done(aw.abandonPlan({
            planId: reqStr(p, 'planId', 'plan abandon'),
            agentId: reqStr(p, 'agentId', 'plan abandon'),
            reason: str(p['reason']),
          }));
        default:
          throw new Error('plan action must be create, list, show, done, or abandon');
      }
    }

    case 'task': {
      switch (action) {
        case 'add':
          return done(aw.addTask({
            planId: reqStr(p, 'planId', 'task add'),
            title: reqStr(p, 'title', 'task add'),
            filePath: str(p['file']),
            paths: list(p['paths']),
            reasoning: str(p['reasoning']),
            acceptance: str(p['acceptance']),
            checkCommand: str(p['checkCommand']),
            dependsOn: str(p['dependsOn']),
            priority: num(p['priority']),
          }));
        case 'list':
          return done(aw.listTasks({
            planId: str(p['planId']),
            status: str(p['status']) as TaskStatus | undefined,
            agentId: str(p['agentId']),
          }));
        case 'ready':
          return done(aw.listReadyTasks({ planId: str(p['planId']), limit: num(p['limit']) }));
        case 'show':
          return done(aw.getTask(reqStr(p, 'taskId', 'task show')));
        case 'depend':
          return done(aw.addTaskDependency({
            taskId: reqStr(p, 'taskId', 'task depend'),
            dependsOnTaskId: reqStr(p, 'dependsOn', 'task depend'),
            agentId: str(p['agentId']),
          }));
        case 'claim':
          return done(aw.claimTask({
            taskId: reqStr(p, 'taskId', 'task claim'),
            agentId: reqStr(p, 'agentId', 'task claim'),
            leaseSeconds: num(p['leaseSeconds']),
          }));
        case 'heartbeat':
          return done(aw.heartbeatTask({
            taskId: reqStr(p, 'taskId', 'task heartbeat'),
            agentId: reqStr(p, 'agentId', 'task heartbeat'),
            leaseSeconds: num(p['leaseSeconds']),
          }));
        case 'release':
          return done(aw.releaseTask({
            taskId: reqStr(p, 'taskId', 'task release'),
            agentId: reqStr(p, 'agentId', 'task release'),
            blockedReason: str(p['blockedReason']),
          }));
        case 'done':
          {
            const task = aw.doneTask({ taskId: reqStr(p, 'taskId', 'task done'), agentId: reqStr(p, 'agentId', 'task done') });
            return done({ ...task, next: { action: 'check.mark', taskId: task.taskId } });
          }
        case 'reopen':
          return done(aw.reopenTask({
            taskId: reqStr(p, 'taskId', 'task reopen'),
            agentId: reqStr(p, 'agentId', 'task reopen'),
            reason: str(p['reason']),
            leaseSeconds: num(p['leaseSeconds']),
          }));
        default:
          throw new Error('task action must be add, list, ready, show, depend, claim, heartbeat, release, done, or reopen');
      }
    }

    case 'lock': {
      switch (action) {
        case 'acquire':
          return done(aw.acquireLock({
            filePath: reqStr(p, 'file', 'lock acquire'),
            agentId: reqStr(p, 'agentId', 'lock acquire'),
            reason: str(p['reason']),
            ttlSeconds: num(p['ttlSeconds']) ?? 1800,
          }));
        case 'wait': {
          const result = aw.waitForLock({
            filePath: reqStr(p, 'file', 'lock wait'),
            agentId: str(p['agentId']),
            waitMs: num(p['waitMs']),
            retryIntervalMs: num(p['retryIntervalMs']),
          });
          return done(result, result.ok ? 0 : 2);
        }
        case 'prune':
          return done(aw.pruneLocks({ dryRun: p['dryRun'] === undefined ? true : bool(p['dryRun']) }));
        case 'release':
          return done(aw.releaseLock({ filePath: reqStr(p, 'file', 'lock release'), agentId: reqStr(p, 'agentId', 'lock release') }));
        case 'list':
          return done(aw.listLocks());
        default:
          throw new Error('lock action must be acquire, wait, prune, release, or list');
      }
    }

    case 'work': {
      switch (action) {
        case 'start':
        case 'touch':
          return done(aw.startWork({
            filePath: reqStr(p, 'file', 'work start'),
            agentId: reqStr(p, 'agentId', 'work start'),
            reason: str(p['reason']),
            ttlSeconds: num(p['ttlSeconds']) ?? 1800,
          }));
        case 'list':
          return done(aw.listWork({ filePath: str(p['file']), agentId: str(p['agentId']) }));
        case 'show':
          return done(aw.showWork({ filePath: reqStr(p, 'file', 'work show') }));
        case 'end':
          return done(aw.endWork({ filePath: reqStr(p, 'file', 'work end'), agentId: reqStr(p, 'agentId', 'work end') }));
        default:
          throw new Error('work action must be start, touch, list, show, or end');
      }
    }

    case 'handoff': {
      switch (action) {
        case 'add':
          return done(aw.addHandoff({
            agentId: reqStr(p, 'agentId', 'handoff add'),
            summary: reqStr(p, 'summary', 'handoff add'),
            files: list(p['files']),
          }));
        case 'list':
          return done(aw.listHandoffs({ includeCleared: bool(p['includeCleared']) }));
        case 'clear':
          return done(aw.clearHandoff({ handoffId: reqStr(p, 'handoffId', 'handoff clear') }));
        default:
          throw new Error('handoff action must be add, list, or clear');
      }
    }

    case 'check': {
      switch (action) {
        case 'audit':
          return done(aw.auditChecks({
            agentId: str(p['agentId']),
            planId: str(p['planId']),
            minAgeMs: num(p['minAgeMs']),
          }));
        case 'mark':
          {
            const task = aw.markCheck({
              taskId: reqStr(p, 'taskId', 'check mark'),
              agentId: reqStr(p, 'agentId', 'check mark'),
              message: reqStr(p, 'message', 'check mark'),
              status: (str(p['status']) as CheckStatus | undefined) ?? 'SUCCESS',
            });
            const planTasks = aw.listTasks({ planId: task.planId });
            const planCanFinish = planTasks.every((item) => item.status === 'DONE' && Boolean(item.verifiedAt));
            return done({
              ...task,
              next: planCanFinish
                ? { action: 'plan.done', planId: task.planId }
                : { action: 'task.ready', planId: task.planId },
            });
          }
        default:
          throw new Error(`${req.command} action must be audit or mark`);
      }
    }

    case 'message': {
      switch (action) {
        case 'send':
          return done(aw.sendMessage({
            fromAgentId: reqStr(p, 'agentId', 'message send'),
            toAgentId: str(p['to']),
            topic: str(p['topic']),
            text: reqStr(p, 'text', 'message send'),
            files: list(p['files']),
          }));
        case 'read': {
          const agentId = reqStr(p, 'agentId', 'message read');
          const messages = aw.listMessages({
            agentId,
            includeRead: bool(p['includeRead']),
            topic: str(p['topic']),
            limit: num(p['limit']) ?? 20,
          });
          for (const msg of messages) {
            if (!msg.readAt) aw.markMessageRead({ messageId: msg.messageId, agentId });
          }
          return done(messages);
        }
        case 'list':
          return done(aw.listMessages({
            agentId: str(p['agentId']),
            includeRead: bool(p['includeRead']),
            topic: str(p['topic']),
            limit: num(p['limit']) ?? 20,
          }));
        case 'prune':
          return done(aw.pruneMessages({
            olderThanMs: num(p['olderThanMs']) ?? 0,
            readOnly: bool(p['readOnly']),
            dryRun: p['dryRun'] === undefined ? true : bool(p['dryRun']),
          }));
        default:
          throw new Error('message action must be send, read, list, or prune');
      }
    }

    case 'agent': {
      switch (action) {
        case 'join':
          return done(aw.joinAgent({
            agentId: reqStr(p, 'agentId', 'agent join'),
            name: str(p['name']),
            role: str(p['role']),
            metadata: (p['metadata'] as string | Record<string, unknown> | undefined) ?? undefined,
          }));
        case 'touch':
          return done(aw.touchAgent({
            agentId: reqStr(p, 'agentId', 'agent touch'),
            status: (str(p['status']) as AgentStatus | undefined) ?? 'ACTIVE',
          }));
        case 'leave':
          return done(aw.leaveAgent({ agentId: reqStr(p, 'agentId', 'agent leave') }));
        case 'list':
          return done(aw.listAgents({ includeLeft: bool(p['includeLeft']), staleAfterMs: num(p['staleAfterMs']) }));
        default:
          throw new Error('agent action must be join, touch, leave, or list');
      }
    }

    case 'memory': {
      switch (action) {
        case 'store':
          return done(aw.storeMemory({
            label: reqStr(p, 'label', 'memory store'),
            text: reqStr(p, 'text', 'memory store'),
            tags: list(p['tags']),
          }));
        case 'store-verified':
          return done(aw.storeVerifiedMemory({
            label: reqStr(p, 'label', 'memory store-verified'), text: reqStr(p, 'text', 'memory store-verified'),
            sourceDigest: reqStr(p, 'sourceDigest', 'memory store-verified'),
            scope: str(p['scope']) as 'project' | 'artifact' | undefined,
            verifiedAt: str(p['verifiedAt']), validUntil: str(p['validUntil']),
            importance: num(p['importance']), tags: list(p['tags']),
          }));
        case 'recall':
          return done(aw.recallMemory({
            query: str(p['query']),
            label: str(p['label']),
            limit: num(p['limit']) ?? 10,
            semantic: bool(p['semantic']),
            minSimilarity: num(p['minSimilarity']),
          }));
        case 'recall-verified':
          return done(aw.recallVerifiedMemory({
            query: str(p['query']), label: str(p['label']), sourceDigest: str(p['sourceDigest']),
            scope: str(p['scope']) as 'project' | 'artifact' | undefined,
            mode: str(p['mode']) as MemoryRecallModeV1 | undefined,
            limit: num(p['limit']), now: str(p['now']), minSimilarity: num(p['minSimilarity']),
          }));
        case 'evaluate':
          return done(aw.evaluateVerifiedMemory({
            corpus: corpus(p['corpusJson']), now: str(p['now']), limit: num(p['limit']), minSimilarity: num(p['minSimilarity']),
          }));
        case 'reindex':
          return done(aw.reindexMemories({ force: bool(p['force']), limit: num(p['limit']) }));
        case 'list':
          return done(aw.recallMemory({ limit: num(p['limit']) ?? 10 }));
        case 'forget':
          return done(aw.forgetMemory({ memoryId: reqStr(p, 'memoryId', 'memory forget') }));
        case 'prune':
          return done(aw.pruneMemories({
            olderThanMs: num(p['olderThanMs']) ?? 0,
            label: str(p['label']),
            dryRun: p['dryRun'] === undefined ? true : bool(p['dryRun']),
          }));
        default:
          throw new Error('memory action must be store, store-verified, recall, recall-verified, evaluate, list, reindex, forget, or prune');
      }
    }

    default:
      throw new Error(`unknown command: ${req.command}`);
  }
}
