import fs from 'node:fs';
import path from 'node:path';
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  renderDiff,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { errorMessage, isRecord } from './util.js';

/**
 * Octocode's `file` tool: batched edit / write / delete queries, each with a
 * reasoning line. Edits and writes run through Pi's own engines (exact-match
 * replacement, diffs, per-file mutation queue). Reads come from Octocode's
 * localGetFileContent; a file that changed since it was read must be read again.
 */

interface Snapshot {
  mtimeMs: number;
  size: number;
}

export class FileGuard {
  readonly #seen = new Map<string, Snapshot>();

  record(file: string): void {
    const stat = statOf(file);
    if (stat) this.#seen.set(file, stat);
    else this.#seen.delete(file);
  }

  /** Forget everything, e.g. after compaction drops file contents from context. */
  reset(): void {
    this.#seen.clear();
  }

  /** Returns an error message when the mutation must be refused, else undefined. */
  check(file: string, mode: 'edit' | 'write' | 'delete', display: string): string | undefined {
    const current = statOf(file);
    if (!current) return mode === 'edit' || mode === 'delete' ? `${display} does not exist.` : undefined;
    const seen = this.#seen.get(file);
    if (!seen) {
      return mode === 'write' ? `${display} already exists and has not been read in this session. Read it first, or use an edit query.` : undefined;
    }
    if (seen.mtimeMs !== current.mtimeMs || seen.size !== current.size) {
      return `${display} changed on disk since you last read it. Read it again before modifying it.`;
    }
    return undefined;
  }
}

function statOf(file: string): Snapshot | undefined {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePath(cwd: string, raw: string): string {
  return path.resolve(cwd, raw.startsWith('@') ? raw.slice(1) : raw);
}

const QuerySchema = Type.Object({
  reasoning: Type.String({ description: 'Why this change is needed, in one sentence' }),
  // A plain string enum (what pi-ai's StringEnum emits) keeps the schema portable across providers.
  type: Type.Unsafe<'edit' | 'write' | 'delete'>({
    type: 'string',
    enum: ['edit', 'write', 'delete'],
    description: 'edit: exact replacements in an existing file; write: create or fully replace a file; delete: remove a file',
  }),
  path: Type.String({ description: 'File path, relative to the working directory or absolute' }),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        oldText: Type.String({ description: 'Exact text to replace; must be unique in the original file' }),
        newText: Type.String({ description: 'Replacement text' }),
      }),
      { minItems: 1, description: 'For edit: all replacements for this file, matched against the original content' },
    ),
  ),
  content: Type.Optional(Type.String({ description: 'For write: the complete new file content' })),
});

const Params = Type.Object({ queries: Type.Array(QuerySchema, { minItems: 1, maxItems: 10 }) });
type FileQuery = Static<typeof QuerySchema>;

export interface QueryOutcome {
  type: FileQuery['type'];
  path: string;
  reasoning: string;
  ok: boolean;
  message: string;
  diff?: string;
}

