/**
 * active-plan — a compaction-durable, session-scoped task breakdown.
 *
 * The think-first "task breakdown gate" tells the agent to decompose non-trivial work into
 * explicit steps. Historically that breakdown lived only in the model's prose, so it was
 * lossy across compaction (plan-amnesia). This module gives it a real home:
 *   - an in-memory per-session step list (survives compaction — same process)
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
export type PlanLifecycle = 'draft' | 'active';

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

/** A recorded planning decision — the question asked in the clarify phase and the answer chosen. */
export interface PlanDecision {
  /** The question / choice point. */
  q: string;
  /** The resolved answer (chosen option label, or the free-text reply). */
  a: string;
}

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

/** The planning flow phases, in order — shared by the panel stepper and the browser timeline. */
export const PLAN_PHASES = ['Research', 'RFC', 'Approve', 'Build', 'Verify'] as const;

/**
 * Which flow phase a plan is in, from its step state alone: Verify once every
 * step is done, Build once any step is in-flight, else Approve (steps exist but
 * none started). Research/RFC read as done because the steps were derived from
 * them. Returns an index into PLAN_PHASES.
 */
export function planPhaseIndex(steps: PlanStep[]): number {
  if (steps.length === 0) return 2;
  const done = steps.filter((s) => s.status === 'done').length;
  if (done === steps.length) return 4; // Verify
  if (steps.some((s) => s.status === 'doing' || s.status === 'done')) return 3; // Build
  return 2; // Approve
}

const MAX_STEPS = 40;
const MAX_STEP_CHARS = 160;
const MAX_DECISIONS = 20;
const MAX_DECISION_CHARS = 300;

// Keyed by session scope (cwd + Pi session file when available). Module-scoped
// in-memory cache; backed by disk so the plan survives compaction and process
// restart of the same session without leaking into a fresh session in the same cwd.
const plans = new Map<string, PlanStep[]>();
// Draft plans are reviewable but deliberately have no doing step until the user
// approves them. Legacy persisted plans without this field are treated as active.
const planLifecycle = new Map<string, PlanLifecycle>();
// Plan-level RFC association (scope → absolute RFC.md path). Set once the plan
// is derived from an accepted RFC; the plan surface renders that document and
// the enforcement gate requires it for consequential work. Kept beside `plans`
// so it travels with the same persistence + branch-adoption path.
const planRfc = new Map<string, string>();
// Plan-level decision log (scope → {q,a}[]): the clarify-phase interview answers
// and any gate justifications. Durable rationale for the plan — persisted and
// branch-adopted with the same pattern as `planRfc`.
const planDecisions = new Map<string, PlanDecision[]>();
const loaded = new Set<string>();

export interface ActivePlanContext {
  cwd?: string;
  sessionManager?: { getSessionFile?(): string | undefined };
}

export function activePlanScope(ctx?: ActivePlanContext): string {
  const cwd = ctx?.cwd ?? process.cwd();
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  return sessionFile ? `${cwd}\0${sessionFile}` : cwd;
}

function planFile(scope: string): string {
  const hash = createHash('sha256').update(scope).digest('hex').slice(0, 16);
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

/** Extract a stored rfcPath (absolute string) from a persisted/snapshot record, if present. */
function readRfcFromStored(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const val = (raw as Record<string, unknown>).rfcPath;
  return typeof val === 'string' && val.trim() ? val : undefined;
}

/** Extract a validated decision log from a persisted/snapshot record, if present. */
function readDecisionsFromStored(raw: unknown): PlanDecision[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const arr = (raw as Record<string, unknown>).decisions;
  if (!Array.isArray(arr)) return undefined;
  const out: PlanDecision[] = [];
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    const rec = d as Record<string, unknown>;
    const q = typeof rec.q === 'string' ? cleanDecision(rec.q) : '';
    const a = typeof rec.a === 'string' ? cleanDecision(rec.a) : '';
    if (!q || !a) continue;
    out.push({ q, a });
    if (out.length >= MAX_DECISIONS) break;
  }
  return out.length ? out : undefined;
}

