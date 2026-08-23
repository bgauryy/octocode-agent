/** Temporary no-mutation contract used by `/octocode-plan new`. */

export const PLAN_PROMPT_MAX_GOAL = 2000;

/** Build a bounded planning request; the plan tool and RFC skill own field-level detail. */
export function buildPlanPrompt(goal: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim().slice(0, PLAN_PROMPT_MAX_GOAL);
  const target = clean ? `Goal: ${clean}` : 'Goal: (ask the user for the goal before planning)';
  return [
    '[PLAN MODE] Do not change files or run mutating commands until the user approves the plan.',
    target,
    '',
    '1. Establish only the evidence that changes scope, dependencies, risk, or acceptance. For a simple request, keep this brief; for shared or cross-cutting work, trace the relevant callers and contracts.',
    '2. If the work is consequential, use the RFC workflow, discuss the document with the user, and wait for acceptance. Otherwise state why a lightweight plan is sufficient.',
    '3. Ask bounded clarification only for material choices the repository cannot answer. Do not turn reversible implementation details into questions.',
    '4. Call plan(propose) with dependency-ordered, independently verifiable steps and a final real-world check. A consequential proposal must link its accepted RFC.',
    '5. The proposal is the approval gate: approval permits execution; feedback means revise and re-propose; rejection means stop; never execute a rejected plan.',
    '',
    'Return the plan result, main risk, and excluded scope. Make no code changes in this turn.',
  ].join('\n');
}
