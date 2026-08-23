/**
 * compaction-state — shared arbiter for every compaction trigger.
 *
 * Four independent triggers can start a compaction: pi's built-in threshold
 * auto-compaction, the extension's turn_end watcher, the model-called
 * manage_context tool, and a user /compact. Pi neither serializes
 * ctx.compact() calls nor exposes an is-compacting flag, and its
 * session.compact() throws "Already compacted" when it lands right after a
 * finished compaction (branch tip is already a compaction entry). This module
 * is the extension-side arbiter: session_before_compact marks in-flight for
 * ALL paths (it fires for pi-internal and user compactions too),
 * session_compact clears it, and our own triggers stand down while it is set.
 *
 * Pi emits no extension event when its internal auto-compaction fails, so a
 * mark could otherwise wedge forever and silently disable our triggers for
 * the rest of the session — entries expire after a TTL as a fail-open
 * backstop.
 */

const COMPACTION_IN_FLIGHT_TTL_MS = 120_000;
const COMPACTION_RESUME_REQUEST_TTL_MS = COMPACTION_IN_FLIGHT_TTL_MS;
const COMPACTION_ABORT_SUPPRESSION_TTL_MS = 30_000;

let inFlightSince: number | null = null;
let resumeRequestedSince: number | null = null;
let abortSuppressionRequestedSince: number | null = null;
// Auto-compact resume (turn_end watcher, plan-verified):
// session_compact re-checks plan state before scheduling the continuation.
let autoCompactResumeSince: number | null = null;

export function markCompactionInFlight(now = Date.now()): void {
  inFlightSince = now;
}

export function clearCompactionInFlight(): void {
  inFlightSince = null;
}

export function isCompactionInFlight(now = Date.now()): boolean {
  if (inFlightSince === null) return false;
  if (now - inFlightSince > COMPACTION_IN_FLIGHT_TTL_MS) {
    inFlightSince = null;
    return false;
  }
  return true;
}

/**
 * Mark that Octocode itself requested ctx.compact() and therefore owns the
 * post-compaction continuation. Pi's session_compact.fromExtension means the
 * summary was supplied by an extension, not that ctx.compact() was called by
 * one, so resume intent must be tracked separately.
 */
export function markCompactionResumeRequested(now = Date.now()): void {
  resumeRequestedSince = now;
}

export function clearCompactionResumeRequest(): void {
  resumeRequestedSince = null;
}

export function consumeCompactionResumeRequest(now = Date.now()): boolean {
  if (resumeRequestedSince === null) return false;
  const requestedAt = resumeRequestedSince;
  resumeRequestedSince = null;
  return now - requestedAt <= COMPACTION_RESUME_REQUEST_TTL_MS;
}

/**
 * Mark that the turn_end auto-compact watcher triggered ctx.compact() while
 * plan work was active. Unlike the explicit (manage_context) resume,
 * session_compact will re-verify plan state before scheduling the continuation
 * — if work completed while compaction was in flight the follow-up is skipped.
 */
export function markAutoCompactResumeRequested(now = Date.now()): void {
  autoCompactResumeSince = now;
}

export function clearAutoCompactResumeRequest(): void {
  autoCompactResumeSince = null;
}

export function consumeAutoCompactResumeRequest(now = Date.now()): boolean {
  if (autoCompactResumeSince === null) return false;
  const requestedAt = autoCompactResumeSince;
  autoCompactResumeSince = null;
  return now - requestedAt <= COMPACTION_RESUME_REQUEST_TTL_MS;
}

/**
 * Mark the single assistant message abort that Pi produces when Octocode calls
 * ctx.compact() mid-turn. That abort is control flow, not a user-visible model
 * failure, so the message_end hook can downgrade it once and then forget it.
 */
export function markCompactionAbortSuppressionRequested(now = Date.now()): void {
  abortSuppressionRequestedSince = now;
}

export function clearCompactionAbortSuppressionRequest(): void {
  abortSuppressionRequestedSince = null;
}

export function consumeCompactionAbortSuppressionRequest(now = Date.now()): boolean {
  if (abortSuppressionRequestedSince === null) return false;
  const requestedAt = abortSuppressionRequestedSince;
  abortSuppressionRequestedSince = null;
  return now - requestedAt <= COMPACTION_ABORT_SUPPRESSION_TTL_MS;
}

/**
 * Whether the session branch tip is already a compaction entry — the exact
 * condition under which pi's compact() throws "Already compacted". Checking it
 * up front turns a guaranteed error into a clean skip. Fail-open when the host
 * does not expose sessionManager.getBranch.
 */
export function branchTipIsCompaction(ctx?: {
  sessionManager?: { getBranch?(): unknown[] | undefined };
}): boolean {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch) || branch.length === 0) return false;
  const last = branch[branch.length - 1];
  return Boolean(
    last && typeof last === 'object' && (last as { type?: unknown }).type === 'compaction',
  );
}

export function resetCompactionArbiterForTests(): void {
  inFlightSince = null;
  resumeRequestedSince = null;
  abortSuppressionRequestedSince = null;
  autoCompactResumeSince = null;
}
