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

let inFlightSince: number | null = null;

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
}
