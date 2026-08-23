/**
 * Context session-management tools:
 * manage_context (type:"compact" | type:"new")
 *
 * IMPORTANT — session-control APIs (ctx.newSession, ctx.reload) are ONLY
 * available in ExtensionCommandContext (registerCommand handlers). They are
 * NOT exposed to tool execute() contexts and will always be undefined there.
 */
import { CLI_STATUS_TEXT, cliStatusGlyph, cliStatusToken, cliToolTitle, paint } from '../tui/cli-design.js';
import type { PiContext, PiCommandContext, PiInstance, ToolDefinition, PiTheme, TurnEndEvent, NotifyFn } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { singleLineRenderer } from './render-helpers.js';
import { stringEnumSchema } from './schema-helpers.js';
import { activePlanScope, hasActivePlanWork } from './active-plan.js';
import { isSubagentProcess } from './agent-tools.js';
import { clearCompactionWorkingState } from './compaction-resume.js';
import { isCompletedSessionAssistantText, latestAssistantText } from './compaction-hooks.js';
import { branchTipIsCompaction, clearAutoCompactResumeRequest, clearCompactionAbortSuppressionRequest, clearCompactionInFlight, clearCompactionResumeRequest, consumeCompactionAbortSuppressionRequest, isCompactionInFlight, markAutoCompactResumeRequested, markCompactionAbortSuppressionRequested, markCompactionInFlight, markCompactionResumeRequested, resetCompactionArbiterForTests } from './compaction-state.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;
const AUTO_COMPACT_THRESHOLD = 0.80;
const COMPACTION_CONTINUATION_INSTRUCTIONS =
  'Preserve continuation state, not transcript: goal, constraints, current mode, decisions, read/modified files, live workers/locks, blockers/open questions, verification owed, and exact next pickup. Mark partial/failed work separately.';

