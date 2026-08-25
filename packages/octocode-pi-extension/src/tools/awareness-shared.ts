/**
 * Shared plumbing for the first-class Awareness Lite coordination tools
 * (lock/task/work/handoff/verify/message/agent/status). Each is a thin,
 * in-process wrapper over the same `@octocodeai/octocode-awareness-lite` library
 * the CLI exposes — no child process — so the model reaches the shared ledger as
 * typed, tool-stream-visible operations instead of hand-built CLI flags.
 */

import path from 'node:path';
import {
  openAwarenessLite,
  dispatchAwarenessCommand,
  type AwarenessCommandRequest,
  type Task,
} from '@octocodeai/octocode-awareness/lite';
import type { ToolCallResult, PiContext, PiTheme } from '../types.js';
import { CLI_GLYPH, cliToolTitle, paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';

/**
 * The session-stable Awareness Lite agent id. OCTOCODE_AGENT_ID (set at
 * session_start) wins so every surface — hooks, tools, the registry — agrees on
 * WHO this session is; otherwise derive `pi:<sessionId|pid>` and cache it.
 * Single source shared by index.ts and the coordination tools.
 */
export function getAwarenessLiteAgentId(ctx?: PiContext): string {
  if (process.env.OCTOCODE_AGENT_ID) return process.env.OCTOCODE_AGENT_ID;
  const sessionId = ctx?.sessionManager?.getSessionId?.()
    ?? (ctx?.sessionManager?.getSessionFile?.() ? path.basename(ctx.sessionManager.getSessionFile()!) : undefined);
  const agentId = `pi:${sessionId || process.pid}`;
  process.env.OCTOCODE_AGENT_ID = agentId;
  return agentId;
}

export interface AwarenessJsonResult {
  ok: boolean;
  code: number;
  json: unknown;
  error?: string;
  raw: string;
}

/**
 * Run a STRUCTURED Awareness Lite command through the shared dispatcher — the
 * exact same command→library mapping the `octocode-awareness-lite` CLI uses.
 * This is how the extension's first-class tools reach the ledger without
 * building CLI arg-vectors and round-tripping them back through the parser: one
 * logic path, so the tools and the CLI can never drift. The result shape mirrors
 * `runAwarenessJson` so call sites are interchangeable (exit 2 for a still-held
 * `lock wait` is a domain result, not an error). Never throws.
 */
export function runAwarenessCommand(req: AwarenessCommandRequest, cwd: string, dbPath?: string): AwarenessJsonResult {
  let aw: ReturnType<typeof openAwarenessLite> | undefined;
  try {
    aw = openAwarenessLite({ workspace: cwd, dbPath });
    const { result, exitCode } = dispatchAwarenessCommand(aw, req);
    const record = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
    const failed = exitCode !== 0 && exitCode !== 2;
    return {
      ok: !failed,
      code: exitCode,
      json: result,
      error: failed ? (typeof record?.['error'] === 'string' ? (record['error'] as string) : `exit ${exitCode}`) : undefined,
      raw: result === undefined ? '' : JSON.stringify(result),
    };
  } catch (err) {
    // Unknown command/action or a missing required param throws — surface it the
    // same way the CLI's non-zero exit would (code 1), not as a crash.
    return { ok: false, code: 1, json: null, error: err instanceof Error ? err.message : String(err), raw: '' };
  } finally {
    aw?.close();
  }
}

export function awarenessError(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true } as unknown as ToolCallResult;
}

/** Uniform success result: a one-line summary plus the raw JSON payload for the model. */
export function awarenessOk(summary: string, action: string, json: unknown): ToolCallResult {
  const text = json === null || json === undefined ? summary : `${summary}\n${JSON.stringify(json)}`;
  return { content: [{ type: 'text', text }], details: { action, result: json } } as unknown as ToolCallResult;
}

/** Shared renderCall: `⟨title⟩ action hint`. */
export function renderAwarenessCall(toolName: string, action: string, hint: string, theme?: PiTheme) {
  const title = cliToolTitle(theme, toolName);
  const body = paint(theme, 'dim', `${action} ${hint}`.trim());
  return makeRenderer((w) => [truncateToWidth(`${title} ${body}`, w)]);
}

