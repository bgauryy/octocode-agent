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

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getOctocodeHome } from '../env.js';

export type StepStatus = 'todo' | 'doing' | 'done';

export interface PlanStep {
  text: string;
  status: StepStatus;
  /** Present-continuous label shown while this step is the active one (e.g. "Editing file"). */
  activeForm?: string;
  /** 1-based indices of steps that must be `done` before this one can start. */
  dependsOn?: number[];
}

/** A step input: either a bare imperative string, or {text, activeForm, dependsOn}. */
export type StepInput = string | { text: string; activeForm?: string; dependsOn?: number[] };

/** Derived display status: a todo step whose dependencies aren't all done shows as 'blocked'. */
export type DisplayStatus = StepStatus | 'blocked';

function cleanDeps(deps: unknown): number[] | undefined {
  if (!Array.isArray(deps)) return undefined;
  const out = deps.filter((d): d is number => Number.isInteger(d) && (d as number) >= 1).slice(0, MAX_STEPS);
  return out.length ? out : undefined;
}

/** Whether all of a step's dependencies resolve to `done` steps (out-of-range deps are ignored). */
export function depsMet(step: PlanStep, list: PlanStep[]): boolean {
  if (!step.dependsOn || step.dependsOn.length === 0) return true;
  return step.dependsOn.every((d) => {
    const dep = list[d - 1];
    return !dep || dep.status === 'done';
  });
}

/** Display status for a step: 'blocked' when it's a todo with unmet dependencies. */
export function displayStatus(step: PlanStep, list: PlanStep[]): DisplayStatus {
  return step.status === 'todo' && !depsMet(step, list) ? 'blocked' : step.status;
}

const MAX_STEPS = 40;
const MAX_STEP_CHARS = 160;

// Keyed by workspace (cwd). Module-scoped in-memory cache; backed by disk so the plan
// survives compaction AND process restart. Lazily loaded from disk on first read per cwd.
const plans = new Map<string, PlanStep[]>();
const loaded = new Set<string>();

function planFile(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return path.join(getOctocodeHome(), 'plans', `${hash}.json`);
}