function buildCompactionInstructions(instructions: unknown): string {
  const userInstructions = typeof instructions === 'string' ? instructions.trim() : '';
  return userInstructions
    ? `${userInstructions}\n\n${COMPACTION_CONTINUATION_INSTRUCTIONS}`
    : COMPACTION_CONTINUATION_INSTRUCTIONS;
}

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
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
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
      if (event?.message?.stopReason === 'aborted') return;

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
      // auto, user /compact, manage_context) and for a branch tip that is
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
      // intentional. Use the plan-verified flag so session_compact can re-check
      // plan state at completion time and suppress stale resumes.
      markAutoCompactResumeRequested();
      ctx.compact({
        customInstructions: COMPACTION_CONTINUATION_INSTRUCTIONS,
        // No continuation scheduled here: the session_compact hook is the single
        // scheduler. Pi's session_compact.fromExtension means "summary supplied
        // by extension", so the resume intent is tracked by compaction-state.
        // Scheduling from BOTH paths raced on a 1.5s wall-clock dedupe window —
        // any ordering delay over it sent the continuation twice.
        ...compactionCallbacks(ctx, 'Auto-compaction'),
      });
    });
  }

  if (pi.registerCommand) {
    pi.registerCommand('_octocode-clear-context-impl', {
      description: '[internal] Start a new session — invoked by the clear_context tool.',
      handler: async (_args, ctx: PiCommandContext) => {
        if (!ctx.newSession) {
          notify(ctx, 'clear_context: ctx.newSession not available in this runtime.', 'error');
          return;
        }
        const result = await ctx.newSession();
        if (result?.cancelled) {
          notify(ctx, 'clear_context: session switch was cancelled.', 'warning');
        }
      },
    });
  }

  registerFn(pi, registeredToolNames, {
    name: 'manage_context',
    label: 'Manage Context',
    description:
      'Compact or reset the conversation context. ' +
      'type:"compact" — summarize history to free context window space; call at a research→execution boundary or before a large new task. ' +
      'Automatic compaction already runs when the context nears its limit — never call this right after a compaction (it is a no-op), and do not call it on a percentage schedule. ' +
      'type:"new" — start a fresh session with no prior context; call only when the next task is fully unrelated to the current conversation.',
    promptSnippet: 'Compact or reset conversation context',
    parameters: Type.Object({
      type: stringEnumSchema(
        Type,
        ['compact', 'new'],
        '"compact" summarizes history to free space. "new" starts a completely fresh session.',
      ),
      instructions: Type.Optional(
        Type.String({
          description: 'Focus instructions for the compaction summary (e.g. "focus on recent file changes"). Only used when type:"compact".',
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiContext,
    ) {
      if (params['type'] === 'new') {
        // type:"new" is only meaningful in the host Pi process: it queues a
        // /_octocode-clear-context-impl command that was registered only there.
        // Inside a spawned worker that command doesn't exist, so the follow-up
        // would be delivered as a user message and treated as unknown input.
        if (isSubagentProcess()) {
          return {
            content: [{
              type: 'text' as const,
              text: 'manage_context type:"new" is not supported inside a spawned worker process. Use it from the parent agent session instead.',
            }],
            isError: true,
          };
        }
        pi.sendUserMessage('/_octocode-clear-context-impl', { deliverAs: 'followUp', expandPromptTemplates: true });
        return {
          content: [
            {
              type: 'text' as const,
              text: 'New session queued. The context will be cleared after this turn completes.',
            },
          ],
        };
      }

      // type === 'compact'
      if (!ctx?.compact) {
        throw new Error('manage_context: ctx.compact is not available in this runtime. Use /compact manually.');
      }

      // Pre-flight guards: do not race a running compaction, and do not call
      // into pi's guaranteed "Already compacted" throw (branch tip is already
      // a compaction entry / usage unknown because no assistant message landed
      // since the last compaction).
      if (isCompactionInFlight()) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Compaction skipped: another compaction is already in progress. Continue the task; the context will shrink when it finishes.',
          }],
        };
      }
      const usage = ctx.getContextUsage?.();
      if (branchTipIsCompaction(ctx) || (usage != null && usage.tokens === null)) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Compaction skipped: the context was just compacted — there is no new history to summarize. Continue the task from the compacted context.',
          }],
        };
      }

      markCompactionInFlight();
      // Unlike the turn_end path, this tool call happens MID-turn: ctx.compact()
      // aborts the in-flight agent run, so a continuation is always required to
      // recover — active work exists by definition (the model was mid-task).
      markCompactionResumeRequested();
      markCompactionAbortSuppressionRequested();
      ctx.compact({
        customInstructions: buildCompactionInstructions(params['instructions']),
        // Continuation is scheduled by the session_compact hook — the single
        // scheduler; see the auto-compaction comment above.
        ...compactionCallbacks(ctx, 'Compaction'),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Compaction triggered. The agent will continue after the summary is saved.',
          },
        ],
      };
    },

    renderCall(args: unknown, theme?: PiTheme) {
      const a = (args ?? {}) as Record<string, unknown>;
      const type = typeof a['type'] === 'string' ? a['type'] : 'compact';
      const instructions = type === 'compact' && typeof a['instructions'] === 'string' && a['instructions'] ? a['instructions'] : '';
      const nameStr = cliToolTitle(theme, 'manage_context', { bold: true });
      const typeStr = paint(theme, 'dim', ` (${type})`);
      const displayInstructions = instructions.length > 50 ? `${instructions.slice(0, 47)}…` : instructions;
      const detail = instructions
        ? paint(theme, 'dim', ` "${displayInstructions}"`)
        : '';
      return singleLineRenderer(`${nameStr}${typeStr}${detail}`);
    },

    renderResult(result, opts, theme?: PiTheme) {
      if (opts.isPartial) {
        return singleLineRenderer(paint(theme, 'brand', CLI_STATUS_TEXT.processing));
      }
      const ok = !result.isError;
      const icon = paint(theme, cliStatusToken(ok), cliStatusGlyph(ok));
      const nameStr = cliToolTitle(theme, 'manage_context');
      const msg = ok
        ? paint(theme, 'dim', ` · ${CLI_STATUS_TEXT.done}`)
        : '';
      return singleLineRenderer(`${icon} ${nameStr}${msg}`);
    },
  } satisfies ToolDefinition);
}
