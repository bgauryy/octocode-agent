/** Context compaction automation and lifecycle recovery. */
import type { PiContext, PiInstance, TurnEndEvent, NotifyFn } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { activePlanScope, hasActivePlanWork } from './active-plan.js';
import { clearCompactionWorkingState } from './compaction-resume.js';
import { isCompletedSessionAssistantText, latestAssistantText } from './compaction-hooks.js';
import { branchTipIsCompaction, clearAutoCompactResumeRequest, clearCompactionAbortSuppressionRequest, clearCompactionInFlight, clearCompactionResumeRequest, consumeCompactionAbortSuppressionRequest, isCompactionInFlight, markAutoCompactResumeRequested, markCompactionAbortSuppressionRequested, markCompactionInFlight, resetCompactionArbiterForTests } from './compaction-state.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;
const AUTO_COMPACT_THRESHOLD = 0.80;
const COMPACTION_CONTINUATION_INSTRUCTIONS =
  'Preserve continuation state, not transcript: goal, constraints, current mode, decisions, read/modified files, live workers/locks, blockers/open questions, verification owed, and exact next pickup. Mark partial/failed work separately.';

function isNothingToCompact(error: Error): boolean {
  return /nothing to compact/i.test(error.message);
}

// Pi throws "Already compacted" when compact() lands right after a finished
// compaction (branch tip is already a compaction entry). It means another
// trigger won the race and the context IS compacted — success, not failure.
function isAlreadyCompacted(error: Error): boolean {
  return /already compacted/i.test(error.message);
}

function isPiSignalCrashAfterCompaction(error: Error, ctx: PiContext | undefined): boolean {
  return /Cannot read properties of undefined \(reading 'signal'\)/i.test(error.message)
    && branchTipIsCompaction(ctx);
}

