import type { PiContext, PiInstance, SessionBeforeCompactEvent, SessionCompactEvent, NotifyFn } from '../types.js';
import { clearCompactionWorkingState, scheduleCompactionContinuation } from './compaction-resume.js';
import { clearCompactionInFlight, consumeCompactionResumeRequest, markCompactionInFlight } from './compaction-state.js';
import { emitCompactionCheckpoint, type CompactionCheckpointDetails } from './custom-messages.js';
import { writeCompactionArtifact } from './compaction-artifacts.js';
import { clearAllReadStates } from './file-state.js';

const SPLIT_TURN_COMPACTION_HEADER = '**Turn Context (split turn):**';
const CUSTOM_COMPACTION_SUMMARY_LIMIT = 12_000;
const CUSTOM_COMPACTION_SECTION_LIMIT = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function hasCustomInstructions(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function messageFromEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return undefined;
  return entry.type === 'message' ? entry.message : entry;
}

export function latestAssistantText(branchEntries: unknown[] | undefined): string {
  if (!Array.isArray(branchEntries)) return '';
  for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
    const message = messageFromEntry(branchEntries[i]);
    if (!isRecord(message) || message.role !== 'assistant') continue;
    return extractTextContent(message.content);
  }
  return '';
}

export function isCompletedSessionAssistantText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('no active task remains')
    || normalized.includes('prior work was already complete')
    || normalized.includes('already complete, verified, and closed')
    || normalized.includes('won’t start any new work unless you ask')
    || normalized.includes("won't start any new work unless you ask");
}

function shouldCancelCompletedManualCompaction(event: SessionBeforeCompactEvent): boolean {
  if (event.reason !== 'manual') return false;
  if (event.willRetry) return false;
  // `/compact some focus` is an explicit user request; respect it. The waste case
  // is Pi/manual compaction firing after a terminal assistant answer with no new
  // task to preserve.
  if (hasCustomInstructions(event.customInstructions)) return false;
  return isCompletedSessionAssistantText(latestAssistantText(event.branchEntries));
}

function truncateText(text: string, limit = CUSTOM_COMPACTION_SECTION_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'thinking' && typeof part.thinking === 'string') return `[thinking] ${part.thinking}`;
      if (part.type === 'toolCall') {
        const name = typeof part.name === 'string' ? part.name : 'tool';
        const args = part.arguments === undefined ? '' : ` ${JSON.stringify(part.arguments)}`;
        return `[tool call] ${name}${args}`;
      }
      if (part.type === 'image') return '[image omitted]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function describeMessage(message: unknown): string {
  if (!isRecord(message)) return '';
  const role = typeof message.role === 'string' ? message.role : 'message';
  const content = extractTextContent(message.content);
  if (content) return `### ${role}\n${truncateText(content)}`;
  if (role === 'toolResult') return `### ${role}\n${truncateText(JSON.stringify(message))}`;
  return `### ${role}\n${truncateText(JSON.stringify(message))}`;
}

function summarizeMessages(messages: unknown[], title: string, maxItems: number): string {
  if (messages.length === 0) return `## ${title}\n(none)`;
  const omitted = Math.max(0, messages.length - maxItems);
  const selected = messages.slice(-maxItems).map(describeMessage).filter(Boolean);
  return [
    `## ${title}`,
    omitted > 0 ? `Omitted ${omitted} older message(s); retained the most recent ${selected.length}.` : undefined,
    ...selected,
  ].filter(Boolean).join('\n\n');
}

function extractFileOps(preparation: Record<string, unknown>): { readFiles: string[]; modifiedFiles: string[] } {
  const fileOps = isRecord(preparation.fileOps) ? preparation.fileOps : {};
  const fromSetLike = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    if (value instanceof Set) return [...value].filter((item): item is string => typeof item === 'string');
    if (isRecord(value)) return Object.keys(value);
    return [];
  };
  // Pi's FileOperations is {read, written, edited}: files created via the
  // write tool count as modified, and modified files are excluded from the
  // read list (mirrors Pi's own computeFileLists).
  const modifiedFiles = [
    ...new Set([...fromSetLike(fileOps.edited), ...fromSetLike(fileOps.written), ...fromSetLike(fileOps.modifiedFiles)]),
  ].sort();
  const modifiedSet = new Set(modifiedFiles);
  const readFiles = [...new Set([...fromSetLike(fileOps.read), ...fromSetLike(fileOps.readFiles)])]
    .filter((file) => !modifiedSet.has(file))
    .sort();
  return { readFiles, modifiedFiles };
}

