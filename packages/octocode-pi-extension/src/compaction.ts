import type { RetryPolicy, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { buildCompaction, pickCompactionModel, summaryInputTokens, type SummaryRuntime } from './compaction-summary.js';
import {
  getAgentDir,
  SettingsManager,
  type CompactionResult,
  type ContextEditEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import type { FileGuard } from './file-tool.js';
import { isRecord } from './util.js';

/** Most recent tool results always stay verbatim. */
export const KEEP_RECENT_RESULTS = 12;
/** Older results are trimmed in steps so the trimmed prefix (and the prompt cache) changes rarely. */
export const TRIM_STEP = 10;
export const TRIM_ABOVE_CHARS = 3_000;
export const TRIM_KEEP_CHARS = 1_200;

/** Subagent reports are distilled, expensive to regenerate results: never trimmed. */
const KEEP_VERBATIM_TOOLS = new Set(['agent']);

export interface ContextEntry {
  id: string;
  message: unknown;
}

/**
 * Plan append-only context edits that shrink old, large tool results. Pi keeps
 * the raw output in the session; only future model context changes. Edits are
 * proposed in batches of TRIM_STEP so the cached prompt prefix changes rarely.
 */
export function planToolResultTrims(entries: ContextEntry[]): ContextEditEntryDraft[] {
  const results = entries.filter((entry) => isRecord(entry.message) && entry.message['role'] === 'toolResult');
  const candidates = results
    .slice(0, Math.max(0, results.length - KEEP_RECENT_RESULTS))
    .filter((entry) => !KEEP_VERBATIM_TOOLS.has(String((entry.message as Record<string, unknown>)['toolName'])) && needsTrim(entry.message));
  if (candidates.length < TRIM_STEP) return [];
  return candidates.map((entry) => ({
    type: 'context_edit',
    targetId: entry.id,
    replacement: { content: trimmedContent(entry.message) },
  }));
}

function parts(message: unknown): unknown[] {
  return isRecord(message) && Array.isArray(message['content']) ? message['content'] : [];
}

function needsTrim(message: unknown): boolean {
  return parts(message).some(
    (part) => isRecord(part) && (part['type'] === 'image' || (part['type'] === 'text' && typeof part['text'] === 'string' && part['text'].length > TRIM_ABOVE_CHARS)),
  );
}

function trimmedContent(message: unknown): Array<{ type: 'text'; text: string }> {
  return parts(message).flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part['type'] === 'image') return [{ type: 'text' as const, text: '[image from an earlier tool call omitted]' }];
    if (part['type'] !== 'text' || typeof part['text'] !== 'string') return [];
    const text = part['text'];
    if (text.length <= TRIM_ABOVE_CHARS) return [{ type: 'text' as const, text }];
    return [{ type: 'text' as const, text: `${text.slice(0, TRIM_KEEP_CHARS)}\n[… ${text.length - TRIM_KEEP_CHARS} more characters from this earlier tool result were trimmed; re-run the tool if you need them.]` }];
  });
}

export function registerCompaction(pi: ExtensionAPI, guard: FileGuard): void {
  pi.on('turn_end', async (event) => {
    const entries = event.context.contextEntries.flatMap((entry) =>
      entry.sourceEntry.type === 'message' && entry.messages.length === 1 ? [{ id: entry.sourceEntry.id, message: entry.messages[0] }] : [],
    );
    const trims = planToolResultTrims(entries);
    return trims.length > 0 ? { entries: [...event.entries, ...trims] } : undefined;
  });

  pi.on('session_before_compact', async (event, ctx) => octocodeCompaction(event, ctx));

  // File contents read before compaction, or on another branch, are no longer in context: require fresh reads.
  pi.on('session_compact', async () => guard.reset());
  pi.on('session_tree', async () => guard.reset());
}

/** What an extension can reproduce of Pi's own request settings: retries and transport timeouts. */
export interface CompactionRequestSettings {
  retry: RetryPolicy;
  request: Pick<SimpleStreamOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs'> & { websocketConnectTimeoutMs?: number };
}

/** Read the user's retry and timeout settings the way Pi does, so the summary call behaves like Pi's own. */
export function compactionRequestSettings(settings: SettingsManager): CompactionRequestSettings {
  const provider = settings.getProviderRetrySettings();
  const idle = settings.getHttpIdleTimeoutMs();
  const websocketConnectTimeoutMs = settings.getWebSocketConnectTimeoutMs();
  return {
    retry: settings.getRetrySettings(),
    request: {
      timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
      ...(provider.maxRetries !== undefined ? { maxRetries: provider.maxRetries } : {}),
      ...(provider.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: provider.maxRetryDelayMs } : {}),
      ...(websocketConnectTimeoutMs !== undefined ? { websocketConnectTimeoutMs } : {}),
    },
  };
}

function loadRequestSettings(ctx: ExtensionContext): CompactionRequestSettings | undefined {
  try {
    return compactionRequestSettings(SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }));
  } catch {
    return undefined;
  }
}

/**
 * Octocode's compaction on Pi's preparation and request path. The summary uses Octocode's prompt and, when one
 * fits, a cheaper small-tier model of the same provider; requests go through the model registry (request-time
 * auth: API key, headers, per-token base URL, provider env) with the user's retry policy and timeouts.
 * Fallbacks: small model → session model → Pi's default summarizer. A cancelled compaction stays cancelled.
 */
export async function octocodeCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<{ compaction: CompactionResult } | { cancel: true } | undefined> {
  const current = ctx.model;
  if (!current) return undefined;
  const settings = loadRequestSettings(ctx);
  const runtime: SummaryRuntime = {
    stream: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
    signal: event.signal,
    ...(settings ? { retry: settings.retry, request: settings.request } : {}),
    callbacks: {
      onRetryScheduled: (attempt, maxAttempts, delayMs) => {
        if (ctx.hasUI) ctx.ui.setWorkingMessage(`Compaction retry ${attempt}/${maxAttempts} in ${Math.ceil(delayMs / 1000)}s…`);
      },
      onRetryFinished: () => {
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
      },
    },
  };
  const choice = pickCompactionModel(current, ctx.modelRegistry.getAvailable(), summaryInputTokens(event.preparation));
  const attempts = choice.model === current ? [current] : [choice.model, current];
  for (const model of attempts) {
    try {
      // Thinking follows the session only on the session model; small-model summaries run without it.
      const compaction = await buildCompaction(event.preparation, event.branchEntries, model, { ...runtime, ...(model === current && ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}) }, event.customInstructions);
      return { compaction };
    } catch {
      if (event.signal.aborted) return { cancel: true };
    }
  }
  return undefined;
}
