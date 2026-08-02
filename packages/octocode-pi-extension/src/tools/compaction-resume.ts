import type { PiContext, PiInstance } from '../types.js';

export type Notifier = (ctx: PiContext | undefined, msg: string, level?: string) => void;

const RESUME_DEDUPE_WINDOW_MS = 1500;

let lastResumeScheduledAt = 0;

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
  setTimeout(() => {
    void Promise.resolve()
      .then(() => {
        const send = pi.sendUserMessage as (text: string, opts?: { deliverAs?: string }) => void | Promise<void>;
        return send(continuation, { deliverAs: 'followUp' });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `Compaction completed, but resume prompt failed: ${message}`, 'error');
      });
  }, 0);
}

export function resetCompactionResumeStateForTests(): void {
  lastResumeScheduledAt = 0;
}
