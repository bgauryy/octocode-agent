import { compact, type ContextEditEntryDraft, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { FileGuard } from './file-tool.js';
import { isRecord } from './util.js';

/** Most recent tool results always stay verbatim. */
export const KEEP_RECENT_RESULTS = 12;
/** Older results are trimmed in steps so the trimmed prefix (and the prompt cache) changes rarely. */
export const TRIM_STEP = 10;
export const TRIM_ABOVE_CHARS = 3_000;
export const TRIM_KEEP_CHARS = 1_200;

export const COMPACTION_FOCUS = [
  'Octocode continuation priorities:',
  "- Keep the user's requests, constraints and preferences verbatim.",
  '- List every file created or changed and what changed in it.',
  '- Keep exact error messages, failing test names, and the commands that build/test/verify the work.',
  '- Record decisions with their reasons, subagent results, and anything ruled out.',
  '- State what is in progress and the precise next step.',
  '- Drop exploration that led nowhere unless it rules something out.',
].join('\n');

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

  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return undefined;
      const focus = event.customInstructions ? `${COMPACTION_FOCUS}\n\nUser focus: ${event.customInstructions}` : COMPACTION_FOCUS;
      const headers = Object.fromEntries(Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const compaction = await compact(event.preparation, model, auth.apiKey, headers, focus, event.signal, ctx.thinkingLevel);
      return { compaction };
    } catch {
      // A cancelled compaction stays cancelled; any other failure falls back to Pi's default summarizer.
      return event.signal.aborted ? { cancel: true } : undefined;
    }
  });

  // File contents read before compaction, or on another branch, are no longer in context: require fresh reads.
  pi.on('session_compact', async () => guard.reset());
  pi.on('session_tree', async () => guard.reset());
}