function sanitizeStored(raw: unknown): PlanStep[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { steps?: unknown }).steps)) return [];
  const out: PlanStep[] = [];
  for (const s of (raw as { steps: unknown[] }).steps) {
    if (!s || typeof s !== 'object') continue;
    const rec = s as Record<string, unknown>;
    const text = typeof rec.text === 'string' ? clean(rec.text) : '';
    if (!text) continue;
    const status: StepStatus = rec.status === 'doing' || rec.status === 'done' ? rec.status : 'todo';
    const step: PlanStep = { text, status };
    if (typeof rec.activeForm === 'string' && rec.activeForm.trim()) step.activeForm = clean(rec.activeForm);
    const deps = cleanDeps(rec.dependsOn);
    if (deps) step.dependsOn = deps;
    out.push(step);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

/** Read the persisted plan for a workspace. Returns [] on any error or missing file. */
function readFromDisk(cwd: string): PlanStep[] {
  try {
    const file = planFile(cwd);
    if (!fs.existsSync(file)) return [];
    return sanitizeStored(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

/** Atomically persist (or delete when empty) the plan for a workspace. Never throws. */
function writeToDisk(cwd: string, steps: PlanStep[]): void {
  try {
    const file = planFile(cwd);
    if (steps.length === 0) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, cwd, steps, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, file);
  } catch {
    // Persistence is best-effort; degrade to in-memory.
  }
}

/** Lazily hydrate the in-memory plan from disk once per workspace per process. */
function ensureLoaded(cwd: string): void {
  if (loaded.has(cwd)) return;
  loaded.add(cwd);
  if (plans.has(cwd)) return;
  const disk = readFromDisk(cwd);
  if (disk.length > 0) plans.set(cwd, disk);
}

/** Persist the current in-memory plan for a workspace. */
function persist(cwd: string): void {
  writeToDisk(cwd, plans.get(cwd) ?? []);
}

/** Test hook: read the persisted plan straight from disk, bypassing the in-memory cache. */
export function readPersistedPlanForTests(cwd: string): PlanStep[] {
  return readFromDisk(cwd);
}

// Turns since the plan was last mutated, per workspace. Reset to 0 on every mutation;
// bumped once per turn from before_agent_start. Powers the stale-plan nudge.
const turnsSinceUpdate = new Map<string, number>();

/** After this many turns with no plan update, the addendum nudges the agent to update or clear it. */
export const STALE_PLAN_TURNS = 10;

function markUpdated(cwd: string): void {
  turnsSinceUpdate.set(cwd, 0);
}

/** Bump the per-turn staleness counter (called once per turn). Returns the new count. */
export function bumpPlanTurn(cwd: string): number {
  if (getPlan(cwd).length === 0) return 0;
  const next = (turnsSinceUpdate.get(cwd) ?? 0) + 1;
  turnsSinceUpdate.set(cwd, next);
  return next;
}

function clean(text: string): string {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_STEP_CHARS ? `${oneLine.slice(0, MAX_STEP_CHARS - 1)}…` : oneLine;
}

export function getPlan(cwd: string): PlanStep[] {
  ensureLoaded(cwd);
  return plans.get(cwd) ?? [];
}

function normalizeInput(step: StepInput): { text: string; activeForm?: string; dependsOn?: number[] } {
  if (typeof step === 'string') return { text: clean(step) };
  const text = clean(step.text);
  const activeForm = step.activeForm ? clean(step.activeForm) : undefined;
  const dependsOn = cleanDeps(step.dependsOn);
  return { text, ...(activeForm ? { activeForm } : {}), ...(dependsOn ? { dependsOn } : {}) };
}

/** Replace the whole plan with a fresh ordered step list (first step marked doing). */
export function setPlan(cwd: string, steps: StepInput[]): PlanStep[] {
  const cleaned = steps.map(normalizeInput).filter((s) => s.text).slice(0, MAX_STEPS);
  const next: PlanStep[] = cleaned.map((s, i) => ({ ...s, status: i === 0 ? 'doing' : 'todo' }));
  plans.set(cwd, next);
  loaded.add(cwd);
  markUpdated(cwd);
  persist(cwd);
  return next;
}

export function addStep(cwd: string, text: string, activeForm?: string): PlanStep[] {
  const list = getPlan(cwd).slice();
  const t = clean(text);
  const af = activeForm ? clean(activeForm) : undefined;
  if (t && list.length < MAX_STEPS) list.push({ text: t, status: 'todo', ...(af ? { activeForm: af } : {}) });
  plans.set(cwd, list);
  markUpdated(cwd);
  persist(cwd);
  return list;
}

/** Mark a step (1-based) doing. */
export function startStep(cwd: string, index: number): PlanStep[] {
  const list = getPlan(cwd).map((step) => (step.status === 'doing' ? { ...step, status: 'todo' as const } : step));
  const i = index - 1;
  if (i >= 0 && i < list.length) list[i] = { ...list[i]!, status: 'doing' };
  plans.set(cwd, list);
  markUpdated(cwd);
  persist(cwd);
  return list;
}

/** Mark a step (1-based) done and auto-advance the next todo to doing. */
export function completeStep(cwd: string, index: number): PlanStep[] {
  const list = getPlan(cwd).slice();
  const i = index - 1;
  if (i >= 0 && i < list.length) {
    list[i] = { ...list[i]!, status: 'done' };
    if (!list.some((s) => s.status === 'doing')) {
      const nextTodo = list.findIndex((s) => s.status === 'todo' && depsMet(s, list));
      if (nextTodo >= 0) list[nextTodo] = { ...list[nextTodo]!, status: 'doing' };
    }
  }
  plans.set(cwd, list);
  markUpdated(cwd);
  persist(cwd);
  return list;
}

export function clearPlan(cwd: string): void {
  plans.delete(cwd);
  turnsSinceUpdate.delete(cwd);
  loaded.add(cwd);
  writeToDisk(cwd, []);
}

export const MARK: Record<StepStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]' };
const DISPLAY_MARK: Record<DisplayStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]', blocked: '[!]' };

/** Label for a step: the present-continuous activeForm while it is running, else the imperative text. */
export function stepLabel(s: PlanStep): string {
  return s.status === 'doing' && s.activeForm ? s.activeForm : s.text;
}

/**
 * Render the `<active_plan>` block for the system prompt, or `''` when there is no plan.
 * Re-emitted every turn so the breakdown survives compaction and reload-into-summary.
 */
export function renderActivePlanAddendum(cwd: string): string {
  const list = getPlan(cwd);
  if (list.length === 0) return '';
  const done = list.filter((s) => s.status === 'done').length;
  const current = list.find((s) => s.status === 'doing') ?? list.find((s) => s.status === 'todo');
  const unfinished = list.some((s) => s.status !== 'done');
  const noneDoing = unfinished && !list.some((s) => s.status === 'doing');
  const stale = unfinished && (turnsSinceUpdate.get(cwd) ?? 0) >= STALE_PLAN_TURNS;
  const nudges: string[] = [];
  if (noneDoing) {
    nudges.push('note: no step is in progress — mark the next one with plan(start:N) so at least one step is always active.');
  }
  if (stale) {
    nudges.push(`note: this plan has not been updated in ${STALE_PLAN_TURNS}+ turns — advance it (plan start/complete) or clear it if the work is done or abandoned.`);
  }
  return [
    '<active_plan>',
    `Your current task breakdown (${done}/${list.length} done). Execute the next step, then update it via the plan tool (start/complete). Keep it proportional; clear it when the task is finished.`,
    ...list.map((s, i) => `${DISPLAY_MARK[displayStatus(s, list)]} ${i + 1}. ${s.text}${s.dependsOn?.length ? ` (needs ${s.dependsOn.join(',')})` : ''}`),
    current ? `next: ${stepLabel(current)}` : 'next: (all steps done — verify, then plan clear)',
    ...nudges,
    '</active_plan>',
  ].join('\n');
}
