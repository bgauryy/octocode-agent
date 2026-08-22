/**
 * plan-mode — the hard gate behind `/octocode-plan new`.
 *
 * Pi's canonical plan-mode extension disables write tools while planning
 * instead of trusting the prompt; we do the same through the `tool_call` hook
 * (every write-tool registration is covered without churning the active tool
 * list). Entered by `/octocode-plan new`, exited by an approved `plan(propose)`
 * or `/octocode-plan off`; reset on session start. A footer status chip shows
 * the mode while it is on.
 */

import { paint } from '../tui/palette.js';
import type { PiContext } from '../types.js';

const STATUS_KEY = 'octocode-plan-mode';

/** Tools that mutate the workspace and are blocked while a plan awaits approval. */
export const PLAN_MODE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multi_edit',
  'multiedit',
  'notebookedit',
  'notebook_edit',
  'apply_patch',
  'applypatch',
]);

export const PLAN_MODE_BLOCK_REASON =
  'Plan mode: no edits until the plan is approved — call plan(propose) and wait for the user’s verdict (or the user runs /octocode-plan off).';

let enabled = false;

export function isPlanMode(): boolean {
  return enabled;
}

function paintStatus(ctx: PiContext | undefined): void {
  if (!ctx?.hasUI) return;
  ctx.ui?.setStatus?.(STATUS_KEY, enabled ? paint(ctx.ui.theme, 'warning', 'plan mode') : undefined);
}

export function enterPlanMode(ctx?: PiContext): void {
  enabled = true;
  paintStatus(ctx);
}

export function exitPlanMode(ctx?: PiContext): void {
  enabled = false;
  paintStatus(ctx);
}

/** `tool_call` hook body: block workspace mutations while plan mode is on. */
export function planModeToolGate(toolName: string | undefined): { block: true; reason: string } | undefined {
  if (!enabled || !toolName) return undefined;
  return PLAN_MODE_BLOCKED_TOOLS.has(toolName.toLowerCase()) ? { block: true, reason: PLAN_MODE_BLOCK_REASON } : undefined;
}
