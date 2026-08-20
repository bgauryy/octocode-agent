/**
 * state.ts — tiny launcher-owned state under the Octocode home.
 *
 * Two things Pi does NOT track for us:
 *   1. setupVersion   — which onboarding flow the user last completed. Bump
 *      AGENT_STATE_VERSION when the flow changes and configured users get a
 *      one-line refresh nudge at launch (OMP's CURRENT_SETUP_VERSION idea).
 *   2. terminal breadcrumbs — which session each multiplexed terminal last ran,
 *      so `-c` resumes THIS terminal's session, not the cwd-global newest
 *      (OMP's ~/.omp/agent/terminal-sessions/<tty-id> idea).
 *
 * All IO is path-injectable and failure-tolerant: state must never break a launch.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Current onboarding-flow version — bump when `auth login`/`setup --fix` change shape. */
export const AGENT_STATE_VERSION = 1;

export interface AgentState {
  /** Onboarding flow version last completed; absent = wizard never finished. */
  setupVersion?: number;
}

export function statePath(home: string): string {
  return path.join(home, 'state.json');
}

export function readAgentState(home: string): AgentState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(home), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AgentState) : {};
  } catch {
    return {};
  }
}

/** Merge-patch the state file (dir 0700, file 0600). Returns the written path. */
export function writeAgentState(home: string, patch: Partial<AgentState>): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const merged = { ...readAgentState(home), ...patch };
  const file = statePath(home);
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/**
 * Mark onboarding complete at the current flow version.
 * Best-effort: a failed state write must never fail the wizard itself.
 */
export function markSetupDone(home: string): void {
  try {
    writeAgentState(home, { setupVersion: AGENT_STATE_VERSION });
  } catch {
    /* non-critical */
  }
}

// ── Per-terminal resume breadcrumbs ─────────────────────────────────────────────

/**
 * Stable id for the current terminal pane, or null outside known multiplexers.
 * Order follows OMP's: tmux → zellij → kitty → wezterm → iTerm → Windows Terminal.
 */
export function terminalId(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.TMUX_PANE ??
    env.ZELLIJ_PANE_ID ??
    env.KITTY_WINDOW_ID ??
    env.WEZTERM_PANE ??
    env.TERM_SESSION_ID ??
    env.WT_SESSION ??
    null
  ) || null;
}

export interface TerminalBreadcrumb {
  /** Absolute path to the session .jsonl this terminal last ran. */
  sessionFile: string;
  /** Project cwd recorded in the session header. */
  cwd: string | null;
  savedAt: string;
}

function breadcrumbFile(home: string, termId: string): string {
  const safe = termId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(home, 'terminal-sessions', `${safe}.json`);
}

export function readBreadcrumb(home: string, termId: string): TerminalBreadcrumb | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(breadcrumbFile(home, termId), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const b = parsed as Partial<TerminalBreadcrumb>;
    if (typeof b.sessionFile !== 'string' || !fs.existsSync(b.sessionFile)) return null;
    return {
      sessionFile: b.sessionFile,
      cwd: typeof b.cwd === 'string' ? b.cwd : null,
      savedAt: typeof b.savedAt === 'string' ? b.savedAt : '',
    };
  } catch {
    return null;
  }
}

/** Best-effort breadcrumb write; returns the file path or null on failure. */
export function writeBreadcrumb(
  home: string,
  termId: string,
  entry: { sessionFile: string; cwd: string | null },
): string | null {
  try {
    const file = breadcrumbFile(home, termId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body: TerminalBreadcrumb = { ...entry, savedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
    return file;
  } catch {
    return null;
  }
}
