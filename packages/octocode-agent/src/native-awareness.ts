import type { DatabaseSync } from 'node:sqlite';
import {
  ROUTABLE_OPERATIONS,
  runAwarenessToolOperation,
  type AwarenessToolOperation,
  type AwarenessToolOperationResult,
} from '@octocodeai/octocode-awareness';
import {
  closeOctocodeDb,
  agentDbPath,
  openOctocodeDb,
} from '@octocodeai/octocode-awareness/mcp-state';
import { createEffectSet, type ToolRegistry } from '@octocodeai/agent-core';

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

export function registerNativeAwarenessTool(registry: ToolRegistry, options: NativeAwarenessOptions): void {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath ?? agentDbPath(env);
  const openDb = options.openDb ?? openOctocodeDb;
  const closeDb = options.closeDb ?? closeOctocodeDb;
  const run = options.run ?? runAwarenessToolOperation;
  const actions = new Set<string>(ROUTABLE_OPERATIONS);

  registry.register({
    name: 'awareness',
    label: 'Awareness',
    description: 'Use the package-owned Awareness operation catalog for coordination, verification, memory, reflection, and repository views. Because one runtime tool policy cannot vary by action, every action uses conservative write approval even when the selected operation is read-only.',
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
    policy: { effects: createEffectSet('read', 'write'), trust: 'workspace', approval: 'on-request', plan: 'allowed' },
    async execute(execution) {
      if (!isRecord(execution.input)) throw new Error('Awareness input must be an object');
      const action = execution.input.action;
      if (typeof action !== 'string' || !actions.has(action)) throw new Error('Awareness action is not routable');
      const request = execution.input.request ?? {};
      if (!isRecord(request)) throw new Error('Awareness request must be an object');
      const operation = action as AwarenessToolOperation;
      const sessionId = String(execution.context.sessionId);
      const agentId = options.agentId?.trim() || env.OCTOCODE_AGENT_ID?.trim() || `native:${sessionId}`;
      let opened = false;
      await execution.update({ version: 1, kind: 'status', message: `Running awareness ${operation}` });
      try {
        if (execution.signal.aborted) throw new Error('Awareness operation cancelled');
        const db = openDb(dbPath);
        opened = true;
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
        if (opened) closeDb(dbPath);
      }
    },
  }, 'octocode-awareness');
}
