/**
 * Session-scoped review-phase effect policy.
 *
 * Policy identity includes this runtime instance, the host session key, the
 * active branch snapshot, and its generation. Branch adoption replaces the
 * active session policy; stale same-branch generations cannot roll it back.
 */

import { randomUUID } from 'node:crypto';
import { paintUi } from '../tui/palette.js';
import type { PiContext } from '../types.js';
import { resolveSessionIdentity, type SessionIdentityInput } from './session-artifacts.js';
import { setManagedStatus } from './runtime-renderer.js';

const [STATUS_KEY] = ['octocode-plan-mode'] as const;
const RUNTIME_INSTANCE_ID = randomUUID();
const FALLBACK_SESSION_KEY = 'process-fallback';

export type PlanPolicyPhase =
  | 'researching'
  | 'needs_answers'
  | 'draft'
  | 'in_review'
  | 'accepted'
  | 'executing'
  | 'verifying'
  | 'complete'
  | 'abandoned';

export type ToolEffect = 'read' | 'planning-write' | 'coordination-write' | 'workspace-write' | 'external-effect';

export interface PlanModePolicyInput {
  phase: PlanPolicyPhase;
  branchSnapshotId: string;
  generation: number;
}

interface StoredPlanModePolicy extends PlanModePolicyInput {
  runtimeInstanceId: string;
  sessionKey: string;
}

const policies = new Map<string, StoredPlanModePolicy>();
const visibleStatusSlots = new Set<string>();

/** Explicit effect metadata for every shipped support/override tool. */
const TOOL_EFFECTS: Readonly<Record<string, ToolEffect>> = Object.freeze({
  askuser: 'read',
  skill: 'read',
  readmedia: 'read',
  web: 'read',
  ghsearchcode: 'read',
  ghgetfilecontent: 'read',
  ghviewrepostructure: 'read',
  ghsearchrepos: 'read',
  ghsearchpullrequests: 'read',
  ghsearchissues: 'read',
  ghsearchcommits: 'read',
  ghclonerepo: 'read',
  npmsearch: 'read',
  localsearchcode: 'read',
  localviewstructure: 'read',
  localfindfiles: 'read',
  localgetfilecontent: 'read',
  localfinddeadcode: 'read',
  lspgetsemantics: 'read',

  plan: 'planning-write',

  memory: 'coordination-write',
  lock: 'coordination-write',
  claim: 'coordination-write',
  task: 'coordination-write',
  handoff: 'coordination-write',
  verify: 'coordination-write',
  message: 'coordination-write',
  awarenessagents: 'coordination-write',
  awarenessplan: 'coordination-write',
  agent: 'coordination-write',

  file: 'workspace-write',
  bash: 'workspace-write',
  media: 'workspace-write',

  chromedebug: 'external-effect',
  browseragent: 'external-effect',
  spawnsubagent: 'external-effect',
  calltool: 'external-effect',
  callskill: 'external-effect',
  localserver: 'external-effect',
  mcptool: 'external-effect',
  spawnagent: 'external-effect',
});

export const PLAN_MODE_BLOCK_REASON =
  'Plan review: workspace, shell, and external effects stay blocked until the user separately starts implementation.';

function sessionKey(ctx?: SessionIdentityInput): string {
  if (!ctx) return FALLBACK_SESSION_KEY;
  try {
    return resolveSessionIdentity(ctx).sessionKey;
  } catch {
    return FALLBACK_SESSION_KEY;
  }
}

function slot(ctx?: SessionIdentityInput): string {
  return `${RUNTIME_INSTANCE_ID}\0${sessionKey(ctx)}`;
}

function phaseBlocksEffects(phase: PlanPolicyPhase): boolean {
  return phase !== 'executing' && phase !== 'verifying' && phase !== 'complete';
}

function paintStatus(ctx: PiContext | undefined): void {
  if (!ctx?.hasUI) return;
  const key = slot(ctx);
  const policy = policies.get(key);
  const text = policy && phaseBlocksEffects(policy.phase) ? `plan · ${policy.phase.replace('_', ' ')}` : undefined;
  if (text) {
    setManagedStatus(ctx, STATUS_KEY, paintUi(ctx.ui, 'warning', text));
    visibleStatusSlots.add(key);
  } else if (visibleStatusSlots.delete(key)) {
    setManagedStatus(ctx, STATUS_KEY, undefined);
  }
}

/** Enter a fresh researching phase for only this runtime session. */
export function enterPlanMode(ctx?: PiContext): void {
  const key = sessionKey(ctx);
  policies.set(slot(ctx), {
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    sessionKey: key,
    phase: 'researching',
    branchSnapshotId: `planning:${key}`,
    generation: 0,
  });
  paintStatus(ctx);
}

/** Explicitly clear only the targeted runtime/session policy. */
export function exitPlanMode(ctx?: PiContext): void {
  policies.delete(slot(ctx));
  paintStatus(ctx);
}

/**
 * Adopt the active branch's authoritative policy.
 * A different branch replaces the slot even at a lower generation; a stale
 * event for the same branch is rejected.
 */
export function adoptPlanModePolicy(ctx: PiContext | undefined, next: PlanModePolicyInput): boolean {
  if (!next.branchSnapshotId.trim() || !Number.isSafeInteger(next.generation) || next.generation < 0) return false;
  const key = slot(ctx);
  const current = policies.get(key);
  if (current && current.branchSnapshotId === next.branchSnapshotId && next.generation < current.generation) return false;
  policies.set(key, {
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    sessionKey: sessionKey(ctx),
    ...next,
  });
  paintStatus(ctx);
  return true;
}

export function getPlanModePolicy(ctx?: PiContext): PlanModePolicyInput | undefined {
  const policy = policies.get(slot(ctx));
  if (!policy) return undefined;
  return {
    phase: policy.phase,
    branchSnapshotId: policy.branchSnapshotId,
    generation: policy.generation,
  };
}

export function isPlanMode(ctx?: PiContext): boolean {
  const policy = policies.get(slot(ctx));
  return Boolean(policy && phaseBlocksEffects(policy.phase));
}

export function getToolEffect(toolName: string | undefined, input?: Record<string, unknown>): ToolEffect | undefined {
  if (!toolName) return undefined;
  const normalized = toolName.toLowerCase();
  if (normalized === 'mcptool') {
    const queries = Array.isArray(input?.['queries'])
      ? input['queries'].filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
      : [input ?? {}];
    const hasExternalEffect = queries.some((query) => {
      const action = typeof query['action'] === 'string' ? query['action'].toLowerCase() : 'list';
      const server = typeof query['server'] === 'string' ? query['server'] : undefined;
      return (action === 'call' && server !== 'octocode')
        || ['add', 'remove', 'restart', 'stop'].includes(action);
    });
    return hasExternalEffect ? 'external-effect' : 'read';
  }
  return TOOL_EFFECTS[normalized];
}

export function unclassifiedToolNames(toolNames: Iterable<string>): string[] {
  return [...toolNames].filter((name) => !getToolEffect(name)).sort();
}

/** Block broad/unknown effects before Start; allow read/planning/coordination effects. */
export function planModeToolGate(
  toolName: string | undefined,
  ctx?: PiContext,
  input?: Record<string, unknown>,
): { block: true; reason: string } | undefined {
  if (!isPlanMode(ctx) || !toolName) return undefined;
  const effect = getToolEffect(toolName, input);
  return effect === 'read' || effect === 'planning-write' || effect === 'coordination-write'
    ? undefined
    : { block: true, reason: PLAN_MODE_BLOCK_REASON };
}

export function clearPlanModePoliciesForTests(): void {
  policies.clear();
}
