/**
 * Octocode `write` — same-name override of Pi's built-in write.
 * Adds path-guard (home + ALLOWED_PATHS + cwd/tmp) and records read-state
 * so a subsequent `edit` stale-check can see the fresh bytes.
 */
import path from 'node:path';
import type { TSchema, ToolCallResult, ToolDefinition, PiTheme } from '../types.js';
import { cliToolTitle, paint, CLI_GLYPH } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { assertPathAllowed } from './path-guard.js';
import { atomicWriteUtf8, recordFileReadState, withFileMutationQueue } from './file-state.js';
import { peerWipNotice, markOwnWrite } from './peer-wip.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { buildQueryEnvelopeSchema, executeQueryBatch } from './query-envelope.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

const WRITE_TOOL_DISPLAY_NAME = 'write (Octocode)';

export function resolveWritePath(filePath: string, cwd = process.cwd()): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

export function validateWriteParams(params: Record<string, unknown>): { path: string; content: string; reasoning: string } {
  // Pi render path accepts file_path; fold it for compatibility.
  const rawPath = params['path'] ?? params['file_path'];
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('Write tool input is invalid. path must be a non-empty string.');
  }
  if (typeof params['content'] !== 'string') {
    throw new Error('Write tool input is invalid. content must be a string.');
  }
  if (typeof params['reasoning'] !== 'string' || params['reasoning'].trim().length === 0) {
    throw new Error('Write tool input is invalid. reasoning is required — provide a non-empty string explaining why this write is necessary.');
  }
  return { path: rawPath, content: params['content'], reasoning: params['reasoning'] };
}

/** Execute one path-guarded write after the caller has preflighted the batch. */
export async function commitWrite(
  requestPath: string,
  content: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const absolutePath = resolveWritePath(requestPath, cwd);
  if (signal?.aborted) throw new Error('Operation aborted');
  const peerNotice = peerWipNotice(absolutePath, requestPath);

  await withFileMutationQueue(absolutePath, async () => {
    if (signal?.aborted) throw new Error('Operation aborted');
    await atomicWriteUtf8(absolutePath, content);
    if (signal?.aborted) throw new Error('Operation aborted');
    await recordFileReadState(absolutePath, cwd);
    markOwnWrite(absolutePath);
  });

  return {
    content: [{
      type: 'text',
      text: `Successfully wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${requestPath}${peerNotice}`,
    }],
    details: {
      operation: 'write',
      path: requestPath,
      absolutePath,
      bytes: Buffer.byteLength(content, 'utf8'),
    },
  };
}

