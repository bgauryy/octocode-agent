import type { PiContext, PiInstance, SessionBeforeCompactEvent, SessionCompactEvent } from '../types.js';
import { clearCompactionWorkingState, scheduleCompactionContinuation, type Notifier } from './compaction-resume.js';

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
  return {
    readFiles: [...new Set(fromSetLike(fileOps.read).concat(fromSetLike(fileOps.readFiles)))].sort(),
    modifiedFiles: [...new Set(fromSetLike(fileOps.edited).concat(fromSetLike(fileOps.modifiedFiles)))].sort(),
  };
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
    '## Resume instructions\nRe-orient from retained recent messages. Continue with the next small step only. If output would be long, write it to a file and reply with a concise summary and path.',
  ].filter(Boolean).join('\n\n');

  return {
    summary: truncateText(summary, CUSTOM_COMPACTION_SUMMARY_LIMIT),
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles, fallback: 'octocode-deterministic-compaction' },
  };
}

export function registerCompactionHooks(pi: PiInstance, notify: Notifier): void {
  if (!pi.on) return;

  pi.on('session_before_compact', async (event: SessionBeforeCompactEvent, ctx: PiContext) => {
    const preparation = isRecord(event.preparation) ? event.preparation : undefined;
    if (!preparation) return;
    const turnPrefixMessages = asArray(preparation.turnPrefixMessages);
    const isSplitTurn = preparation.isSplitTurn === true || turnPrefixMessages.length > 0;
    if (!isSplitTurn) return;

    const compaction = buildDeterministicCompaction(preparation, event.reason, event.customInstructions);
    if (!compaction) return;

    notify(
      ctx,
      'Using Octocode deterministic split-turn compaction fallback to avoid provider turn-prefix summarization failures.',
      'warning',
    );
    return { compaction };
  });

  pi.on('session_compact', async (event: SessionCompactEvent, ctx: PiContext) => {
    if (event.willRetry) {
      clearCompactionWorkingState(ctx);
      return;
    }
    const continuation =
      event.reason === 'manual'
        ? 'Compaction is complete. Re-orient from the compacted context, then continue with the next small step only. If the answer would be long, write it to a file and reply with a concise summary and path.'
        : 'Auto-compaction complete. Re-orient from the compacted context, then continue with the next small step only. If the answer would be long, write it to a file and reply with a concise summary and path.';
    scheduleCompactionContinuation(
      pi,
      ctx,
      notify,
      continuation,
      event.reason === 'manual' ? 'Compaction complete. Resuming…' : 'Auto-compaction complete. Resuming…',
    );
  });
}

export const __test__ = {
  buildDeterministicCompaction,
};
