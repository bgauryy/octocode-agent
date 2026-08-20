import { auditUnverified } from './verify.js';
import { artifactFrom, defaultGetDb, getPiAwarenessAgentId, getPiAwarenessSessionId, notify, PiAwarenessBridgeOptions, PiLikeApi, PiLikeContext, PiToolEvent } from './pi-hooks-inputs.js';
import { createPiAwarenessBridge } from './pi-hooks-bridge.js';
import { finalizeActivePiFallbackRuns } from './pi-hooks-guard.js';

export function wirePiAwarenessHooks(pi: PiLikeApi, options: PiAwarenessBridgeOptions = {}) {
  if (!pi?.on) return null;
  const bridge = createPiAwarenessBridge(options);
  const verifyReminderKeys = new Set<string>();
  // Loop safety: cap how many times the verify gate fires within a session before it
  // goes quiet. The reminderKey Set already suppresses re-fires for an identical run set;
  // this bounds the case where each turn creates NEW run ids (e.g. a verification turn
  // that itself edits a file), which would otherwise let the gate nag every turn.
  const MAX_VERIFY_GATE_FIRES = 3;
  let verifyReminderFireCount = 0;

  // Per Pi's docs (extensions.md "Tool Events"), every tool call fires FOUR distinct
  // events in sequence: tool_execution_start -> tool_call -> [exec] -> tool_result ->
  // tool_execution_end. They are not aliases for one another. tool_call/tool_result
  // are the only pair that can actually block (`{block:true}`) or modify the result;
  // tool_execution_start/end are notification-only. Registering both pairs against
  // the same handler (as this used to do) double-dispatches every awareness DB touch
  // on every tool call, and made real blocking depend on an undocumented ordering
  // invariant (the dedupe-by-toolCallId guard only worked because block-returning
  // paths happened to return before it was set). tool_call/tool_result alone are the
  // correct, sufficient, single source of truth.
  pi.on('tool_call', async (event, ctx) => bridge.handleToolCall(event as PiToolEvent, ctx));
  pi.on('tool_result', async (event, ctx) => bridge.handleToolResult(event as PiToolEvent, ctx));
  pi.on('session_start', async (event, ctx) => bridge.handleSessionStart(event, ctx));
  pi.on('input', async (event, ctx) => bridge.handleInput(event, ctx));
  pi.on('before_agent_start', async (event, ctx) => bridge.handleBeforeAgentStart(event, ctx));
  pi.on('agent_end', async (_event, ctx) => {
    try {
      const db = (options.getDb ?? ((hookCtx?: PiLikeContext) => defaultGetDb(options, hookCtx)))(ctx);
      finalizeActivePiFallbackRuns(db, {
        agentId: getPiAwarenessAgentId(ctx),
        sessionId: getPiAwarenessSessionId(ctx),
        workspacePath: ctx?.cwd ?? process.cwd(),
        artifact: artifactFrom(ctx, _event),
      });
      if (process.env.OCTOCODE_NO_VERIFY_GATE === '1') return undefined;
      const result = auditUnverified(db, {
        agentId: getPiAwarenessAgentId(ctx),
        workspacePath: ctx?.cwd ?? process.cwd(),
        artifact: artifactFrom(ctx, _event),
      });
      if (result.count === 0) {
        verifyReminderKeys.clear();
        verifyReminderFireCount = 0; // fully cleared → re-arm the gate for future work
        return undefined;
      }
      const reminderKey = JSON.stringify({
        agentId: getPiAwarenessAgentId(ctx),
        workspacePath: ctx?.cwd ?? process.cwd(),
        artifact: artifactFrom(ctx, _event),
        runIds: [
          ...result.unverified.map((intent) => intent.run_id),
          ...result.stale_active.map((intent) => intent.run_id),
        ].sort(),
      });
      if (verifyReminderKeys.has(reminderKey)) return undefined;
      // Loop guard: once the gate has fired MAX times this session without fully clearing,
      // stop force-triggering turns. Emit one final non-blocking notice and go quiet so a
      // stuck agent/verification-edit cycle cannot nag indefinitely.
      if (verifyReminderFireCount >= MAX_VERIFY_GATE_FIRES) {
        if (verifyReminderFireCount === MAX_VERIFY_GATE_FIRES) {
          verifyReminderFireCount += 1; // emit the silence notice exactly once
          notify(ctx, `Octocode verify gate silenced after ${MAX_VERIFY_GATE_FIRES} reminders; ${result.count} run(s) still unverified. Run "octocode-awareness verify audit" and "verify mark" to clear.`, 'warning');
        }
        return undefined;
      }
      verifyReminderKeys.add(reminderKey);
      verifyReminderFireCount += 1;
      const pendingLines = result.unverified.map((intent) => `PENDING ${intent.run_id}: ${intent.test_plan}`);
      const staleLines = result.stale_active.map((intent) => `STALE ${intent.run_id}: ${intent.rationale}`);
      const details = [...pendingLines, ...staleLines];
      const shown = details.slice(0, 3).join('; ');
      const omitted = details.length > 3 ? `; +${details.length - 3} omitted` : '';
      const actions = [
        pendingLines.length ? 'PENDING runs: run the stated test/typecheck, then `octocode-awareness verify mark --run-id <id> --status SUCCESS --message "<result>"` (or --all-pending).' : '',
        staleLines.length ? 'STALE runs: their work lease expired unverified — close each with `verify mark --run-id <id> --status FAILED --message "<why>"`.' : '',
      ].filter(Boolean);
      pi.sendMessage?.({
        customType: 'octocode-awareness-verify-gate',
        content: [
          'Octocode awareness verify gate: you have unverified edits before concluding.',
          shown ? `Pending: ${shown}${omitted}` : '',
          ...actions,
        ].filter(Boolean).join('\n'),
        display: true,
      }, { deliverAs: 'followUp', triggerTurn: true });
      return undefined;
    } catch (error) {
      notify(ctx, `Octocode awareness verify warning; continuing: ${error instanceof Error ? error.message : String(error)}`, 'warning');
      return undefined;
    }
  });
  pi.on('session_before_compact', async (event, ctx) => bridge.handleSessionCompact({
    reason: typeof event?.reason === 'string' ? `compact:${event.reason}` : 'compact',
  }, ctx));
  pi.on('session_shutdown', async (event, ctx) => bridge.handleSessionShutdown(event, ctx));

  return bridge;
}
