/**
 * awareness-status — a live below-editor panel for the shared Awareness Lite state
 * (plans, tasks, verify debt, locks, manual work presence, and messages).
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
import { paint } from '../tui/cli-design.js';
import { refreshStatusPanel } from './status-panel.js';

export interface AwarenessStatus {
  activePlans: number;
  readyTasks: number;
  inProgressTasks: number;
  verifyTasks: number;
  lockCount: number;
  workCount: number;
  agentCount: number;
  messageCount: number;
}

/** Parse the Lite `status` JSON into the fields the panel needs. Null on bad input. */
export function parseAwarenessStatus(json: string): AwarenessStatus | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const num = (key: string): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    activePlans: raw['activePlans'] === undefined ? num('plans') : num('activePlans'),
    readyTasks: raw['readyTasks'] === undefined ? num('tasks') : num('readyTasks'),
    inProgressTasks: num('inProgressTasks'),
    verifyTasks: raw['verifyTasks'] === undefined ? num('pendingChecks') : num('verifyTasks'),
    lockCount: num('locks'),
    workCount: num('work'),
    agentCount: num('agents'),
    messageCount: num('messages'),
  };
}

/** True when there is any shared state worth showing a panel for. */
export function hasAwarenessSignal(s: AwarenessStatus): boolean {
  return (
    s.activePlans > 0 ||
    s.readyTasks > 0 ||
    s.inProgressTasks > 0 ||
    s.verifyTasks > 0 ||
    s.lockCount > 0 ||
    s.workCount > 0 ||
    s.agentCount > 0 ||
    s.messageCount > 0
  );
}

/** Build the below-editor Awareness panel lines. Empty array when there is nothing to show. */
export function formatAwarenessPanel(s: AwarenessStatus, theme?: PiTheme): string[] {
  if (!hasAwarenessSignal(s)) return [];
  const debt = s.verifyTasks;
  const segs: string[] = [];
  if (s.activePlans > 0) segs.push(`plans ${s.activePlans}`);
  if (s.readyTasks > 0) segs.push(`ready ${s.readyTasks}`);
  if (s.inProgressTasks > 0) segs.push(`doing ${s.inProgressTasks}`);

  const tail: string[] = [];
  if (s.lockCount > 0) tail.push(`locks ${s.lockCount}`);
  if (s.workCount > 0) tail.push(`work ${s.workCount}`);
  if (s.messageCount > 0) tail.push(`msgs ${s.messageCount}`);

  const chunks: string[] = [];
  if (segs.length) chunks.push(paint(theme, 'brand', segs.join('  ·  ')));
  if (tail.length) chunks.push(paint(theme, 'muted', tail.join('  ·  ')));
  if (debt > 0) chunks.push(paint(theme, 'warning', `verify-debt ${debt}`));
  if (chunks.length === 0) return [];
  return [`${paint(theme, 'title', 'Awareness')}  ${chunks.join('  ·  ')}`];
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

/** Return the last cached Awareness status for command dashboards. */
export function getCachedAwarenessStatus(cwd: string): AwarenessStatus | null {
  return cache.get(cwd)?.status ?? null;
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
      [cliPath, 'status', '--workspace', cwd],
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
export function forceAwarenessStatusRefreshForTests(cwd: string): void {
  const entry = cache.get(cwd);
  if (entry) entry.lastRunAt = 0;
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
// Set during session_shutdown so the async CLI refresh completing after the
// widget was cleared cannot re-create it in the replaced session.
let panelSuppressed = false;
export function suppressAwarenessPanel(): void {
  panelSuppressed = true;
}
export function resumeAwarenessPanel(): void {
  panelSuppressed = false;
}

export function refreshAwarenessPanel(ctx?: PiContext): void {
  if (!ctx?.hasUI || panelSuppressed) return;
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
      if (stdout === null) {
        entry.status = null;
        renderWidget(ctx, null);
        return;
      }
      const parsed = parseAwarenessStatus(stdout);
      entry.status = parsed;
      renderWidget(ctx, parsed);
    })
    .catch(() => {
      entry.running = false;
      entry.status = null;
      renderWidget(ctx, null);
    });
}