function isOutputLengthStop(event: TurnEndEvent | undefined): boolean {
  if (event?.message?.stopReason !== 'length') return false;
  // Pi-ai treats length + output=0 + full input as a possible context overflow.
  // Any positive or unknown output means the model used its response budget;
  // compaction will not make the current answer fit in one message.
  return event.message.usage?.output !== 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function downgradeCompactionAbortMessage(message: unknown): { message?: unknown } | void {
  if (!isRecord(message) || message.stopReason !== 'aborted') return;
  if (!consumeCompactionAbortSuppressionRequest()) return;
  return {
    message: {
      ...message,
      stopReason: 'stop',
      errorMessage: undefined,
      content: [
        {
          type: 'text',
          text: 'Compaction interrupted this turn; continuing from the saved checkpoint.',
        },
      ],
    },
  };
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

// Edge-trigger state for extension auto-compaction. Module-level so the
// session_start handler in index.ts can reset it on session replacement
// (/new, /resume) — it otherwise leaks the previous session's threshold
// crossing across sessions in the same process.
let lastAutoCompactTokens: number | null = null;
export function resetAutoCompactState(): void {
  lastAutoCompactTokens = null;
}

export function registerContextTools(
  pi: PiInstance,
  _Type: TypeBoxBuilder,
  _registeredToolNames: Set<string>,
  _registerFn: RegisterFn,
  notify: NotifyFn,
): void {
  // Fresh wiring = fresh edge-trigger state (mirrors the pre-module-level
  // closure semantics; index.ts also resets on session_start).
  resetAutoCompactState();
  resetCompactionArbiterForTests();

  /** Shared compact() lifecycle callbacks — one implementation for the auto and manual triggers. */
  const compactionCallbacks = (ctx: PiContext | undefined, label: 'Auto-compaction' | 'Compaction') => ({
    onComplete: once(() => {
      clearCompactionInFlight();
      clearCompactionWorkingState(ctx);
    }),
    onError: (error: Error) => {
      clearCompactionInFlight();
      clearCompactionResumeRequest();
      clearAutoCompactResumeRequest();
      clearCompactionAbortSuppressionRequest();
      clearCompactionWorkingState(ctx);
      if (isNothingToCompact(error)) {
        notify(ctx, `${label} skipped: session is too small to compact.`, 'info');
        return;
      }
      if (isAlreadyCompacted(error) || isPiSignalCrashAfterCompaction(error, ctx)) {
        notify(ctx, `${label} skipped: context was already compacted by another trigger.`, 'info');
        return;
      }
      notify(ctx, `${label} failed: ${error.message}`, 'error');
    },
  });
  if (pi.on) {
    pi.on('message_end', async (event: { message: unknown }) => downgradeCompactionAbortMessage(event.message));

    pi.on('turn_end', (event, ctx) => {
      if (isOutputLengthStop(event)) {
        notify(
          ctx,
          'Model hit the maximum output token limit. Compaction does not increase one-response output budget; continue with a shorter/chunked response or write long output to a file.',
          'warning',
        );
        return;
      }
      // An aborted turn reports the PRE-abort context size — most often it is
      // the very turn a ctx.compact() just killed, so acting on that usage
      // fires a second compact straight into "Already compacted".
      // An error turn (API 4xx/5xx, network failure, invalid request) also
      // reports stale context size and the session may be ending — compacting
      // after a provider error wastes budget and runs past session teardown.
      const stopReason = event?.message?.stopReason;
      if (stopReason === 'aborted' || stopReason === 'error') return;

      const usage = ctx.getContextUsage?.();
      if (!usage || usage.tokens == null) return; // tokens null = unknown (right after compaction)
      if (!(usage.contextWindow > 0)) return; // guard divide-by-zero → NaN spurious compaction
      const fill = usage.tokens / usage.contextWindow;
      const prevFill = lastAutoCompactTokens !== null
        ? lastAutoCompactTokens / usage.contextWindow
        : null;
      if (fill < AUTO_COMPACT_THRESHOLD) {
        lastAutoCompactTokens = usage.tokens;
        return;
      }
      if (prevFill !== null && prevFill >= AUTO_COMPACT_THRESHOLD) return;
      // turn_end compaction runs BETWEEN turns — no in-flight run is aborted, so
      // compacting with no active in-progress work just spends budget after the
      // session has effectively ended. Do not record this as a threshold crossing:
      // if a later user turn creates active work while still above 80%, it should
      // still be eligible to compact. Also skip stale todo/blocked plan state left
      // after a terminal answer; the follow-up would only say "prior work was
      // already complete" and surprise the user with a spinner.
      if (!hasActivePlanWork(activePlanScope(ctx))) return;
      if (isCompletedSessionAssistantText(latestAssistantText(ctx.sessionManager?.getBranch?.()))) return;
      lastAutoCompactTokens = usage.tokens;

      // Stand down for any compaction that is already running (pi's internal
      // auto or user /compact) and for a branch tip that is
      // already a compaction entry — pi's exact "Already compacted" condition.
      if (isCompactionInFlight() || branchTipIsCompaction(ctx)) return;

      if (!ctx.compact) {
        notify(ctx, 'Auto-compaction skipped: ctx.compact is not available in this runtime.', 'warning');
        return;
      }

      const pctStr = `${Math.round(fill * 100)}%`;
      notify(ctx, `Auto-compacting: context at ${pctStr} of context window.`, 'info');
      markCompactionInFlight();
      // turn_end compaction runs BETWEEN turns, so reaching this point means
      // unfinished plan work exists and the post-compaction continuation is
      // intentional. The session_compact hook remains the single scheduler.
      markAutoCompactResumeRequested();
      // ctx.compact() aborts the in-flight run, so Pi emits one assistant
      // message with stopReason 'aborted'. Arm the suppression flag so the
      // message_end hook (downgradeCompactionAbortMessage) rewrites that single
      // abort into a benign checkpoint notice instead of leaking a raw
      // "This operation was aborted" error to the transcript.
      markCompactionAbortSuppressionRequested();
      ctx.compact({
        customInstructions: COMPACTION_CONTINUATION_INSTRUCTIONS,
        ...compactionCallbacks(ctx, 'Auto-compaction'),
      });
    });
  }
}
