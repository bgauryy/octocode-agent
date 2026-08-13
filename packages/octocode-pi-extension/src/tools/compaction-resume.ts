import type { PiContext, PiInstance } from '../types.js';

export type Notifier = (ctx: PiContext | undefined, msg: string, level?: string) => void;

const RESUME_DEDUPE_WINDOW_MS = 1500;
const DEFAULT_RESUME_RETRY_DELAY_MS = 400;

let lastResumeScheduledAt = 0;
let resumeRetryDelayMs = DEFAULT_RESUME_RETRY_DELAY_MS;

/** Test seam: shorten the retry backoff (pass null to restore the default). */
export function setCompactionResumeRetryDelayForTests(ms: number | null): void {
  resumeRetryDelayMs = ms ?? DEFAULT_RESUME_RETRY_DELAY_MS;
}

export function clearCompactionWorkingState(ctx: PiContext | undefined): void {
  if (!ctx?.hasUI) return;
  // Pi owns the compaction spinner/message, but extension-triggered compaction
  // queues a follow-up turn. Clear stale working UI first so the resumed agent
  // cannot leave users staring at "Compacting context…" after callbacks fire.
  ctx.ui?.setWorkingMessage?.(undefined);
  ctx.ui?.setWorkingVisible?.(false);
}

export function scheduleCompactionContinuation(
  pi: PiInstance,
  ctx: PiContext | undefined,
  notify: Notifier,
  continuation: string,
  successMessage: string,
): void {
  clearCompactionWorkingState(ctx);

  const now = Date.now();
  if (now - lastResumeScheduledAt < RESUME_DEDUPE_WINDOW_MS) return;
  lastResumeScheduledAt = now;

  notify(ctx, successMessage, 'info');

  // Pi docs say ctx.compact() completion should be handled through onComplete.
  // Upstream source shows sendUserMessage starts a prompt immediately when idle,
  // and queues only while streaming. Defer one macrotask so Pi finishes saving
  // the compaction entry, rebuilding UI/session context, and unwinding the
  // completion callback before the continuation prompt is accepted.
  const send = () => {
    const fn = pi.sendUserMessage as (text: string, opts?: { deliverAs?: string }) => void | Promise<void>;
    return Promise.resolve(fn(continuation, { deliverAs: 'followUp' }));
  };
  setTimeout(() => {
    void (async () => {
      try {
        await send();
        return;
      } catch {
        // First attempt failed — Pi may still have been unwinding the compaction
        // callback. Retry once after a short backoff before giving up.
      }
      await new Promise((r) => setTimeout(r, resumeRetryDelayMs));
      try {
        await send();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Do not leave the user staring at a dead session: clear working UI and
        // surface an actionable affordance instead of a single silent error.
        clearCompactionWorkingState(ctx);
        notify(
          ctx,
          `Compaction completed, but auto-resume failed after a retry (${message}). Type anything to continue where you left off.`,
          'warning',
        );
      }
    })();
  }, 0);
}

export function resetCompactionResumeStateForTests(): void {
  lastResumeScheduledAt = 0;
}
