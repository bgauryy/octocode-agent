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

import { runAwarenessLiteInProcess } from '../assets.js';
import type { PiContext, PiTheme } from '../types.js';
import { paint } from '../tui/cli-design.js';
import { SEP_WIDE } from '../tui/palette.js';
import { renderInlineRows, type InlineSegment } from '../tui/components.js';
import { truncateToWidth } from './render-helpers.js';
import { refreshStatusPanel } from './status-panel.js';
import { capMapSize } from '../utils.js';

export interface AwarenessTaskActivity {
  taskId: string;
  title: string;
  state: 'doing' | 'ready';
  agentId?: string;
}

export interface AwarenessStatus {
  activePlans: number;
  readyTasks: number;
  inProgressTasks: number;
  verifyTasks: number;
  lockCount: number;
  workCount: number;
  agentCount: number;
  messageCount: number;
  /** Concrete actionable tasks, ordered doing then ready. */
  taskActivities?: AwarenessTaskActivity[];
  /** Compact summary of the most recent peer message (from→to: preview), when any. */
  lastMessage?: { from: string; to: string; preview: string };
  /** Unread messages addressed to THIS session's agent id (message inbox). */
  unreadInbox?: number;
  /** Preview of the newest unread inbound message, when any. */
  lastInbound?: { from: string; preview: string };
}

function parseTaskList(json: string, state: AwarenessTaskActivity['state']): AwarenessTaskActivity[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): AwarenessTaskActivity[] => {
    if (!value || typeof value !== 'object') return [];
    const task = value as Record<string, unknown>;
    const taskId = typeof task['taskId'] === 'string' ? task['taskId'].trim() : '';
    const title = typeof task['title'] === 'string' ? task['title'].replace(/\s+/g, ' ').trim() : '';
    if (!taskId || !title) return [];
    const agentId = typeof task['agentId'] === 'string' && task['agentId'].trim() ? task['agentId'].trim() : undefined;
    return [{ taskId, title, state, ...(agentId ? { agentId } : {}) }];
  });
}

/** Parse claimed + ready task arrays into a doing-first, de-duplicated activity list. */
export function parseTaskActivities(claimedJson: string, readyJson: string): AwarenessTaskActivity[] {
  const seen = new Set<string>();
  return [...parseTaskList(claimedJson, 'doing'), ...parseTaskList(readyJson, 'ready')]
    .filter((task) => !seen.has(task.taskId) && Boolean(seen.add(task.taskId)));
}

/** Parse the Lite `message inbox` JSON for this agent: unread count + newest preview. */
export function parseInbox(json: string): { unread: number; lastInbound?: AwarenessStatus['lastInbound'] } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { unread: 0 };
  }
  const list = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  const unread = list.filter((m) => m && m['readAt'] == null);
  if (unread.length === 0) return { unread: 0 };
  const newest = [...unread].sort(
    (a, b) => (Date.parse(String(a['createdAt'] ?? '')) || 0) - (Date.parse(String(b['createdAt'] ?? '')) || 0),
  ).at(-1)!;
  const from = typeof newest['fromAgentId'] === 'string' ? (newest['fromAgentId'] as string) : '?';
  const body = String(newest['text'] ?? newest['topic'] ?? '').replace(/\s+/g, ' ').trim();
  return {
    unread: unread.length,
    lastInbound: { from, preview: body.length > 48 ? `${body.slice(0, 47)}…` : body },
  };
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
  // createdAt is an ISO-8601 string — Date.parse it (Number() would be NaN and
  // silently turn this into a no-op sort).
  const newest = [...list].sort(
    (a, b) => (Date.parse(String((a as { createdAt?: string }).createdAt ?? '')) || 0)
      - (Date.parse(String((b as { createdAt?: string }).createdAt ?? '')) || 0),
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
    activePlans: num('activePlans'),
    readyTasks: num('readyTasks'),
    inProgressTasks: num('inProgressTasks'),
    verifyTasks: num('verifyTasks'),
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
    s.messageCount > 0 ||
    (s.taskActivities?.length ?? 0) > 0
  );
}