export function registerWriteTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  const querySchema = Type.Object(
    {
      path: Type.String({ description: 'Path to the file to write (relative or absolute).' }),
      content: Type.String({ description: 'Content to write to the file.' }),
    },
    { additionalProperties: false },
  ) as TSchema;
  const parameters = buildQueryEnvelopeSchema(Type, querySchema, {
    reasoningDescription: 'Concise reason this file create or overwrite is necessary.',
  });

  registerFn(pi, registeredToolNames, {
    name: 'write',
    label: 'write (Octocode)',
    description:
      'Octocode custom write tool. Pass one or more ordered writes in queries; each query requires concise reasoning. Replaces Pi built-in write with the same create/overwrite semantics plus Octocode path-guard (working directory, home, OS temp, ALLOWED_PATHS) and post-write read-state recording for the edit stale-check. Batches are preflighted, ordered, non-transactional, and stop on the first runtime failure. Prefer edit for surgical changes to existing files.',
    promptSnippet: 'Create or overwrite files with Octocode path-guard.',
    promptGuidelines: [
      'Octocode custom write replaces Pi built-in write; use write only for new files or intentional full rewrites.',
      'Prefer the edit tool for targeted replacements in existing files — write overwrites without an oldText match guard.',
      'Paths must stay inside the working directory, home directory, OS temp dir, or ALLOWED_PATHS.',
      'Do not use bash/cat redirection for ordinary file creates when write is available.',
    ],
    parameters,
    prepareArguments(args: unknown) {
      if (!args || typeof args !== 'object') return args;
      const normalize = (value: unknown): unknown => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const input = value as Record<string, unknown>;
        if (typeof input['path'] !== 'string' && typeof input['file_path'] === 'string') {
          const { file_path: legacyPath, ...rest } = input;
          return { ...rest, path: legacyPath };
        }
        return input;
      };
      const input = args as Record<string, unknown>;
      if (Array.isArray(input['queries'])) return { queries: input['queries'].map(normalize) };
      return { queries: [normalize(input)] };
    },
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: { cwd?: string },
    ): Promise<ToolCallResult> {
      const cwd = ctx?.cwd ?? process.cwd();
      return executeQueryBatch({
        toolCallId,
        raw: params,
        signal,
        onUpdate: typeof onUpdate === 'function' ? onUpdate as (update: ToolCallResult) => void : undefined,
        ctx,
        passthroughSingle: true,
        preflight(query) {
          const { path: requestPath } = validateWriteParams(query);
          assertPathAllowed(resolveWritePath(requestPath, cwd), cwd, 'write');
        },
        async execute(query) {
          const { path: requestPath, content } = validateWriteParams(query);
          return commitWrite(requestPath, content, cwd, signal);
        },
      });
    },
    renderCall(args: unknown, theme?: PiTheme) {
      const envelope = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      const queries = Array.isArray(envelope['queries']) ? envelope['queries'] as Record<string, unknown>[] : [];
      const input = queries[0] ?? envelope;
      const more = queries.length > 1 ? ` +${queries.length - 1}` : '';
      const filePath =
        typeof input['path'] === 'string'
          ? input['path']
          : typeof input['file_path'] === 'string'
            ? input['file_path']
            : '(missing path)';
      const content = typeof input['content'] === 'string' ? input['content'] : '';
      const reasoning = typeof input['reasoning'] === 'string' ? input['reasoning'].trim() : '';
      const lines = content.length === 0 ? 0 : content.split('\n').length;
      const title = cliToolTitle(theme, WRITE_TOOL_DISPLAY_NAME);
      const suffix = paint(theme, 'dim', `${filePath} · ${lines} line${lines === 1 ? '' : 's'}${more}`);
      return makeRenderer((width) => [
        truncateToWidth(`${title} ${suffix}`, width),
        ...(reasoning ? [truncateToWidth(`  why: ${paint(theme, 'dim', reasoning)}`, width)] : []),
      ]);
    },
    renderResult(result: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme) {
      if (opts.isPartial) {
        const prog = paint(theme, 'brand', `… writing ${WRITE_TOOL_DISPLAY_NAME}`);
        return makeRenderer((width) => [truncateToWidth(prog, width)]);
      }
      if (!result.isError) {
        const batch = (result.details ?? {}) as { results?: unknown[] };
        if (Array.isArray(batch.results)) {
          const line = `${paint(theme, 'success', CLI_GLYPH.success)} ${cliToolTitle(theme, WRITE_TOOL_DISPLAY_NAME)}${paint(theme, 'dim', ` · ${batch.results.length} writes`)}`;
          return makeRenderer((width) => [truncateToWidth(line, width)]);
        }
        // Result row shows WHAT was written: path + size (the model's text line
        // says the same thing; the user should not have to expand to see it).
        const d = (result.details ?? {}) as { path?: string; bytes?: number };
        const where = d.path ? ` ${paint(theme, 'path', d.path)}` : '';
        const size = typeof d.bytes === 'number' ? paint(theme, 'dim', ` · ${d.bytes} bytes`) : '';
        const line = `${paint(theme, 'success', CLI_GLYPH.success)} ${cliToolTitle(theme, WRITE_TOOL_DISPLAY_NAME)}${where}${size}`;
        return makeRenderer((width) => [truncateToWidth(line, width)]);
      }
      const text = result.content.find((c) => c.type === 'text')?.text ?? 'write failed';
      const err = paint(theme, 'error', text);
      return makeRenderer((width) => [truncateToWidth(err, width)]);
    },
  });
}
