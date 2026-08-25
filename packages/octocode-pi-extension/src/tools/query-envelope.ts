import type { PiContext, ToolCallResult } from '../types.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type TSchema = import('typebox').TSchema;

export const QUERY_REASONING_MAX_LENGTH = 240;
export const QUERY_BATCH_MAX_ITEMS = 100;

export interface QueryEnvelopeOptions {
  maxItems?: number;
  reasoningDescription?: string;
}

export type QueryRecord = Record<string, unknown> & { reasoning: string };

export interface PreparedQueryBatchOptions {
  maxItems?: number;
  preflight?: (query: QueryRecord, index: number) => void | Promise<void>;
}

export interface QueryBatchItemResult {
  index: number;
  reasoning: string;
  result: ToolCallResult;
}

export interface QueryBatchResultRow {
  index: number;
  reasoning: string;
  status: 'success' | 'failed' | 'not-run';
  summary: string;
  result?: unknown;
}

export interface ExecuteQueryBatchOptions extends PreparedQueryBatchOptions {
  toolCallId: string;
  raw: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: (update: ToolCallResult) => void;
  ctx?: PiContext;
  execute: (
    query: QueryRecord,
    index: number,
    itemToolCallId: string,
    signal?: AbortSignal,
    onUpdate?: (update: ToolCallResult) => void,
    ctx?: PiContext,
  ) => Promise<ToolCallResult>;
  summarize?: (result: ToolCallResult, query: QueryRecord, index: number) => string;
  /** Preserve the original result/detail shape when the envelope contains one query. */
  passthroughSingle?: boolean;
}

/**
 * Runtime error for an ordered, non-transactional batch. Earlier successful
 * effects are intentionally retained and their count is exposed to callers.
 */
export class QueryBatchError extends Error {
  readonly failedIndex: number;
  readonly completedCount: number;
  readonly originalError: unknown;
  readonly rows: QueryBatchResultRow[];

  constructor(failedIndex: number, completedCount: number, error: unknown, rows: QueryBatchResultRow[] = []) {
    const detail = error instanceof Error ? error.message : String(error);
    const rowText = rows.length > 0 ? `\n${rows.map((row) => `[${row.index}] ${row.status}: ${row.summary}`).join('\n')}` : '';
    super(`queries[${failedIndex}] failed after ${completedCount} prior queries succeeded: ${detail}${rowText}`);
    this.name = 'QueryBatchError';
    this.failedIndex = failedIndex;
    this.completedCount = completedCount;
    this.originalError = error;
    this.rows = rows;
  }
}

/**
 * Add the universal per-query reasoning field without using Type.Intersect or
 * Type.Union, which keeps the emitted schema accepted by Google-family providers.
 * The caller still owns action-specific runtime preflight.
 */
export function buildQueryEnvelopeSchema(
  Type: TypeBoxBuilder,
  itemSchema: TSchema,
  options: QueryEnvelopeOptions = {},
): TSchema {
  const source = itemSchema as TSchema & {
    properties?: Record<string, TSchema>;
    required?: string[];
  };
  const reasoning = Type.String({
    minLength: 1,
    maxLength: QUERY_REASONING_MAX_LENGTH,
    description: options.reasoningDescription ?? 'Concise reason this operation is necessary.',
  });
  const properties = {
    reasoning,
    ...(source.properties ?? {}),
  };
  const required = [
    'reasoning',
    ...(source.required ?? []).filter((name) => name !== 'reasoning'),
  ];
  const querySchema = Type.Unsafe({
    ...source,
    type: 'object',
    properties,
    required,
  });

  return Type.Object({
    queries: Type.Array(querySchema, {
      minItems: 1,
      maxItems: options.maxItems ?? QUERY_BATCH_MAX_ITEMS,
      description: 'Operations to preflight together and execute in source order.',
    }),
  }, { additionalProperties: false });
}

function assertBatchShape(raw: Record<string, unknown>, maxItems: number): QueryRecord[] {
  const values = raw['queries'];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('queries must be a non-empty array.');
  }
  if (values.length > maxItems) {
    throw new Error(`queries supports at most ${maxItems} operations per call.`);
  }

  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`queries[${index}] must be an object.`);
    }
    const query = value as Record<string, unknown>;
    const reasoning = typeof query['reasoning'] === 'string' ? query['reasoning'].trim() : '';
    if (!reasoning) {
      throw new Error(`queries[${index}] requires non-empty reasoning.`);
    }
    if (reasoning.length > QUERY_REASONING_MAX_LENGTH) {
      throw new Error(`queries[${index}].reasoning must be at most ${QUERY_REASONING_MAX_LENGTH} characters.`);
    }
    return { ...query, reasoning } as QueryRecord;
  });
}

