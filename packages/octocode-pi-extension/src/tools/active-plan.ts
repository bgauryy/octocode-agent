/**
 * active-plan — a compaction-durable, session-scoped task breakdown.
 *
 * The think-first "task breakdown gate" tells the agent to decompose non-trivial work into
 * explicit steps. Historically that breakdown lived only in the model's prose, so it was
 * lossy across compaction (plan-amnesia). This module gives it a real home:
 *   - an in-memory per-workspace step list (survives compaction — same process)
 *   - re-projected into the system prompt every turn via `before_agent_start`
 *     (`renderActivePlanAddendum`), so the plan is immune to summarizer loss — exactly the
 *     mechanism proven for `<dynamic_capabilities>`.
 *
 * Pure + deterministic; the `plan` tool is a thin wrapper over these functions.
 */

export type StepStatus = 'todo' | 'doing' | 'done';

export interface PlanStep {
  text: string;
  status: StepStatus;
}

const MAX_STEPS = 40;
const MAX_STEP_CHARS = 160;

// Keyed by workspace (cwd). Module-scoped → survives compaction, resets on process reload.
const plans = new Map<string, PlanStep[]>();

function clean(text: string): string {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_STEP_CHARS ? `${oneLine.slice(0, MAX_STEP_CHARS - 1)}…` : oneLine;
}

export function getPlan(cwd: string): PlanStep[] {
  return plans.get(cwd) ?? [];
}

/** Replace the whole plan with a fresh ordered step list (first step marked doing). */
export function setPlan(cwd: string, steps: string[]): PlanStep[] {
  const cleaned = steps.map(clean).filter(Boolean).slice(0, MAX_STEPS);
  const next: PlanStep[] = cleaned.map((text, i) => ({ text, status: i === 0 ? 'doing' : 'todo' }));
  plans.set(cwd, next);
  return next;
}

export function addStep(cwd: string, text: string): PlanStep[] {
  const list = getPlan(cwd).slice();
  const t = clean(text);
  if (t && list.length < MAX_STEPS) list.push({ text: t, status: 'todo' });
  plans.set(cwd, list);
  return list;
}

/** Mark a step (1-based) doing. */
export function startStep(cwd: string, index: number): PlanStep[] {
  const list = getPlan(cwd).slice();
  const i = index - 1;
  if (i >= 0 && i < list.length) list[i] = { ...list[i]!, status: 'doing' };
  plans.set(cwd, list);
  return list;
}

/** Mark a step (1-based) done and auto-advance the next todo to doing. */
export function completeStep(cwd: string, index: number): PlanStep[] {
  const list = getPlan(cwd).slice();
  const i = index - 1;
  if (i >= 0 && i < list.length) {
    list[i] = { ...list[i]!, status: 'done' };
    if (!list.some((s) => s.status === 'doing')) {
      const nextTodo = list.findIndex((s) => s.status === 'todo');
      if (nextTodo >= 0) list[nextTodo] = { ...list[nextTodo]!, status: 'doing' };
    }
  }
  plans.set(cwd, list);
  return list;
}

export function clearPlan(cwd: string): void {
  plans.delete(cwd);
}

const MARK: Record<StepStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]' };

/**
 * Render the `<active_plan>` block for the system prompt, or `''` when there is no plan.
 * Re-emitted every turn so the breakdown survives compaction and reload-into-summary.
 */
export function renderActivePlanAddendum(cwd: string): string {
  const list = getPlan(cwd);
  if (list.length === 0) return '';
  const done = list.filter((s) => s.status === 'done').length;
  const current = list.find((s) => s.status === 'doing') ?? list.find((s) => s.status === 'todo');
  return [
    '<active_plan>',
    `Your current task breakdown (${done}/${list.length} done). Execute the next step, then update it via the plan tool (start/complete). Keep it proportional; clear it when the task is finished.`,
    ...list.map((s, i) => `${MARK[s.status]} ${i + 1}. ${s.text}`),
    current ? `next: ${current.text}` : 'next: (all steps done — verify, then plan clear)',
    '</active_plan>',
  ].join('\n');
}