function readLifecycleFromStored(raw: unknown): PlanLifecycle {
  if (!raw || typeof raw !== 'object') return 'active';
  return (raw as Record<string, unknown>).lifecycle === 'draft' ? 'draft' : 'active';
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

/** Read just the persisted rfcPath for a workspace, bypassing the in-memory cache. */
function readRfcFromDisk(cwd: string): string | undefined {
  try {
    const file = planFile(cwd);
    if (!fs.existsSync(file)) return undefined;
    return readRfcFromStored(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Read just the persisted decision log for a workspace, bypassing the in-memory cache. */
function readDecisionsFromDisk(cwd: string): PlanDecision[] | undefined {
  try {
    const file = planFile(cwd);
    if (!fs.existsSync(file)) return undefined;
    return readDecisionsFromStored(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

function readLifecycleFromDisk(cwd: string): PlanLifecycle | undefined {
  try {
    const file = planFile(cwd);
    if (!fs.existsSync(file)) return undefined;
    return readLifecycleFromStored(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Atomically persist (or delete when empty) the plan for a workspace. Never throws. */
function writeToDisk(cwd: string, steps: PlanStep[]): void {
  try {
    const file = planFile(cwd);
    // The plan is the primary record — no steps means no plan, so drop the file
    // (and with it any lingering rfcPath) rather than persisting a stepless doc.
    if (steps.length === 0) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lifecycle = planLifecycle.get(cwd) ?? 'active';
    const rfcPath = planRfc.get(cwd);
    const decisions = planDecisions.get(cwd);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, scope: cwd, steps, lifecycle, ...(rfcPath ? { rfcPath } : {}), ...(decisions && decisions.length ? { decisions } : {}), updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, file);
  } catch {
    // Persistence is best-effort; degrade to in-memory.
  }
}

/** Lazily hydrate the in-memory plan (and its rfcPath) from disk once per workspace per process. */
function ensureLoaded(cwd: string): void {
  if (loaded.has(cwd)) return;
  loaded.add(cwd);
  if (plans.has(cwd)) return;
  const disk = readFromDisk(cwd);
  if (disk.length > 0) {
    plans.set(cwd, disk);
    planLifecycle.set(cwd, readLifecycleFromDisk(cwd) ?? 'active');
    const rfcPath = readRfcFromDisk(cwd);
    if (rfcPath) planRfc.set(cwd, rfcPath);
    const decisions = readDecisionsFromDisk(cwd);
    if (decisions) planDecisions.set(cwd, decisions);
  }
}

// ─── Branch/fork-correct persistence (pi appendEntry pattern) ─────────────────
//
// Pi's guidance: extension state belongs in session entries so /fork and /tree
// roll it back with the conversation. Disk persistence alone is branch-blind —
// a fork keeps the forked-from plan forever. So every mutation ALSO appends an
// `octocode-plan` CustomEntry snapshot (state channel, never in LLM context)
// via the appender wired in index.ts, and session_start / session_tree re-adopt
// the last snapshot found on the current branch.

/** customType of the plan-snapshot session entries. */
export const PLAN_ENTRY_TYPE = 'octocode-plan';

let planEntryAppender: ((steps: PlanStep[], rfcPath?: string, decisions?: PlanDecision[], lifecycle?: PlanLifecycle) => void) | null = null;

/** Wire (or clear) the host-side appender that snapshots plans into session entries. */
export function setPlanEntryAppender(appender: ((steps: PlanStep[], rfcPath?: string, decisions?: PlanDecision[], lifecycle?: PlanLifecycle) => void) | null): void {
  planEntryAppender = appender;
}

function appendPlanEntry(steps: PlanStep[], rfcPath?: string, decisions?: PlanDecision[], lifecycle?: PlanLifecycle): void {
  try {
    planEntryAppender?.(steps, rfcPath, decisions, lifecycle);
  } catch {
    // Session-entry snapshots are best-effort; disk persistence still holds.
  }
}

/**
 * Adopt the newest plan snapshot found in the session branch (root→leaf).
 * Returns false — leaving current state untouched — when the branch carries no
 * snapshot at all (sessions predating this feature). Adoption is
 * reconciliation, not a mutation: it never re-appends a session entry.
 */
export function adoptPlanFromBranch(cwd: string, branchEntries: unknown[]): boolean {
  for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
    const entry = branchEntries[i];
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (rec.type !== 'custom' || rec.customType !== PLAN_ENTRY_TYPE) continue;
    const steps = sanitizeStored(rec.data);
    const lifecycle = readLifecycleFromStored(rec.data);
    const rfcPath = readRfcFromStored(rec.data);
    const decisions = readDecisionsFromStored(rec.data);
    if (steps.length === 0) {
      plans.delete(cwd);
      planLifecycle.delete(cwd);
      planRfc.delete(cwd);
      planDecisions.delete(cwd);
    } else {
      plans.set(cwd, steps);
      planLifecycle.set(cwd, lifecycle);
      // The RFC link and decision log are part of the plan snapshot, so a
      // fork/tree jump restores (or clears) them in lockstep with the steps
      // rather than leaking a stale RFC or decisions from another branch.
      if (rfcPath) planRfc.set(cwd, rfcPath);
      else planRfc.delete(cwd);
      if (decisions) planDecisions.set(cwd, decisions);
      else planDecisions.delete(cwd);
    }
    loaded.add(cwd);
    turnsSinceUpdate.set(cwd, 0);
    writeToDisk(cwd, steps);
    return true;
  }
  return false;
}

/** Persist the current in-memory plan for a workspace. */
function persist(cwd: string): void {
  const steps = plans.get(cwd) ?? [];
  writeToDisk(cwd, steps);
  appendPlanEntry(steps, planRfc.get(cwd), planDecisions.get(cwd), planLifecycle.get(cwd) ?? 'active');
}

/** Test hook: read the persisted plan straight from disk, bypassing the in-memory cache. */
export function readPersistedPlanForTests(cwd: string): PlanStep[] {
  return readFromDisk(cwd);
}

/** Test hook: read the persisted rfcPath straight from disk, bypassing the in-memory cache. */
export function readPersistedRfcForTests(cwd: string): string | undefined {
  return readRfcFromDisk(cwd);
}

/** Test hook: read the persisted decision log straight from disk, bypassing the in-memory cache. */
export function readPersistedDecisionsForTests(cwd: string): PlanDecision[] | undefined {
  return readDecisionsFromDisk(cwd);
}

/** Test hook: read the persisted lifecycle straight from disk. */
export function readPersistedLifecycleForTests(cwd: string): PlanLifecycle | undefined {
  return readLifecycleFromDisk(cwd);
}

// ─── Plan ↔ RFC association ───────────────────────────────────────────────────

/** The absolute RFC.md path this plan was derived from, if any. */
export function getPlanRfc(cwd: string): string | undefined {
  ensureLoaded(cwd);
  return planRfc.get(cwd);
}

/**
 * Associate (or clear, with `undefined`) the RFC document this plan derives from.
 * Persisted alongside the steps so the plan surface can render the RFC and the
 * enforcement gate can require it. No-op persistence when there is no plan yet —
 * the RFC link is meaningless without steps and the stepless disk file is dropped.
 */
export function setPlanRfc(cwd: string, rfcPath: string | undefined): void {
  ensureLoaded(cwd);
  if (rfcPath && rfcPath.trim()) planRfc.set(cwd, rfcPath.trim());
  else planRfc.delete(cwd);
  persist(cwd);
}

// ─── Decision log ─────────────────────────────────────────────────────────────

/** The recorded clarify-phase decisions for this plan (question → answer). */
export function getPlanDecisions(cwd: string): PlanDecision[] {
  ensureLoaded(cwd);
  return planDecisions.get(cwd) ?? [];
}

/** Append one decision (question → answer). Ignored when either side is empty. Persists. */
export function addPlanDecision(cwd: string, q: string, a: string): PlanDecision[] {
  ensureLoaded(cwd);
  const cq = cleanDecision(q);
  const ca = cleanDecision(a);
  if (cq && ca) {
    const list = (planDecisions.get(cwd) ?? []).slice();
    list.push({ q: cq, a: ca });
    planDecisions.set(cwd, list.slice(0, MAX_DECISIONS));
    persist(cwd);
  }
  return planDecisions.get(cwd) ?? [];
}

/** Replace the whole decision log (or clear with []/undefined). Persists. */
export function setPlanDecisions(cwd: string, decisions: PlanDecision[] | undefined): PlanDecision[] {
  ensureLoaded(cwd);
  const cleaned = (decisions ?? [])
    .map((d) => ({ q: cleanDecision(d?.q ?? ''), a: cleanDecision(d?.a ?? '') }))
    .filter((d) => d.q && d.a)
    .slice(0, MAX_DECISIONS);
  if (cleaned.length) planDecisions.set(cwd, cleaned);
  else planDecisions.delete(cwd);
  persist(cwd);
  return planDecisions.get(cwd) ?? [];
}

export interface RfcResolution {
  /** Absolute path to the resolved RFC.md, present only when ok. */
  path?: string;
  /** Human-readable reason the input could not be resolved, present only when not ok. */
  error?: string;
}

/**
 * Resolve a user/agent-supplied RFC reference against a workspace, enforcing that
 * it lands on an existing file inside `<workspace>/.octocode/rfc/`. Accepts either
 * a directory (→ its `RFC.md`) or a Markdown file path (absolute or relative to
 * the workspace). Guards against path traversal and symlink escape so the plan
 * surface never reads — nor the local server ever exposes — a file outside the
 * workspace's RFC tree. Pure: touches only the filesystem, never the plan maps.
 */
export function resolveRfcPath(workspace: string, input: string): RfcResolution {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'no RFC path given' };
  const rfcRoot = path.resolve(workspace, '.octocode', 'rfc');
  try {
    let candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      return { error: `no such RFC path: ${raw}` };
    }
    if (stat.isDirectory()) candidate = path.join(candidate, 'RFC.md');
    // Resolve symlinks before the containment check so a symlinked file cannot
    // point outside the RFC tree while appearing to live inside it.
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return { error: `no such RFC file: ${path.relative(workspace, candidate) || candidate}` };
    }
    const realRoot = fs.existsSync(rfcRoot) ? fs.realpathSync(rfcRoot) : rfcRoot;
    const withinRoot = real === realRoot || real.startsWith(realRoot + path.sep);
    if (!withinRoot) {
      return { error: `RFC must live under .octocode/rfc/ (got ${raw})` };
    }
    if (!fs.statSync(real).isFile()) {
      return { error: `RFC path is not a file: ${raw}` };
    }
    return { path: real };
  } catch (err) {
    return { error: `could not resolve RFC path: ${(err as Error).message}` };
  }
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

/** Collapse + cap decision text (longer budget than a step — a decision can carry a short rationale). */
function cleanDecision(text: string): string {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DECISION_CHARS ? `${oneLine.slice(0, MAX_DECISION_CHARS - 1)}…` : oneLine;
}

export function getPlan(cwd: string): PlanStep[] {
  ensureLoaded(cwd);
  return plans.get(cwd) ?? [];
}

export function getPlanLifecycle(cwd: string): PlanLifecycle {
  ensureLoaded(cwd);
  return planLifecycle.get(cwd) ?? 'active';
}

/** Promote an approved draft and start its first runnable step. */
export function activatePlan(cwd: string): PlanStep[] {
  const list = getPlan(cwd).slice();
  if (list.length > 0 && !list.some((step) => step.status === 'doing')) {
    const next = list.findIndex((step) => step.status === 'todo' && depsMet(step, list));
    if (next >= 0) list[next] = { ...list[next]!, status: 'doing' };
  }
  plans.set(cwd, list);
  planLifecycle.set(cwd, 'active');
  markUpdated(cwd);
  persist(cwd);
  return list;
}

/**
 * Whether the scope has an actively owned in-progress step. Auto-compaction uses
 * this stricter signal so stale todo/blocked plan state after a finished turn
 * cannot trigger a surprise compaction; it should fire only while work is live.
 */
export function hasActivePlanWork(cwd: string): boolean {
  return getPlan(cwd).some((step) => step.status === 'doing');
}

function normalizeInput(step: StepInput): { text: string; activeForm?: string; dependsOn?: number[] } {
  if (typeof step === 'string') return { text: clean(step) };
  const text = clean(step.text);
  const activeForm = step.activeForm ? clean(step.activeForm) : undefined;
  const dependsOn = cleanDeps(step.dependsOn);
  return { text, ...(activeForm ? { activeForm } : {}), ...(dependsOn ? { dependsOn } : {}) };
}

/** Replace the whole plan; drafts remain entirely todo until activatePlan records approval. */
export function setPlan(cwd: string, steps: StepInput[], lifecycle: PlanLifecycle = 'active'): PlanStep[] {
  const cleaned = steps.map(normalizeInput).filter((s) => s.text).slice(0, MAX_STEPS);
  const next: PlanStep[] = cleaned.map((s, i) => ({ ...s, status: lifecycle === 'active' && i === 0 ? 'doing' : 'todo' }));
  plans.set(cwd, next);
  planLifecycle.set(cwd, lifecycle);
  loaded.add(cwd);
  markUpdated(cwd);
  persist(cwd);
  return next;
}

export function addStep(cwd: string, text: string, activeForm?: string, dependsOn?: number[]): PlanStep[] {
  const list = getPlan(cwd).slice();
  const t = clean(text);
  const af = activeForm ? clean(activeForm) : undefined;
  const deps = cleanDeps(dependsOn);
  if (t && list.length < MAX_STEPS) {
    list.push({ text: t, status: 'todo', ...(af ? { activeForm: af } : {}), ...(deps ? { dependsOn: deps } : {}) });
  }
  plans.set(cwd, list);
  markUpdated(cwd);
  persist(cwd);
  return list;
}

/**
 * Mark a step (1-based) doing.
 *
 * Starting a second runnable step intentionally does NOT demote an existing
 * doing step: independent plan lanes can run in parallel (for example, a
 * parent edit plus a read-only subagent verification lane). Callers that need
 * serial execution should complete the active step before starting the next one.
 */
export function startStep(cwd: string, index: number): PlanStep[] {
  const list = getPlan(cwd).slice();
  if (getPlanLifecycle(cwd) === 'draft') return list;
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
  if (getPlanLifecycle(cwd) === 'draft') return list;
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

/**
 * Remove a step (1-based). Dependencies are kept consistent: deps on the
 * removed step are dropped, deps pointing past it are renumbered. If the
 * removed step was the only active one, the next satisfiable todo auto-advances so
 * the plan always has active work while unfinished steps remain.
 */
export function removeStep(cwd: string, index: number): PlanStep[] {
  const list = getPlan(cwd).slice();
  const i = index - 1;
  if (i < 0 || i >= list.length) return list;
  list.splice(i, 1);
  const next = list.map((step) => {
    if (!step.dependsOn) return step;
    const deps = step.dependsOn.filter((d) => d !== index).map((d) => (d > index ? d - 1 : d));
    const { dependsOn: _dropped, ...rest } = step;
    return deps.length ? { ...rest, dependsOn: deps } : rest;
  });
  if (getPlanLifecycle(cwd) === 'active' && next.length > 0 && !next.some((s) => s.status === 'doing')) {
    const nextTodo = next.findIndex((s) => s.status === 'todo' && depsMet(s, next));
    if (nextTodo >= 0) next[nextTodo] = { ...next[nextTodo]!, status: 'doing' };
  }
  plans.set(cwd, next);
  markUpdated(cwd);
  persist(cwd);
  return next;
}

export function clearPlan(cwd: string): void {
  plans.delete(cwd);
  planLifecycle.delete(cwd);
  planRfc.delete(cwd);
  planDecisions.delete(cwd);
  turnsSinceUpdate.delete(cwd);
  loaded.add(cwd);
  writeToDisk(cwd, []);
  // Snapshot the cleared state too: a fork taken after clear must start clean.
  appendPlanEntry([]);
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
  if (getPlanLifecycle(cwd) === 'draft') {
    return [
      '<active_plan>',
      `This proposed task breakdown is awaiting user approval (0/${list.length} done). Do not execute or start any step until activatePlan records approval.`,
      ...list.map((s, i) => `${DISPLAY_MARK[displayStatus(s, list)]} ${i + 1}. ${s.text}${s.dependsOn?.length ? ` (needs ${s.dependsOn.join(',')})` : ''}`),
      'next: awaiting user approval',
      '</active_plan>',
    ].join('\n');
  }
  const done = list.filter((s) => s.status === 'done').length;
  const doing = list.filter((s) => s.status === 'doing');
  const current = doing[0] ?? list.find((s) => s.status === 'todo');
  const runnableTodos = list
    .map((s, i) => ({ step: s, index: i + 1 }))
    .filter(({ step }) => step.status === 'todo' && depsMet(step, list));
  const unfinished = list.some((s) => s.status !== 'done');
  const noneDoing = unfinished && doing.length === 0;
  const stale = unfinished && (turnsSinceUpdate.get(cwd) ?? 0) >= STALE_PLAN_TURNS;
  const nudges: string[] = [];
  if (noneDoing) {
    nudges.push('note: no step is in progress — mark the next runnable step with plan(start:N) so unfinished work has an active owner.');
  }
  if (runnableTodos.length > 0 && doing.length > 0) {
    nudges.push(`parallel-ready: ${runnableTodos.map(({ step, index }) => `${index}. ${stepLabel(step)}`).join(' | ')} — start independent lanes with plan(start:N) before spawning/batching, or leave them todo if they depend on the current decision.`);
  }
  if (stale) {
    nudges.push(`note: this plan has not been updated in ${STALE_PLAN_TURNS}+ turns — advance it (plan start/complete), add/remove changed scope, or clear it if the work is done or abandoned.`);
  }
  const nextLine = doing.length > 1
    ? `now: ${doing.map(stepLabel).join(' | ')}`
    : current ? `next: ${stepLabel(current)}` : 'next: (all steps done — verify, then plan clear)';
  return [
    '<active_plan>',
    `Your current task breakdown (${done}/${list.length} done). Execute active steps, start any independent parallel lanes with plan(start:N), then update it via the plan tool (start/complete/add/remove). Keep it proportional; clear it when the task is finished.`,
    ...list.map((s, i) => `${DISPLAY_MARK[displayStatus(s, list)]} ${i + 1}. ${s.text}${s.dependsOn?.length ? ` (needs ${s.dependsOn.join(',')})` : ''}`),
    nextLine,
    ...nudges,
    '</active_plan>',
  ].join('\n');
}