/** Validate the entire batch before any executor is invoked. */
export async function prepareQueryBatch(
  raw: Record<string, unknown>,
  options: PreparedQueryBatchOptions = {},
): Promise<QueryRecord[]> {
  const queries = assertBatchShape(raw, options.maxItems ?? QUERY_BATCH_MAX_ITEMS);
  if (!options.preflight) return queries;

  for (const [index, query] of queries.entries()) {
    try {
      await options.preflight(query, index);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`queries[${index}] failed preflight: ${detail}`);
    }
  }
  return queries;
}

function nonEmptyLines(value: unknown): string[] {
  return typeof value === 'string'
    ? value.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
}

function defaultSummary(result: ToolCallResult): string {
  const details = result.details && typeof result.details === 'object'
    ? result.details as Record<string, unknown>
    : {};
  const text = result.content.find((part) => part.type === 'text') as { text?: string } | undefined;
  const textLines = nonEmptyLines(text?.text);

  if (result.isError) {
    for (const key of ['error', 'message']) {
      const structured = nonEmptyLines(details[key]);
      if (structured.length > 0) return structured.at(-1)!;
    }
    const stderr = nonEmptyLines(details['stderr']);
    if (stderr.length > 0) return stderr.at(-1)!;
    const diagnostics = textLines.filter((line) => !/^\((?:exit|killed by|aborted)\b/i.test(line));
    return diagnostics.at(-1) ?? textLines.at(-1) ?? 'failed';
  }

  return textLines[0] ?? 'ok';
}

function progressResult(index: number, total: number, reasoning: string): ToolCallResult {
  return {
    content: [{ type: 'text', text: `Running query ${index + 1}/${total}: ${reasoning}` }],
    details: { index, total, reasoning },
  };
}

/**
 * Execute a fully preflighted batch in source order. The helper never attempts
 * rollback: a runtime error stops the batch and reports how many effects remain.
 */
export async function executeQueryBatch(options: ExecuteQueryBatchOptions): Promise<ToolCallResult> {
  const queries = await prepareQueryBatch(options.raw, options);
  const results: QueryBatchItemResult[] = [];
  const summarize = options.summarize ?? ((result: ToolCallResult) => defaultSummary(result));
  const successRows = (): QueryBatchResultRow[] => results.map((entry) => ({
    index: entry.index,
    reasoning: entry.reasoning,
    status: 'success',
    summary: summarize(entry.result, queries[entry.index]!, entry.index),
    result: entry.result.details,
  }));

  for (const [index, query] of queries.entries()) {
    if (options.signal?.aborted) {
      throw new QueryBatchError(index, results.length, new Error('query batch aborted'), [
        ...successRows(),
        ...queries.slice(index).map((remaining, offset) => ({ index: index + offset, reasoning: remaining.reasoning, status: 'not-run' as const, summary: 'not run' })),
      ]);
    }
    options.onUpdate?.(progressResult(index, queries.length, query.reasoning));

    let result: ToolCallResult;
    try {
      result = await options.execute(
        query,
        index,
        `${options.toolCallId}:${index}`,
        options.signal,
        options.onUpdate,
        options.ctx,
      );
      if (result.isError && !(options.passthroughSingle && queries.length === 1)) {
        throw new Error(defaultSummary(result));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new QueryBatchError(index, results.length, error, [
        ...successRows(),
        { index, reasoning: query.reasoning, status: 'failed', summary: detail },
        ...queries.slice(index + 1).map((remaining, offset) => ({ index: index + 1 + offset, reasoning: remaining.reasoning, status: 'not-run' as const, summary: 'not run' })),
      ]);
    }
    results.push({ index, reasoning: query.reasoning, result });
  }

  if (options.passthroughSingle && results.length === 1) {
    return results[0]!.result;
  }

  const summaries = results.map((entry) => ({
    index: entry.index,
    reasoning: entry.reasoning,
    status: 'success' as const,
    summary: summarize(entry.result, queries[entry.index]!, entry.index),
    result: entry.result.details,
  }));

  return {
    content: [{
      type: 'text',
      text: `${results.length} quer${results.length === 1 ? 'y' : 'ies'} succeeded.\n${summaries.map((entry) => `[${entry.index}] ${entry.summary}`).join('\n')}`,
    }],
    details: { results: summaries },
  };
}