/** Shared renderResult: success/error glyph + first summary line. */
export function renderAwarenessResult(result: ToolCallResult, theme?: PiTheme) {
  const ok = !result.isError;
  const first = ((result.content?.[0] as { text?: string } | undefined)?.text ?? '').split('\n')[0] || 'awareness';
  const line = ok
    ? paint(theme, 'success', `${CLI_GLYPH.success} ${first}`)
    : paint(theme, 'error', `${CLI_GLYPH.error} ${first}`);
  return makeRenderer((w) => [truncateToWidth(line, w)]);
}

/** Count rows in an array-or-{items|results} JSON shape, for summaries. */
export function countRows(json: unknown): number {
  if (Array.isArray(json)) return json.length;
  if (json && typeof json === 'object') {
    for (const key of ['items', 'results', 'pending', 'plans', 'tasks', 'locks', 'work', 'handoffs', 'agents', 'messages']) {
      const v = (json as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v.length;
    }
  }
  return 0;
}

export type UnifiedPlanScope = 'auto' | 'session' | 'shared';

export interface UnifiedPlanProjectionStep {
  id: string;
  text: string;
  status: 'todo' | 'doing' | 'done';
  dependsOnStepIds?: string[];
  paths?: string[];
  reasoning?: string;
  acceptance?: string;
  checkCommand?: string;
  awarenessTaskId?: string;
}

export interface UnifiedPlanProjectionInput {
  requestedScope: UnifiedPlanScope;
  workspace: string;
  sourcePlanKey: string;
  awarenessPlanId?: string;
  title: string;
  goal?: string;
  rfcPath?: string;
  rfcRevision?: string;
  agentId: string;
  steps: UnifiedPlanProjectionStep[];
}

export interface UnifiedPlanProjectionResult {
  scope: 'session' | 'shared';
  adopted: boolean;
  awarenessPlanId?: string;
  taskIdsByStepId?: Record<string, string>;
}

export interface ObservedCheckReceipt {
  command: string;
  status: 'SUCCESS' | 'FAILED';
  message: string;
}

export interface UnifiedPlanCompletionResult {
  task: Task;
  verified: boolean;
  reopened: boolean;
}

type CompletionStore = Pick<
  ReturnType<typeof openAwarenessLite>,
  'getTask' | 'doneTask' | 'markCheck' | 'reopenTask' | 'close'
>;

function normalizedPaths(workspace: string, paths: string[] | undefined): Set<string> {
  return new Set((paths ?? []).map((candidate) => path.resolve(workspace, candidate)));
}

function safelyAdoptableClaim(
  workspace: string,
  steps: UnifiedPlanProjectionStep[],
  claimed: Task[],
): Task | undefined {
  if (steps.length !== 1 || claimed.length !== 1) return undefined;
  const step = steps[0]!;
  const task = claimed[0]!;
  const stepPaths = normalizedPaths(workspace, step.paths);
  const taskPaths = normalizedPaths(workspace, task.paths);
  const overlaps = [...stepPaths].some((candidate) => taskPaths.has(candidate));
  return overlaps || task.title === step.text ? task : undefined;
}

/**
 * Resolve and, when necessary, materialize the shared execution projection.
 * Auto remains session-local unless a safe one-step current claim or an existing
 * persisted mapping proves that this plan is already attached to shared work.
 */
export function completeUnifiedPlanTask(
  input: { workspace: string; taskId: string; agentId: string; receipt?: ObservedCheckReceipt },
  openStore: (workspace: string) => CompletionStore = (workspace) => openAwarenessLite({ workspace }),
): UnifiedPlanCompletionResult {
  const lite = openStore(input.workspace);
  try {
    const current = lite.getTask(input.taskId);
    if (current.status === 'DONE' && current.verifiedAt) {
      return { task: current, verified: true, reopened: false };
    }
    if (current.status !== 'CLAIMED' || current.agentId !== input.agentId) {
      throw new Error(`task ${current.taskId} is not claimed by ${input.agentId}`);
    }
    if (current.checkCommand) {
      if (!input.receipt) throw new Error(`task ${current.taskId} requires an observed check receipt`);
      if (input.receipt.command.trim() !== current.checkCommand.trim()) {
        throw new Error(`receipt command must match declared check command: ${current.checkCommand}`);
      }
    }
    if (input.receipt && !input.receipt.message.trim()) throw new Error('receipt message is required');

    lite.doneTask({ taskId: current.taskId, agentId: input.agentId });
    const message = input.receipt?.message.trim() || 'Completed without a configured check command';
    try {
      const marked = lite.markCheck({
        taskId: current.taskId,
        agentId: input.agentId,
        message,
        status: input.receipt?.status ?? 'SUCCESS',
      });
      const reopened = input.receipt?.status === 'FAILED';
      return { task: marked, verified: !reopened, reopened };
    } catch (markError) {
      try {
        lite.reopenTask({
          taskId: current.taskId,
          agentId: input.agentId,
          reason: `check receipt failed: ${markError instanceof Error ? markError.message : String(markError)}`,
        });
      } catch (reopenError) {
        throw new Error(`check receipt failed and compensation failed; task is DONE with verification debt: ${markError instanceof Error ? markError.message : String(markError)}; reopen: ${reopenError instanceof Error ? reopenError.message : String(reopenError)}`);
      }
      throw new Error(`check receipt failed; task reopened: ${markError instanceof Error ? markError.message : String(markError)}`);
    }
  } finally {
    lite.close();
  }
}

export function finalizeUnifiedPlan(input: { workspace: string; planId: string }): boolean {
  const lite = openAwarenessLite({ workspace: input.workspace });
  try {
    const tasks = lite.listTasks({ planId: input.planId });
    if (tasks.length === 0 || tasks.some((task) => task.status !== 'DONE' || !task.verifiedAt)) return false;
    lite.donePlan({ planId: input.planId });
    return true;
  } finally {
    lite.close();
  }
}

export function projectUnifiedPlan(input: UnifiedPlanProjectionInput): UnifiedPlanProjectionResult {
  if (input.requestedScope === 'session') return { scope: 'session', adopted: false };

  const lite = openAwarenessLite({ workspace: input.workspace });
  try {
    const mapped = input.steps.length > 0 && input.steps.every((step) => Boolean(step.awarenessTaskId));
    if (mapped && input.awarenessPlanId) {
      const taskIdsByStepId: Record<string, string> = {};
      for (const step of input.steps) {
        const task = lite.getTask(step.awarenessTaskId!);
        if (task.planId !== input.awarenessPlanId) throw new Error(`mapped task ${task.taskId} belongs to another plan`);
        taskIdsByStepId[step.id] = task.taskId;
      }
      const plan = lite.getPlan(input.awarenessPlanId);
      if (plan.sourceKind !== 'pi' || plan.sourceKey !== input.sourcePlanKey) {
        return { scope: 'shared', adopted: true, awarenessPlanId: input.awarenessPlanId, taskIdsByStepId };
      }
    }

    const currentClaims = lite.listTasks({ status: 'CLAIMED', agentId: input.agentId });
    const adoptable = safelyAdoptableClaim(input.workspace, input.steps, currentClaims);
    if (adoptable) {
      return {
        scope: 'shared',
        adopted: true,
        awarenessPlanId: adoptable.planId,
        taskIdsByStepId: { [input.steps[0]!.id]: adoptable.taskId },
      };
    }

    if (input.requestedScope === 'auto') return { scope: 'session', adopted: false };
    if (input.steps.length === 0) throw new Error('shared plan requires at least one execution step');

    const graph = lite.materializePlanGraph({
      sourceKind: 'pi',
      sourcePlanKey: input.sourcePlanKey,
      title: input.title,
      goal: input.goal,
      rfcPath: input.rfcPath,
      rfcRevision: input.rfcRevision,
      steps: input.steps.map((step, index) => ({
        sourceStepKey: step.id,
        title: step.text,
        paths: step.paths,
        reasoning: step.reasoning,
        acceptance: step.acceptance,
        checkCommand: step.checkCommand,
        dependsOnStepKeys: step.dependsOnStepIds,
        priority: input.steps.length - index,
      })),
    });
    const taskIdsByStepId: Record<string, string> = {};
    for (const [stepId, task] of graph.tasks) taskIdsByStepId[stepId] = task.taskId;

    const active = input.steps.find((step) => step.status === 'doing');
    if (active) {
      const task = graph.tasks.get(active.id);
      if (!task) throw new Error(`missing materialized task for active step ${active.id}`);
      if (task.status === 'OPEN') lite.claimTask({ taskId: task.taskId, agentId: input.agentId });
      else if (task.status === 'CLAIMED' && task.agentId !== input.agentId) {
        throw new Error(`task ${task.taskId} belongs to ${task.agentId}`);
      }
    }

    return {
      scope: 'shared',
      adopted: false,
      awarenessPlanId: graph.plan.planId,
      taskIdsByStepId,
    };
  } finally {
    lite.close();
  }
}
