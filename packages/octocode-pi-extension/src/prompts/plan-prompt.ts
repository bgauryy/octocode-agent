/**
 * plan-prompt — the user-initiated "plan mode" prompt.
 *
 * `/octocode-plan new <goal>` sends this to the agent so planning becomes an
 * explicit, gated phase: research first, produce a dependency-ordered plan via
 * `plan(propose)`, and do NOT execute until the user approves in the panel.
 * Mirrors the system prompt's plan-quality rules (riskiest unknown first,
 * independently verifiable steps, parallel vs sequential lanes) without
 * restating them in the system prompt for every turn.
 */

export const PLAN_PROMPT_MAX_GOAL = 2000;

/** Build the plan-mode prompt for `goal`. Goal is whitespace-collapsed and capped. */
export function buildPlanPrompt(goal: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim().slice(0, PLAN_PROMPT_MAX_GOAL);
  const target = clean ? `Goal: ${clean}` : 'Goal: (ask the user for the goal before planning)';
  return [
    '[PLAN MODE] Plan first — do not change any file or run any mutating command until the plan is approved.',
    target,
    '',
    '1. Research: orient with Octocode tools (structure → callers → contracts), trace the real flow and blast radius, and state each assumption that affects scope. Spawn `researcher`/`planner` only if it adds independent evidence.',
    '2. Clarify: if requirements, target files, acceptance, UX/design trade-offs, or blast radius are ambiguous, ask the user before proposing. Do not hide unresolved forks inside the plan.',
    '3. Plan: call `plan(propose)` with 3–9 imperative steps — riskiest unknown first, each step independently verifiable, `dependsOn` for ordering, independent lanes left unblocked, and an explicit final verification step (tests/typecheck/lint/smoke). Give running steps an `activeForm`.',
    '4. Artifact: the plan tool writes a reviewable `plan.md`/`plan.html` under `~/.octocode/tmp/plan/<scope-hash>/`. Mention the `plan.md` path in your TL;DR. For complex architecture/design/UI plans, ask whether the user wants a live HTML design/plan page; only serve/open it after approval or explicit user choice (`/octocode-plan html` or `localServer`).',
    '5. Gate: the approval prompt is the decision point. On approve → execute, keeping steps current with `plan(start/complete)`. On free-text feedback → revise and re-propose. On reject → stop and ask how to proceed; never execute a rejected plan.',
    '',
    'Reply with a TL;DR (what the plan achieves, main risk, artifact path if available, and what is out of scope) — no code changes in this turn.',
  ].join('\n');
}
