import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, RetryCallbacks, RetryPolicy, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import { contentText, retryAssistantCall, uuidv7 } from '@earendil-works/pi-ai';
import { convertToLlm, estimateTokens, serializeConversation, type CompactionResult, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { COMPACTION_SYSTEM_PROMPT, compactionPrompt, summaryLooksComplete, TURN_PREFIX_PROMPT } from './compaction-prompt.js';
import { isRecord } from './util.js';

type Preparation = SessionBeforeCompactEvent['preparation'];
type AgentMessage = Preparation['messagesToSummarize'][number];
type ThinkingLevel = SimpleStreamOptions['reasoning'] | 'off';

/** Small-tier model families across providers (Anthropic Haiku, OpenAI mini/nano/luna, Gemini Flash/Lite…). */
const SMALL_TIER = /haiku|luna|nano|flash|lite|(^|[-_/.])mini($|[-_.:])|small/i;
/** Variants that are not general chat models or answer asynchronously. */
const NOT_FOR_SUMMARIES = /minimax|image|audio|tts|realtime|embed|transcribe|search|:batch|vision-exp/i;
/** Prompt text, previous summary and safety margin on top of the serialized conversation. */
const PROMPT_OVERHEAD_TOKENS = 4_000;
/** Small models with a tight output cap return truncated or empty summaries (Cline raised its cap to 8k for this). */
const MIN_SUMMARY_OUTPUT_TOKENS = 8_192;

export interface CompactionModelChoice {
  model: Model<Api>;
  /** Why this model was chosen, for details and diagnostics. */
  reason: 'override' | 'small' | 'current';
}

/**
 * The model that writes the summary. `OCTOCODE_COMPACTION_MODEL` = `provider/id` pins one, `current` keeps the
 * session model; by default the strongest small-tier model of the same provider is used when it is cheaper, has
 * auth, and fits the whole summary input — otherwise the session model.
 */
export function pickCompactionModel(current: Model<Api>, available: readonly Model<Api>[], neededTokens: number, override = process.env['OCTOCODE_COMPACTION_MODEL']): CompactionModelChoice {
  const pinned = override?.trim();
  if (pinned === 'current') return { model: current, reason: 'current' };
  if (pinned) {
    const slash = pinned.indexOf('/');
    const model = available.find((candidate) => candidate.provider === pinned.slice(0, slash) && candidate.id === pinned.slice(slash + 1));
    if (model && model.contextWindow >= neededTokens) return { model, reason: 'override' };
    return { model: current, reason: 'current' };
  }
  const currentCost = current.cost?.input ?? 0;
  if (currentCost <= 0) return { model: current, reason: 'current' };
  const small = available
    .filter(
      (candidate) =>
        candidate.provider === current.provider &&
        candidate.id !== current.id &&
        SMALL_TIER.test(candidate.id) &&
        !NOT_FOR_SUMMARIES.test(candidate.id) &&
        candidate.contextWindow >= neededTokens &&
        candidate.maxTokens >= MIN_SUMMARY_OUTPUT_TOKENS &&
        (candidate.cost?.input ?? 0) > 0 &&
        candidate.cost.input < currentCost,
    )
    // The strongest of the cheap models: price is the best capability signal the catalog has.
    .sort((a, b) => b.cost.input - a.cost.input || b.contextWindow - a.contextWindow);
  return small[0] ? { model: small[0], reason: 'small' } : { model: current, reason: 'current' };
}

/** Tokens the summary request needs: serialized input, prompt overhead and the output budget. */
export function summaryInputTokens(preparation: Preparation): number {
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const input = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return input + Math.ceil((preparation.previousSummary?.length ?? 0) / 4) + PROMPT_OVERHEAD_TOKENS + summaryMaxTokens(preparation);
}

function summaryMaxTokens(preparation: Preparation): number {
  return Math.floor(0.8 * preparation.settings.reserveTokens);
}

export interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

/**
 * Files read and changed, across compactions. Pi tracks its own read/write/edit tools and carries lists forward
 * only from Pi-generated compactions; Octocode adds its `file` tool, its local read tools, and the lists of
 * earlier Octocode compactions (which Pi skips because they come from an extension).
 */
export function collectFileLists(preparation: Preparation, branchEntries: readonly unknown[]): FileLists {
  const read = new Set(preparation.fileOps.read);
  const modified = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
  const previous = [...branchEntries].reverse().find((entry) => isRecord(entry) && entry['type'] === 'compaction');
  if (isRecord(previous) && previous['fromHook'] === true && isRecord(previous['details'])) {
    for (const file of stringList(previous['details']['readFiles'])) read.add(file);
    for (const file of stringList(previous['details']['modifiedFiles'])) modified.add(file);
  }
  for (const message of [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]) {
    for (const call of toolCalls(message)) {
      if (call.name === 'file') {
        for (const query of Array.isArray(call.args['queries']) ? call.args['queries'].filter(isRecord) : []) {
          if (typeof query['path'] === 'string') modified.add(query['path']);
        }
      } else if (/_(localGetFileContent|localFetch)$/.test(call.name)) {
        const queries = Array.isArray(call.args['queries']) ? call.args['queries'].filter(isRecord) : [call.args];
        for (const query of queries) if (typeof query['path'] === 'string') read.add(query['path']);
      }
    }
  }
  return { readFiles: [...read].filter((file) => !modified.has(file)).sort(), modifiedFiles: [...modified].sort() };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toolCalls(entry: AgentMessage): Array<{ name: string; args: Record<string, unknown> }> {
  const message: unknown = entry;
  if (!isRecord(message) || message['role'] !== 'assistant' || !Array.isArray(message['content'])) return [];
  return (message['content'] as unknown[]).flatMap((block) =>
    isRecord(block) && block['type'] === 'toolCall' && typeof block['name'] === 'string' && isRecord(block['arguments']) ? [{ name: block['name'], args: block['arguments'] }] : [],
  );
}

/** Same tags Pi appends, so the continuing model sees one format whichever summarizer ran. */
export function formatFileLists({ readFiles, modifiedFiles }: FileLists): string {
  const sections = [
    ...(readFiles.length > 0 ? [`<read-files>\n${readFiles.join('\n')}\n</read-files>`] : []),
    ...(modifiedFiles.length > 0 ? [`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`] : []),
  ];
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

export interface SummaryRuntime {
  stream: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => AssistantMessageEventStream;
  signal: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  retry?: RetryPolicy;
  callbacks?: RetryCallbacks;
  /** Transport settings (timeouts, provider retries) applied to every request. */
  request?: Partial<SimpleStreamOptions>;
}

/** One summary call: no tools, no prompt cache, retried per the user's policy, rejected when cut off. */
async function summarize(model: Model<Api>, prompt: string, maxTokens: number, runtime: SummaryRuntime, label: string): Promise<{ text: string; usage: Usage }> {
  const context: Context = { systemPrompt: COMPACTION_SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }] };
  const options: SimpleStreamOptions = {
    ...runtime.request,
    maxTokens: Math.min(maxTokens, model.maxTokens > 0 ? model.maxTokens : maxTokens),
    signal: runtime.signal,
    cacheRetention: 'none',
    sessionId: uuidv7(),
    ...(model.reasoning && runtime.thinkingLevel && runtime.thinkingLevel !== 'off' ? { reasoning: runtime.thinkingLevel } : {}),
  };
  const response: AssistantMessage = await retryAssistantCall(async () => runtime.stream(model, context, options).result(), runtime.retry, runtime.signal, runtime.callbacks);
  if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(`${label} failed: ${response.errorMessage || response.stopReason}`);
  if (response.stopReason === 'length') throw new Error(`${label} failed: the summary hit the token cap and is incomplete`);
  if (response.content.some((block) => block.type === 'toolCall')) throw new Error(`${label} attempted to call a tool`);
  const text = contentText(response.content).trim();
  if (!text) throw new Error(`${label} returned no text`);
  return { text: stripAnalysis(text), usage: response.usage };
}

/** The prompt asks for a private <analysis> pass before the <summary>; only the summary is kept. */
export function stripAnalysis(text: string): string {
  const summary = /<summary>([\s\S]*?)(?:<\/summary>|$)/i.exec(text)?.[1];
  return (summary ?? text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')).trim();
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function conversationText(messages: AgentMessage[]): string {
  return serializeConversation(convertToLlm(messages));
}

/**
 * Octocode's compaction: Pi's preparation (cut point, split turns, previous summary, budgets) with Octocode's
 * summary prompt. A split turn gets a separate prefix summary, as in Pi.
 */
export async function buildCompaction(
  preparation: Preparation,
  branchEntries: readonly unknown[],
  model: Model<Api>,
  runtime: SummaryRuntime,
  userFocus?: string,
): Promise<CompactionResult<FileLists & { summaryModel: string }>> {
  const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary, firstKeptEntryId, tokensBefore } = preparation;
  if (!firstKeptEntryId) throw new Error('First kept entry has no id');
  const maxTokens = summaryMaxTokens(preparation);
  let summary = previousSummary ?? 'No prior history.';
  let usage: Usage | undefined;
  if (messagesToSummarize.length > 0 || !isSplitTurn) {
    const prompt = [
      `<conversation>\n${conversationText(messagesToSummarize)}\n</conversation>`,
      ...(previousSummary ? [`<previous-summary>\n${previousSummary}\n</previous-summary>`] : []),
      compactionPrompt({ update: previousSummary !== undefined, ...(userFocus ? { userFocus } : {}) }),
    ].join('\n\n');
    const history = await summarize(model, prompt, maxTokens, runtime, 'Summary');
    // A summary that lost the format would silently drop intent or follow-ups: let the next model try instead.
    if (!summaryLooksComplete(history.text)) throw new Error(`Summary from ${model.id} is missing required sections`);
    summary = history.text;
    usage = history.usage;
  }
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const prompt = `<conversation>\n${conversationText(turnPrefixMessages)}\n</conversation>\n\n${TURN_PREFIX_PROMPT}`;
    const prefix = await summarize(model, prompt, Math.floor(0.5 * preparation.settings.reserveTokens), runtime, 'Turn prefix summary');
    summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = usage ? addUsage(usage, prefix.usage) : prefix.usage;
  }
  const files = collectFileLists(preparation, branchEntries);
  return {
    summary: `${summary}${formatFileLists(files)}`,
    firstKeptEntryId,
    tokensBefore,
    ...(usage ? { usage } : {}),
    details: { ...files, summaryModel: `${model.provider}/${model.id}` },
  };
}
