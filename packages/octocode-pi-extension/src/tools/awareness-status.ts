/**
 * awareness-status — a live below-editor panel for the shared Awareness state
 * (plans, tasks, verify debt, refinements, locks).
 *
 * Awareness is canonical SQLite behind the `$OCTOCODE_AWARENESS_CLI` binary. Its
 * state previously only surfaced in chat when the agent ran a CLI command; this
 * module projects it into a persistent under-input panel instead.
 *
 * Design:
 *   - `parseAwarenessStatus` / `formatAwarenessPanel` are pure + unit-tested.
 *   - `refreshAwarenessPanel` runs the CLI ASYNC + THROTTLED (never blocks a
 *     turn), caches the last result per workspace, and renders the widget.
 *   - Any failure degrades silently (no panel, never throws) — Awareness being
 *     unavailable must never break the agent.
 */

import { execFile } from 'node:child_process';
import type { PiContext, PiTheme } from '../types.js';
import { refreshStatusPanel } from './status-panel.js';

export interface AwarenessStatus {
  activePlans: number;
  readyTasks: number;
  inProgressTasks: number;
  verifyTasks: number;
  pendingRuns: number;
  /** Refinements that actually need action (drives the panel); openRefinements is informational. */
  actionableRefinements: number;
  openRefinements: number;
  lockCount: number;
}

/** Parse the `workspace status --compact` JSON into the fields the panel needs. Null on bad input. */
export function parseAwarenessStatus(json: string): AwarenessStatus | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || raw.ok !== true) return null;
  const num = (key: string): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    activePlans: num('active_plans'),
    readyTasks: num('ready_tasks'),
    inProgressTasks: num('in_progress_tasks'),
    verifyTasks: num('verify_tasks'),
    pendingRuns: num('pending_runs'),
    actionableRefinements: num('actionable_refinements'),
    openRefinements: num('all_open_refinements'),
    lockCount: num('lock_count'),
  };
}

/** True when there is any shared state worth showing a panel for. */
export function hasAwarenessSignal(s: AwarenessStatus): boolean {
  return (
    s.activePlans > 0 ||
    s.readyTasks > 0 ||
    s.inProgressTasks > 0 ||
    s.verifyTasks > 0 ||
    s.pendingRuns > 0 ||
    s.actionableRefinements > 0 ||
    s.lockCount > 0
  );
}

/** Build the below-editor Awareness panel lines. Empty array when there is nothing to show. */
export function formatAwarenessPanel(s: AwarenessStatus, theme?: PiTheme): string[] {
  if (!hasAwarenessSignal(s)) return [];
  const paint = (token: string, text: string): string => theme?.fg(token, text) ?? text;
  const debt = s.verifyTasks + s.pendingRuns;
  const segs: string[] = [];
  if (s.activePlans > 0) segs.push(`plans ${s.activePlans}`);
  if (s.readyTasks > 0) segs.push(`ready ${s.readyTasks}`);
  if (s.inProgressTasks > 0) segs.push(`doing ${s.inProgressTasks}`);

  const tail: string[] = [];
  if (s.actionableRefinements > 0) tail.push(`refine ${s.actionableRefinements}`);
  if (s.lockCount > 0) tail.push(`locks ${s.lockCount}`);

  const chunks: string[] = [];
  if (segs.length) chunks.push(paint('accent', segs.join('  ·  ')));
  if (tail.length) chunks.push(paint('muted', tail.join('  ·  ')));
  if (debt > 0) chunks.push(paint('warning', `verify-debt ${debt}`));
  if (chunks.length === 0) return [];
  return [`${paint('toolTitle', 'Awareness')}  ${chunks.join('  ·  ')}`];
}

// ─── Async, throttled refresh ────────────────────────────────────────────────

const MIN_REFRESH_MS = 8000;

/** The Awareness section lines for the unified panel, from the cached status (empty when none). */
export function awarenessPanelLines(cwd: string, theme?: PiTheme): string[] {
  const status = cache.get(cwd)?.status;
  return status ? formatAwarenessPanel(status, theme) : [];
}

/** Whether the cached Awareness status has anything worth showing for this workspace. */
export function hasCachedAwarenessSignal(cwd: string): boolean {
  const status = cache.get(cwd)?.status;
  return status ? hasAwarenessSignal(status) : false;
}

interface CacheEntry {
  status: AwarenessStatus | null;
  lastRunAt: number;
  running: boolean;
}
const cache = new Map<string, CacheEntry>();

/** Runs the awareness CLI; injectable for tests. Resolves stdout or null on any failure. */
export type StatusRunner = (cliPath: string, cwd: string) => Promise<string | null>;

const defaultRunner: StatusRunner = (cliPath, cwd) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, 'workspace', 'status', '--workspace', cwd, '--compact'],
      { timeout: 4000, maxBuffer: 1_000_000 },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });

let runner: StatusRunner = defaultRunner;
/** Test hook: override the CLI runner. */
export function setAwarenessStatusRunnerForTests(fn: StatusRunner): void {
  runner = fn;
}
export function resetAwarenessStatusStateForTests(): void {
  runner = defaultRunner;
  cache.clear();
}

function renderWidget(ctx: PiContext, _status: AwarenessStatus | null): void {
  // The Awareness section is composed by the unified status panel from the cached status.
  refreshStatusPanel(ctx);
}

/**
 * Refresh the Awareness panel: throttled + async. Renders the cached status
 * immediately (if any) and kicks off a background refresh at most every
 * MIN_REFRESH_MS. Never blocks the turn; never throws.
 */
export function refreshAwarenessPanel(ctx?: PiContext): void {
  if (!ctx?.hasUI) return;
  const cliPath = process.env.OCTOCODE_AWARENESS_CLI;
  if (!cliPath) return;
  const cwd = ctx.cwd ?? process.cwd();
  const entry = cache.get(cwd) ?? { status: null, lastRunAt: 0, running: false };
  cache.set(cwd, entry);

  // Paint whatever we last knew so the panel is stable between refreshes.
  renderWidget(ctx, entry.status);

  const now = Date.now();
  if (entry.running || now - entry.lastRunAt < MIN_REFRESH_MS) return;
  entry.running = true;
  entry.lastRunAt = now;
  void runner(cliPath, cwd)
    .then((stdout) => {
      entry.running = false;
      if (stdout === null) return;
      const parsed = parseAwarenessStatus(stdout);
      if (parsed) {
        entry.status = parsed;
        renderWidget(ctx, parsed);
      }
    })
    .catch(() => {
      entry.running = false;
    });
}
