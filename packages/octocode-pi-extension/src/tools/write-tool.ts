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

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

const WRITE_TOOL_DISPLAY_NAME = 'write (Octocode)';

function resolveWritePath(filePath: string, cwd = process.cwd()): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function validateWriteParams(params: Record<string, unknown>): { path: string; content: string; reasoning: string } {
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

export function registerWriteTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  const parameters = Type.Object(
    {
      path: Type.String({ description: 'Path to the file to write (relative or absolute).' }),
      content: Type.String({ description: 'Content to write to the file.' }),
      reasoning: Type.String({ description: 'REQUIRED. Why this file create/overwrite is necessary; shown to users so they understand the intent.' }),
    },
    { additionalProperties: false },
  ) as TSchema;

  registerFn(pi, registeredToolNames, {
    name: 'write',
    label: 'write (Octocode)',
    description:
      'Octocode custom write tool. Replaces Pi built-in write with the same create/overwrite semantics plus Octocode path-guard (working directory, home, OS temp, ALLOWED_PATHS) and post-write read-state recording for the edit stale-check. Requires a non-empty reasoning field explaining why the create/overwrite is necessary. Prefer edit for surgical changes to existing files.',
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
      const input = args as Record<string, unknown>;
      if (typeof input['path'] !== 'string' && typeof input['file_path'] === 'string') {
        // Drop the legacy key: schema validation runs AFTER prepareArguments and
        // additionalProperties:false rejects any retained extra key.
        const { file_path: legacyPath, ...rest } = input;
        return { ...rest, path: legacyPath };
      }
      return args;
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
    ): Promise<ToolCallResult> {
      const { path: requestPath, content } = validateWriteParams(params);
      const cwd = ctx?.cwd ?? process.cwd();
      const absolutePath = resolveWritePath(requestPath, cwd);
      assertPathAllowed(absolutePath, cwd, 'write');
      if (signal?.aborted) throw new Error('Operation aborted');
      // Peer-WIP advisory computed before we take ownership of the file.
      const peerNotice = peerWipNotice(absolutePath, requestPath);

      await withFileMutationQueue(absolutePath, async () => {
        if (signal?.aborted) throw new Error('Operation aborted');
        await atomicWriteUtf8(absolutePath, content);
        if (signal?.aborted) throw new Error('Operation aborted');
        await recordFileReadState(absolutePath, cwd);
        markOwnWrite(absolutePath);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${requestPath}${peerNotice}`,
          },
        ],
        details: {
          path: requestPath,
          absolutePath,
          bytes: Buffer.byteLength(content, 'utf8'),
        },
      };
    },
    renderCall(args: unknown, theme?: PiTheme) {
      const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
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
      const suffix = paint(theme, 'dim', `${filePath} · ${lines} line${lines === 1 ? '' : 's'}`);
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
