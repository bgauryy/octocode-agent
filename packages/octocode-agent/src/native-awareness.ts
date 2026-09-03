import type { DatabaseSync } from 'node:sqlite';
import {
  ROUTABLE_OPERATIONS,
  connectDb,
  resolveDbPath,
  runAwarenessToolOperation,
  type AwarenessToolOperation,
  type AwarenessToolOperationResult,
} from '@octocodeai/octocode-awareness';
import { createEffectSet, type ToolPolicyResolution, type ToolRegistry } from '@octocodeai/agent-core';

type AwarenessRunner = (
  db: DatabaseSync,
  operation: AwarenessToolOperation,
  request: Record<string, unknown>,
  context: { agentId?: string | null; cwd?: string | null; sessionId?: string | null },
) => AwarenessToolOperationResult;

export interface NativeAwarenessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly agentId?: string;
  readonly dbPath?: string;
  readonly openDb?: (dbPath: string) => DatabaseSync;
  readonly closeDb?: (dbPath: string) => void;
  readonly run?: AwarenessRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Awareness operation failed';
}

const ROUTABLE_ACTIONS = new Set<string>(ROUTABLE_OPERATIONS);
const READ_POLICY: ToolPolicyResolution = Object.freeze({
  effects: createEffectSet('read'),
  trust: 'none',
  approval: 'never',
});
const MUTATION_POLICY: ToolPolicyResolution = Object.freeze({
  effects: createEffectSet('read', 'write'),
  trust: 'workspace',
  approval: 'on-request',
});
const READ_ONLY_OPERATIONS = new Set<AwarenessToolOperation>([
  'workspace_status',
  'refine_get',
  'verify_audit',
  'mine_weakness',
  'export_harness',
  'attend',
  'query',
]);

function resolveAwarenessPolicy(input: unknown): ToolPolicyResolution {
  if (!isRecord(input)) throw new Error('Awareness policy input must be an object');
  const action = input.action;
  if (typeof action !== 'string' || !ROUTABLE_ACTIONS.has(action)) {
    throw new Error('Awareness policy action is not routable');
  }
  const request = input.request ?? {};
  if (!isRecord(request)) throw new Error('Awareness policy request must be an object');
  const operation = action as AwarenessToolOperation;

  if (READ_ONLY_OPERATIONS.has(operation)) return READ_POLICY;
  if (operation === 'digest') {
    return request['dry_run'] === true && !request['export_doc'] ? READ_POLICY : MUTATION_POLICY;
  }
  if (operation === 'forget') return request['dry_run'] === true ? READ_POLICY : MUTATION_POLICY;
  if (operation === 'agent_signal') {
    const signalAction = request['action'];
    if (!['publish', 'list', 'reply', 'resolve', 'ack'].includes(String(signalAction))) {
      throw new Error('Awareness agent_signal policy requires request.action');
    }
    return signalAction === 'list' && (request['mark_read'] === undefined || request['mark_read'] === false)
      ? READ_POLICY
      : MUTATION_POLICY;
  }
  if (operation === 'file_lock') {
    const lockType = request['type'];
    if (!['lock', 'release', 'status', 'renew'].includes(String(lockType))) {
      throw new Error('Awareness file_lock policy requires request.type');
    }
    return lockType === 'status' ? READ_POLICY : MUTATION_POLICY;
  }
  return MUTATION_POLICY;
}

export function registerNativeAwarenessTool(registry: ToolRegistry, options: NativeAwarenessOptions): void {
  const env = options.env ?? process.env;
  const dbPath = resolveDbPath(options.dbPath, { scope: 'repo', workspace: options.cwd });
  const openDb = options.openDb ?? connectDb;
  const closeDb = options.closeDb;
  const run = options.run ?? runAwarenessToolOperation;

  registry.register({
    name: 'awareness',
    label: 'Awareness',
    description: 'Use the package-owned Awareness operation catalog for coordination, verification, memory, reflection, and repository views. Read-only actions run without approval; mutations retain workspace trust and approval gates.',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: [...ROUTABLE_OPERATIONS] },
        request: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    outputVersion: 1,
    policy: { ...MUTATION_POLICY, plan: 'allowed', resolve: resolveAwarenessPolicy },
    async execute(execution) {
      if (!isRecord(execution.input)) throw new Error('Awareness input must be an object');
      const action = execution.input.action;
      if (typeof action !== 'string' || !ROUTABLE_ACTIONS.has(action)) throw new Error('Awareness action is not routable');
      const request = execution.input.request ?? {};
      if (!isRecord(request)) throw new Error('Awareness request must be an object');
      const operation = action as AwarenessToolOperation;
      const sessionId = String(execution.context.sessionId);
      const agentId = options.agentId?.trim() || env.OCTOCODE_AGENT_ID?.trim() || `native:${sessionId}`;
      let db: DatabaseSync | undefined;
      await execution.update({ version: 1, kind: 'status', message: `Running awareness ${operation}` });
      try {
        if (execution.signal.aborted) throw new Error('Awareness operation cancelled');
        db = openDb(dbPath);
        const result = run(db, operation, request, {
          cwd: execution.context.cwd || options.cwd,
          sessionId,
          agentId,
        });
        const content = { operation, exitCode: result.exitCode, payload: result.payload };
        if (result.exitCode !== 0) {
          await execution.update({ version: 1, kind: 'status', message: `Awareness ${operation} exited ${result.exitCode}` });
          return { ok: false, category: 'awareness-exit', content, detailsVersion: 1 };
        }
        await execution.update({ version: 1, kind: 'status', message: `Completed awareness ${operation}` });
        return { ok: true, content, detailsVersion: 1 };
      } catch (error) {
        await execution.update({ version: 1, kind: 'status', message: `${execution.signal.aborted ? 'Cancelled' : 'Failed'} awareness ${operation}` });
        return {
          ok: false,
          category: execution.signal.aborted ? 'cancelled' : 'awareness-error',
          content: { operation, exitCode: execution.signal.aborted ? 130 : 1, error: { message: errorMessage(error) } },
          detailsVersion: 1,
        };
      } finally {
        if (db) {
          if (closeDb) closeDb(dbPath);
          else db.close();
        }
      }
    },
  }, 'octocode-awareness');
}
