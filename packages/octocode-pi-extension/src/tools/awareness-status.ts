/**
 * awareness-status — a live below-editor panel for the shared Awareness Lite state
 * (plans, tasks, verify debt, locks, manual work presence, and messages).
 *
 * Awareness is canonical SQLite behind the `npx @octocodeai/octocode-awareness-lite` CLI. Its
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
import { buildAwarenessLiteCommand } from '../assets.js';
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
  /** Compact summary of the most recent peer message (from→to: preview), when any. */
  lastMessage?: { from: string; to: string; preview: string };
}

/** Parse the Lite `message list` JSON, returning a compact summary of the newest message. */
export function parseLastMessage(json: string): AwarenessStatus['lastMessage'] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const list = Array.isArray(raw) ? raw : undefined;
  if (!list || list.length === 0) return undefined;
  // message list is newest-last or newest-first depending on the CLI; pick the one
  // with the greatest createdAt so the summary is deterministic.
  const newest = [...list].sort(
    (a, b) => Number((a as { createdAt?: number }).createdAt ?? 0) - Number((b as { createdAt?: number }).createdAt ?? 0),
  ).at(-1) as Record<string, unknown> | undefined;
  if (!newest) return undefined;
  const str = (k: string): string => (typeof newest[k] === 'string' ? (newest[k] as string) : '');
  const from = str('fromAgentId') || '?';
  const to = str('toAgentId') || 'all';
  const body = (str('text') || str('topic')).replace(/\s+/g, ' ').trim();
  return { from, to, preview: body.length > 48 ? `${body.slice(0, 47)}\u2026` : body };
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
  if (s.messageCount > 0) {
    tail.push(s.lastMessage
      ? `peer-msgs ${s.messageCount} (last ${s.lastMessage.from}→${s.lastMessage.to}: ${s.lastMessage.preview})`
      : `peer-msgs ${s.messageCount}`);
  }

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
export type StatusRunner = (cwd: string) => Promise<string | null>;

const defaultRunner: StatusRunner = (cwd) =>
  new Promise((resolve) => {
    const spec = buildAwarenessLiteCommand(['status', '--workspace', cwd]);
    execFile(
      spec.cmd,
      spec.args,
      { timeout: 4000, maxBuffer: 1_000_000 },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });

let runner: StatusRunner = defaultRunner;

/** Runs `message list` for the newest peer message; injectable for tests. */
export type MessageRunner = (cwd: string) => Promise<string | null>;
const defaultMessageRunner: MessageRunner = (cwd) =>
  new Promise((resolve) => {
    const spec = buildAwarenessLiteCommand(['message', 'list', '--workspace', cwd, '--limit', '1']);
    execFile(
      spec.cmd,
      spec.args,
      { timeout: 4000, maxBuffer: 1_000_000 },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
let messageRunner: MessageRunner = defaultMessageRunner;

/** Test hook: override the CLI runner. */
export function setAwarenessStatusRunnerForTests(fn: StatusRunner): void {
  runner = fn;
}
/** Test hook: override the message-list runner. */
export function setAwarenessMessageRunnerForTests(fn: MessageRunner): void {
  messageRunner = fn;
}
export function resetAwarenessStatusStateForTests(): void {
  runner = defaultRunner;
  messageRunner = defaultMessageRunner;
  cache.clear();
}

/**
 * Drop a workspace's cached status so the next refresh re-polls from scratch. Called on
 * session_start so a new session in a cwd visited earlier this process does not paint the
 * previous session's stale task/lock counts on its first frame.
 */
export function clearAwarenessCacheEntry(cwd: string): void {
  cache.delete(cwd);
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
  const cwd = ctx.cwd ?? process.cwd();
  const entry = cache.get(cwd) ?? { status: null, lastRunAt: 0, running: false };
  cache.set(cwd, entry);

  // Paint whatever we last knew so the panel is stable between refreshes.
  renderWidget(ctx, entry.status);

  const now = Date.now();
  if (entry.running || now - entry.lastRunAt < MIN_REFRESH_MS) return;
  entry.running = true;
  entry.lastRunAt = now;
  void runner(cwd)
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
      // Only spend a second CLI call for the last-message preview when there are
      // peer messages to summarize.
      if (parsed && parsed.messageCount > 0) {
        void messageRunner(cwd)
          .then((msgOut) => {
            if (msgOut === null || entry.status !== parsed) return;
            const last = parseLastMessage(msgOut);
            if (last) {
              entry.status = { ...parsed, lastMessage: last };
              renderWidget(ctx, entry.status);
            }
          })
          .catch(() => { /* best-effort preview; count already shown */ });
      }
    })
    .catch(() => {
      entry.running = false;
      entry.status = null;
      renderWidget(ctx, null);
    });
}