async function runQuery(query: FileQuery, index: number, id: string, guard: FileGuard, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<QueryOutcome> {
  const base = { type: query.type, path: query.path, reasoning: query.reasoning };
  const file = resolvePath(ctx.cwd, query.path);
  try {
    if (query.type === 'edit' && !query.edits?.length) throw new Error('edit needs a non-empty edits array.');
    if (query.type === 'write' && query.content === undefined) throw new Error('write needs content.');
    const refusal = guard.check(file, query.type, query.path);
    if (refusal) throw new Error(refusal);
    if (query.type === 'delete') {
      await withFileMutationQueue(file, async () => fs.promises.rm(file));
      guard.record(file);
      return { ...base, ok: true, message: `Deleted ${query.path}` };
    }
    const tool = query.type === 'edit' ? createEditToolDefinition(ctx.cwd) : createWriteToolDefinition(ctx.cwd);
    const args = query.type === 'edit' ? { path: query.path, edits: query.edits } : { path: query.path, content: query.content };
    const result = await tool.execute(`${id}:${index}`, args as never, signal, undefined, ctx);
    guard.record(file);
    const message = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n').trim() || `${query.type} ${query.path}`;
    const diff = isRecord(result.details) && typeof result.details['diff'] === 'string' ? result.details['diff'] : undefined;
    return { ...base, ok: true, message, ...(diff ? { diff } : {}) };
  } catch (error) {
    return { ...base, ok: false, message: errorMessage(error) };
  }
}

export function formatOutcomes(outcomes: QueryOutcome[]): string {
  return outcomes.map((outcome, index) => `${index + 1}. ${outcome.ok ? 'OK' : 'FAILED'} ${outcome.type} ${outcome.path}: ${outcome.message}`).join('\n');
}

/** Paths the model has read (Octocode localGetFileContent / localFetch, or Pi's read when Octocode is unavailable). */
export function readPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  if (toolName === 'read') return typeof input['path'] === 'string' ? [resolvePath(cwd, input['path'])] : [];
  if (!/_(localGetFileContent|localFetch)$/.test(toolName)) return [];
  const queries = Array.isArray(input['queries']) ? input['queries'] : [input];
  return queries.filter(isRecord).flatMap((query) => (typeof query['path'] === 'string' ? [resolvePath(cwd, query['path'])] : []));
}

export function registerFileTool(pi: ExtensionAPI, guard: FileGuard): void {
  pi.registerTool({
    name: 'file',
    label: 'File',
    description:
      'Change files with a batch of queries, applied in order. Each query has a one-sentence reasoning and a type: ' +
      'edit (exact oldText→newText replacements in an existing file; put all edits to one file in one query), ' +
      'write (create a new file, or fully replace a file you have read), or delete (remove a file). ' +
      'Read files first (the Octocode local file tool, or read when Octocode is unavailable); a file that changed since you read it must be read again. Each query reports OK or FAILED independently.',
    promptSnippet: 'Edit, write or delete files in one batched call (each query has a reasoning)',
    promptGuidelines: [
      'Use file for every file change; batch related changes across files into one file call with several queries.',
      'In file edit queries, each oldText must match the original file exactly and be unique; keep it small and do not overlap edits.',
    ],
    executionMode: 'sequential',
    parameters: Params,
    async execute(id, params, signal, _onUpdate, ctx) {
      const outcomes: QueryOutcome[] = [];
      for (const [index, query] of params.queries.entries()) outcomes.push(await runQuery(query, index, id, guard, ctx, signal));
      if (outcomes.every((outcome) => !outcome.ok)) throw new Error(formatOutcomes(outcomes));
      return { content: [{ type: 'text', text: formatOutcomes(outcomes) }], details: { outcomes } };
    },
    renderCall(args, theme) {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      const lines = queries.map((query) => `  ${theme.fg('accent', query.type ?? '?')} ${theme.fg('mdCode', query.path ?? '')} ${theme.fg('dim', query.reasoning ?? '')}`);
      return new Text([theme.fg('toolTitle', theme.bold('file')), ...lines].join('\n'), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const outcomes = (isRecord(result.details) && Array.isArray(result.details['outcomes']) ? result.details['outcomes'] : []) as QueryOutcome[];
      if (outcomes.length === 0) return new Text(result.content.map((part) => (part.type === 'text' ? theme.fg('error', part.text) : '')).join('\n'), 0, 0);
      const lines = outcomes.flatMap((outcome) => {
        const head = `${outcome.ok ? theme.fg('success', '✓') : theme.fg('error', '✗')} ${outcome.type} ${theme.fg('mdCode', outcome.path)}${outcome.ok ? '' : ` ${theme.fg('error', outcome.message)}`}`;
        return expanded && outcome.diff ? [head, renderDiff(outcome.diff)] : [head];
      });
      return new Text(lines.join('\n'), 0, 0);
    },
  });

  pi.on('tool_result', async (event, ctx) => {
    if (event.isError) return;
    for (const file of readPaths(event.toolName, event.input, ctx.cwd)) guard.record(file);
  });
}