function formatFileList(title: string, files: string[]): string {
  if (files.length === 0) return `## ${title}\n(none)`;
  return [`## ${title}`, ...files.slice(0, 80).map((file) => `- ${file}`), files.length > 80 ? `- …and ${files.length - 80} more` : undefined]
    .filter(Boolean)
    .join('\n');
}

function buildDeterministicCompaction(preparation: Record<string, unknown>, reason: string, customInstructions: unknown): {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: { readFiles: string[]; modifiedFiles: string[]; fallback: string };
} | null {
  const firstKeptEntryId = asString(preparation.firstKeptEntryId);
  const tokensBefore = asNumber(preparation.tokensBefore);
  if (!firstKeptEntryId || tokensBefore === undefined) return null;

  const messagesToSummarize = asArray(preparation.messagesToSummarize);
  const turnPrefixMessages = asArray(preparation.turnPrefixMessages);
  const previousSummary = asString(preparation.previousSummary);
  const { readFiles, modifiedFiles } = extractFileOps(preparation);
  const focus = asString(customInstructions);

  const summary = [
    '## Octocode deterministic compaction checkpoint',
    `Reason: ${reason}`,
    `Tokens before compaction: ${tokensBefore}`,
    focus ? `Focus instructions: ${focus}` : undefined,
    previousSummary ? `\n## Previous summary\n${truncateText(previousSummary)}` : undefined,
    summarizeMessages(messagesToSummarize, 'Discarded history checkpoint', 10),
    turnPrefixMessages.length > 0
      ? [
          '---',
          SPLIT_TURN_COMPACTION_HEADER,
          summarizeMessages(turnPrefixMessages, 'Split-turn prefix checkpoint', 12),
        ].join('\n\n')
      : undefined,
    formatFileList('Read files', readFiles),
    formatFileList('Modified files', modifiedFiles),
    '## Resume instructions\nRe-orient from retained recent messages. If active work remains, continue with the next small step only; otherwise stop and wait for the user. If output would be long, write it to a file and reply with a concise summary and path.',
  ].filter(Boolean).join('\n\n');

  return {
    summary: truncateText(summary, CUSTOM_COMPACTION_SUMMARY_LIMIT),
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles, fallback: 'octocode-deterministic-compaction' },
  };
}

// ─── Compaction checkpoint card (one per compaction event) ───────────────────
//
// session_compact can be observed more than once for the same compaction
// (multiple registrations across reloads, replayed events); the card must be
// idempotent per compaction. Pi hands us the same compactionEntry object for
// the same compaction, so object identity is the dedupe key; a string key of
// the last emission covers hosts that pass a non-object entry.

const emittedCheckpointEntries = new WeakSet<object>();
let lastCheckpointFallbackKey: string | null = null;

function shouldEmitCheckpointCard(event: SessionCompactEvent): boolean {
  const entry = event.compactionEntry;
  if (entry !== null && entry !== undefined && typeof entry === 'object') {
    if (emittedCheckpointEntries.has(entry)) return false;
    emittedCheckpointEntries.add(entry);
    return true;
  }
  const key = `${event.reason}:${String(entry)}`;
  if (lastCheckpointFallbackKey === key) return false;
  lastCheckpointFallbackKey = key;
  return true;
}

function buildCheckpointDetails(event: SessionCompactEvent): CompactionCheckpointDetails {
  const entry = isRecord(event.compactionEntry) ? event.compactionEntry : {};
  const entryDetails = isRecord(entry.details) ? entry.details : {};
  const tokensBefore = asNumber(entry.tokensBefore);
  const summary = asString(entry.summary);
  const details: CompactionCheckpointDetails = {
    label: asString(entry.id) ?? `${event.reason} compaction`,
    reason: event.reason,
    fromExtension: event.fromExtension,
  };
  if (tokensBefore !== undefined) details.tokensBefore = tokensBefore;
  const readFiles = asStringArray(entryDetails.readFiles);
  const modifiedFiles = asStringArray(entryDetails.modifiedFiles);
  if (readFiles) details.readFiles = readFiles;
  if (modifiedFiles) details.modifiedFiles = modifiedFiles;
  if (summary) details.summary = summary;
  return details;
}