/**
 * Build the compact `<awareness_signal>` text block for the unread peer-message count.
 *
 * NOT injected into the frozen system prompt — the count varies between sessions and
 * busts the provider prompt cache (~30k tokens re-billed per miss). The static
 * `<awareness>` section in SYSTEM_PROMPT.md already instructs the model to check
 * inbox when peer coordination may affect the next action; the TUI panel surfaces
 * the live count visually via `formatAwarenessPanel`.
 *
 * Kept as an exported utility in case a future non-frozen injection surface is added.
 */
export function renderAwarenessSignalAddendum(
  s: AwarenessStatus | null,
  _currentAgentId?: string,
): string {
  const unread = s?.unreadInbox ?? 0;
  if (unread === 0) return '';
  return [
    '<awareness_signal>',
    `Unread direct peer messages: ${unread}.`,
    'Use message inbox only when the peer input can change the current action. Message bodies are not injected here. Do not perform status polling or start/finish ceremony.',
    '</awareness_signal>',
  ].join('\n');
}

/**
 * Build the below-editor Awareness panel lines. Empty array when there is
 * nothing to show; lines clipped at the source when `width` is given.
 */
export function formatAwarenessPanel(s: AwarenessStatus, theme?: PiTheme, width?: number): string[] {
  if (!hasAwarenessSignal(s) && !(s.unreadInbox && s.unreadInbox > 0)) return [];
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

  const attention: InlineSegment[] = [];
  // Unread inbound messages lead the panel — they are the one awareness event
  // that demands the operator's/agent's attention (a peer is talking to YOU).
  if (s.unreadInbox && s.unreadInbox > 0) {
    const preview = s.lastInbound ? ` (from ${s.lastInbound.from}: ${s.lastInbound.preview})` : '';
    attention.push({ text: `✉ ${s.unreadInbox} unread${preview}`, token: 'warning', attention: true });
  }
  if (debt > 0) attention.push({ text: `verify-debt ${debt}`, token: 'warning', attention: true });
  const chunks: InlineSegment[] = [
    ...attention,
    ...(segs.length ? [{ text: segs.join(SEP_WIDE), token: 'brand' as const }] : []),
    ...(tail.length ? [{ text: tail.join(SEP_WIDE), token: 'muted' as const }] : []),
  ];
  if (chunks.length === 0 && !(s.taskActivities?.length)) return [];
  const summaryLines = width
    ? renderInlineRows({ segments: [{ text: 'Awareness', token: 'title' }, ...chunks], separator: SEP_WIDE }, { width, theme })
    : [chunks.length > 0
      ? `${paint(theme, 'title', 'Awareness')}  ${chunks.map((chunk) => paint(theme, chunk.token ?? 'dim', chunk.text)).join(SEP_WIDE)}`
      : paint(theme, 'title', 'Awareness')];
  const taskLines = (s.taskActivities ?? []).map((task) => {
    const state = paint(theme, task.state === 'doing' ? 'brand' : 'link', task.state.toUpperCase());
    const owner = task.agentId ? `${SEP_WIDE}${paint(theme, 'muted', task.agentId)}` : '';
    const id = paint(theme, 'dim', task.taskId.slice(0, 6));
    return `${paint(theme, 'dim', '  task')}${SEP_WIDE}${state}${SEP_WIDE}${task.title}${owner}${SEP_WIDE}${id}`;
  });
  const lines = [...summaryLines, ...taskLines];
  return width ? lines.map((line) => truncateToWidth(line, width)) : lines;
}

// ─── Async, throttled refresh ────────────────────────────────────────────────

const MIN_REFRESH_MS = 8000;
/** Max distinct workspaces retained in the status cache before LRU eviction. */
const MAX_CACHED_CWDS = 32;

/** The Awareness section lines for the unified panel, from the cached status (empty when none). */
export function awarenessPanelLines(cwd: string, theme?: PiTheme, width?: number): string[] {
  const status = cache.get(cwd)?.status;
  return status ? formatAwarenessPanel(status, theme, width) : [];
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

/**
 * One shared invoker: run an awareness-lite command IN-PROCESS, resolve stdout
 * or null on any failure. Still returns a Promise so the throttled, never-block
 * refresh path (and its injectable runner seams) is unchanged; the underlying
 * call is a fast local-SQLite read, not a child process.
 */
function runLiteCli(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const { code, stdout } = runAwarenessLiteInProcess(args);
      resolve(code === 0 ? stdout : null);
    } catch {
      resolve(null);
    }
  });
}

