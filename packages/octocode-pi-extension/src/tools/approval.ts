/**
 * Approval gate — context-aware, per-session consent for sensitive actions.
 *
 * Some actions are protected: installing anything, mutating git, deleting user
 * files, or running `sudo`. Instead of assuming consent, we ask the user through
 * an interactive prompt with three choices:
 *
 *   • Yes (once)              → approve this one action.
 *   • No                      → decline; the caller must not proceed.
 *   • Always allow (session)  → approve and remember this *class* of action for
 *                               the rest of the session, so we never re-prompt it.
 *
 * The "always allow" decisions live in a module-level session store that is
 * cleared on `session_start` (see resetApprovalStore). Non-interactive hosts
 * (rpc / json / print) cannot prompt, so the gate denies and tells the agent to
 * confirm inline before retrying — it never silently proceeds.
 */

import type { PiContext } from '../types.js';

/** Stable identifiers for the classes of action we gate. */
export type ApprovalClass = 'install' | 'git-write' | 'fs-delete' | 'sudo';

export interface ApprovalRequest {
  /** Which class of action this is — the key remembered by "always allow". */
  actionClass: ApprovalClass;
  /** Short human title for the prompt, e.g. "Run git command". */
  title: string;
  /** The concrete detail shown to the user (the command, package, etc.). */
  detail: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  /** True when approval came from a remembered "always allow" decision. */
  remembered: boolean;
  /** True when the user chose "always allow" during this prompt. */
  always: boolean;
  /** False when the host could not prompt (non-interactive). */
  interactive: boolean;
}

/** Per-session set of action classes the user chose to "always allow". */
const alwaysAllowed = new Set<ApprovalClass>();

/** Clear all remembered approvals. Called on session_start. */
export function resetApprovalStore(): void {
  alwaysAllowed.clear();
}

/** Whether a class has a remembered "always allow" for this session. */
export function isAlwaysAllowed(cls: ApprovalClass): boolean {
  return alwaysAllowed.has(cls);
}

/** Remember an "always allow" decision for a class (session-scoped). */
export function allowAlways(cls: ApprovalClass): void {
  alwaysAllowed.add(cls);
}

/** Snapshot of remembered classes — for status/session-state display. */
export function approvedClasses(): ApprovalClass[] {
  return [...alwaysAllowed];
}

/** Git subcommands that mutate history, refs, the worktree, or remotes. */
const MUTATING_GIT_SUBCOMMANDS = new Set([
  'commit', 'push', 'reset', 'rebase', 'checkout', 'switch', 'merge', 'cherry-pick',
  'revert', 'clean', 'restore', 'rm', 'mv', 'am', 'apply', 'stash', 'tag', 'branch',
  'filter-branch', 'filter-repo', 'gc', 'prune', 'reflog', 'remote', 'update-ref',
  'fetch', 'pull', 'clone', 'init', 'add', 'config',
]);

/** Package/tool install commands. `pkg add`/`install` etc. */
const INSTALL_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i|global\s+add|dlx)\b|\b(?:pip3?|pipx)\s+install\b|\b(?:brew|apt|apt-get|dnf|yum|pacman|zypper|apk)\s+(?:install|add)\b|\b(?:cargo|go|gem)\s+install\b|\bgo\s+get\b/;

/** curl|wget piped into a shell — remote-code install pattern. */
const PIPE_TO_SHELL_RE = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/;

/** Octocode's own dogfood CLIs run constantly — never prompt for them. */
function isOctocodeDogfoodInstall(command: string): boolean {
  return /\bnpx\s+(?:-y\s+|--yes\s+)?(?:@octocodeai\/|octocode\b|octocode-mcp\b)/.test(command);
}

/**
 * Classify a shell command into a sensitive action class, or null when it needs
 * no approval. Best-effort static scan — designed to fail *open* only for the
 * ordinary read/build commands, and to catch the clearly-sensitive ones.
 */
export function classifySensitiveCommand(command: string): ApprovalRequest | null {
  const cmd = command.trim();

  // sudo — highest priority; privilege escalation of any kind.
  if (/(^|[;|&(\n])\s*sudo\b/.test(cmd)) {
    return { actionClass: 'sudo', title: 'Run command with sudo (elevated privileges)', detail: cmd };
  }

  // Installs (skip Octocode dogfood CLIs to avoid prompt fatigue).
  if ((INSTALL_RE.test(cmd) || PIPE_TO_SHELL_RE.test(cmd)) && !isOctocodeDogfoodInstall(cmd)) {
    return { actionClass: 'install', title: 'Install packages / tools', detail: cmd };
  }

  // Mutating git — scan each command segment for `git <subcommand>`.
  for (const seg of cmd.split(/[;|&\n]+/)) {
    const m = /\bgit\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/.exec(seg.trim());
    if (m && MUTATING_GIT_SUBCOMMANDS.has(m[1]!)) {
      return { actionClass: 'git-write', title: `Run sensitive git command (git ${m[1]})`, detail: seg.trim() };
    }
  }

  // File removal.
  if (/(^|[;|&(\n])\s*(?:rm|rmdir)\s+/.test(cmd)) {
    return { actionClass: 'fs-delete', title: 'Delete files / directories', detail: cmd };
  }

  return null;
}

function canPrompt(ctx?: PiContext): boolean {
  return Boolean(ctx?.hasUI && typeof ctx.ui?.select === 'function');
}

const YES = 'Yes (run once)';
const NO = 'No, do not run';
const ALWAYS = 'Always allow this session';

/**
 * Request approval for a sensitive action. Returns immediately when the class
 * is already remembered; otherwise prompts the user with Yes / No / Always.
 */
export async function requestApproval(
  ctx: PiContext | undefined,
  request: ApprovalRequest,
): Promise<ApprovalOutcome> {
  if (isAlwaysAllowed(request.actionClass)) {
    return { approved: true, remembered: true, always: false, interactive: true };
  }
  if (!canPrompt(ctx)) {
    return { approved: false, remembered: false, always: false, interactive: false };
  }

  const prompt = request.detail ? `${request.title}\n${request.detail}` : request.title;
  const choice = await ctx!.ui!.select!(prompt, [YES, NO, ALWAYS]);

  if (choice === ALWAYS) {
    allowAlways(request.actionClass);
    return { approved: true, remembered: false, always: true, interactive: true };
  }
  if (choice === YES) {
    return { approved: true, remembered: false, always: false, interactive: true };
  }
  // No, or dismissed (undefined) → decline.
  return { approved: false, remembered: false, always: false, interactive: true };
}