export function resetCompactionCheckpointDedupe(): void {
  lastCheckpointFallbackKey = null;
}

export function registerCompactionHooks(pi: PiInstance, notify: NotifyFn): void {
  if (!pi.on) return;

  pi.on('session_before_compact', async (event: SessionBeforeCompactEvent, ctx: PiContext) => {
    // Every compaction path (pi's internal auto, user /compact, extension
    // ctx.compact) passes through this event — mark the shared arbiter FIRST,
    // before any early return, so the other triggers stand down instead of
    // racing into pi's "Already compacted" throw.
    markCompactionInFlight();
    if (shouldCancelCompletedManualCompaction(event)) {
      clearCompactionInFlight();
      notify(ctx, 'Compaction skipped: the last assistant turn already completed with no active task to preserve.', 'info');
      return { cancel: true };
    }
    const preparation = isRecord(event.preparation) ? event.preparation : undefined;
    if (!preparation) return;
    const turnPrefixMessages = asArray(preparation.turnPrefixMessages);
    const isSplitTurn = preparation.isSplitTurn === true || turnPrefixMessages.length > 0;
    if (!isSplitTurn) return;
    // The deterministic checkpoint is an EMERGENCY path only: on overflow the
    // provider summarization call can itself overflow/fail, so a fast local
    // checkpoint beats losing the compaction entirely. Manual and threshold
    // split-turn compactions keep Pi's LLM summarizer — it produces a far
    // richer summary, and replacing it unconditionally was a silent quality
    // regression on the most common compaction shape.
    if (event.reason !== 'overflow') return;

    const compaction = buildDeterministicCompaction(preparation, event.reason, event.customInstructions);
    if (!compaction) return;

    notify(
      ctx,
      'Using Octocode deterministic split-turn compaction checkpoint (overflow path — provider summarization could overflow too).',
      'warning',
    );
    return { compaction };
  });

  pi.on('session_compact', async (event: SessionCompactEvent, ctx: PiContext) => {
    clearCompactionInFlight();
    // The transcript the read-states were recorded against is gone; the edit
    // tool's stale-read gate must demand a fresh read, not trust pre-compaction
    // knowledge the model no longer has.
    clearAllReadStates();
    if (event.willRetry) {
      // Pi will retry this compaction and fire session_compact again on success.
      // Leave the resume request intact (do NOT consume or clear it) so the
      // successful retry pass schedules the continuation. Consuming it here —
      // as the code originally did before this guard — permanently swallowed
      // the request and the retried compaction never auto-resumed.
      clearCompactionWorkingState(ctx);
      return;
    }
    const shouldResume = consumeCompactionResumeRequest();
    let artifactLatestPath: string | undefined;
    // Completed compaction → branded checkpoint card in the transcript. The
    // dedupe guard makes this idempotent even if the hook observes the same
    // compaction event twice. Content is one terse line (it enters the LLM
    // context); rich data rides in details for the renderer only.
    if (shouldEmitCheckpointCard(event)) {
      const details = buildCheckpointDetails(event);
      const artifact = writeCompactionArtifact(details, ctx.sessionManager);
      if (artifact) {
        details.artifactPath = artifact.path;
        details.latestArtifactPath = artifact.latestPath;
        artifactLatestPath = artifact.latestPath;
      }
      emitCompactionCheckpoint(pi, details);
    }
    // Auto-resume ONLY compactions Octocode requested via ctx.compact: that
    // aborts the in-flight agent run, so a queued follow-up is needed to
    // recover. Pi's event.fromExtension means "summary supplied by extension"
    // (e.g. our overflow fallback), not "ctx.compact was called by extension";
    // manual /compact and Pi's own pre-prompt compaction still stop by design.
    if (!shouldResume) {
      clearCompactionWorkingState(ctx);
      return;
    }
    const docHint = artifactLatestPath ? ` Compaction doc: ${artifactLatestPath}.` : '';
    const continuation =
      `Compaction is complete.${docHint} Re-orient from the compacted context. If an active task remains, continue with its next small step only; if the prior work was already complete, do not start new work — reply briefly and stop. If the answer would be long, write it to a file and reply with a concise summary and path.`;
    scheduleCompactionContinuation(pi, ctx, notify, continuation, 'Compaction complete. Resuming…');
  });
}

export const __test__ = {
  buildDeterministicCompaction,
};