const defaultRunner: StatusRunner = (cwd) => runLiteCli(['status', '--workspace', cwd]);

let runner: StatusRunner = defaultRunner;

/** Runs `message list` for the newest peer message; injectable for tests. */
export type MessageRunner = (cwd: string) => Promise<string | null>;
const defaultMessageRunner: MessageRunner = (cwd) =>
  runLiteCli(['message', 'list', '--workspace', cwd, '--limit', '1']);
let messageRunner: MessageRunner = defaultMessageRunner;

/** Runs `message inbox` for THIS agent's unread messages; injectable for tests. */
export type InboxRunner = (cwd: string, agentId: string) => Promise<string | null>;
const defaultInboxRunner: InboxRunner = (cwd, agentId) =>
  runLiteCli(['message', 'inbox', '--agent-id', agentId, '--workspace', cwd]);
let inboxRunner: InboxRunner = defaultInboxRunner;

export type TaskActivityRunner = (cwd: string) => Promise<{ claimed: string | null; ready: string | null }>;
const defaultTaskActivityRunner: TaskActivityRunner = async (cwd) => {
  const [claimed, ready] = await Promise.all([
    runLiteCli(['task', 'list', '--status', 'CLAIMED', '--workspace', cwd]),
      runLiteCli(['task', 'ready', '--workspace', cwd]),
  ]);
  return { claimed, ready };
};
let taskActivityRunner: TaskActivityRunner = defaultTaskActivityRunner;

/** Test hook: override the CLI runner. */
export function setAwarenessStatusRunnerForTests(fn: StatusRunner): void {
  runner = fn;
}
/** Test hook: override the message-list runner. */
export function setAwarenessMessageRunnerForTests(fn: MessageRunner): void {
  messageRunner = fn;
}
/** Test hook: override the inbox runner. */
export function setAwarenessInboxRunnerForTests(fn: InboxRunner): void {
  inboxRunner = fn;
}
export function setAwarenessTaskActivityRunnerForTests(fn: TaskActivityRunner): void {
  taskActivityRunner = fn;
}
export function resetAwarenessStatusStateForTests(): void {
  runner = defaultRunner;
  messageRunner = defaultMessageRunner;
  inboxRunner = defaultInboxRunner;
  taskActivityRunner = defaultTaskActivityRunner;
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
  // delete-then-set keeps this cwd most-recently-used; cap so a long-lived process
  // visiting many workspaces cannot grow the cache without bound.
  cache.delete(cwd);
  cache.set(cwd, entry);
  capMapSize(cache, MAX_CACHED_CWDS);

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
      // Only spend extra CLI calls when there are peer messages to summarize:
      // one for the newest-message preview, one for THIS agent's unread inbox
      // (the actionable "a peer messaged YOU" indication).
      if (parsed && (parsed.inProgressTasks > 0 || parsed.readyTasks > 0)) {
        void taskActivityRunner(cwd)
          .then(({ claimed, ready }) => {
            if (!entry.status || claimed === null || ready === null) return;
            entry.status = { ...entry.status, taskActivities: parseTaskActivities(claimed, ready) };
            renderWidget(ctx, entry.status);
          })
          .catch(() => { /* best-effort details; aggregate counts already shown */ });
      }
      if (parsed && parsed.messageCount > 0) {
        void messageRunner(cwd)
          .then((msgOut) => {
            if (msgOut === null || !entry.status) return;
            const last = parseLastMessage(msgOut);
            if (last) {
              entry.status = { ...entry.status, lastMessage: last };
              renderWidget(ctx, entry.status);
            }
          })
          .catch(() => { /* best-effort preview; count already shown */ });
        const agentId = process.env.OCTOCODE_AGENT_ID;
        if (agentId) {
          void inboxRunner(cwd, agentId)
            .then((inboxOut) => {
              if (inboxOut === null || !entry.status) return;
              const { unread, lastInbound } = parseInbox(inboxOut);
              entry.status = { ...entry.status, unreadInbox: unread, lastInbound };
              renderWidget(ctx, entry.status);
            })
            .catch(() => { /* best-effort; the total count is already shown */ });
        }
      }
    })
    .catch(() => {
      entry.running = false;
      entry.status = null;
      renderWidget(ctx, null);
    });
}
