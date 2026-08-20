/**
 * memory — a first-class wrapper over the Awareness `memory` CLI.
 *
 * Awareness owns durable cross-run memory (SQLite), but recall/record were only
 * reachable by the model shelling `npx @octocodeai/octocode-awareness-lite memory …`. That path
 * has no tool-stream visibility and depends on the model remembering the exact
 * flags. This tool makes recall/record/forget first-class: validated arguments,
 * a visible tool row (renderCall/renderResult), and structured results.
 *
 * It is a thin bridge — Awareness/SQLite remains canonical. It does not cache,
 * mutate, or reinterpret memory; it shells the same CLI the skill documents.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAwarenessLiteCommand } from '../assets.js';

const execFileAsync = promisify(execFile);
import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { CLI_GLYPH, cliToolTitle, paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export interface MemoryCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type MemoryCliRunner = (args: string[]) => MemoryCliResult | Promise<MemoryCliResult>;

/**
 * Default runner: invoke the published Awareness Lite CLI via npx. Async on purpose —
 * a sync exec here blocked the whole event loop (TUI freeze, unprocessable
 * abort) for up to the 20s timeout.
 */
const defaultRunner: MemoryCliRunner = async (args) => {
  const spec = buildAwarenessLiteCommand(args);
  try {
    const { stdout } = await execFileAsync(spec.cmd, spec.args, { encoding: 'utf8', timeout: 20_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? 'memory CLI failed' };
  }
};

let runner: MemoryCliRunner = defaultRunner;

/** Test seam: override the CLI runner (pass null to restore the default). */
export function setMemoryCliRunnerForTests(fn: MemoryCliRunner | null): void {
  runner = fn ?? defaultRunner;
}

type MemoryAction = 'recall' | 'record' | 'forget';

interface MemoryParams {
  action: MemoryAction;
  query?: string;
  smart?: boolean;
  label?: string;
  observation?: string;
  importance?: number;
  taskContext?: string;
  memoryId?: string;
}

type ParsedJson = Record<string, unknown> | unknown[];

function parseJson(stdout: string): ParsedJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The CLI may emit log lines before the JSON; take the last JSON-looking line.
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('{') || line.startsWith('[')) {
      try { return JSON.parse(line) as ParsedJson; } catch { /* keep scanning */ }
    }
  }
  return null;
}

function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true } as unknown as ToolCallResult;
}

export function registerMemoryTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  registerFn(pi, registeredToolNames, {
    name: 'memory',
    label: 'Memory',
    description: [
      'Recall, record, or forget durable Awareness memory (cross-run SQLite) as a first-class tool.',
      'recall — retrieve prior verified learnings relevant to a query (use smart:true for scored/expanded recall). Treat results as leads; re-verify against current source/tests.',
      'record — persist a reusable, verified learning/gotcha/decision with a label and importance (1-10). Never store secrets, raw logs, routine status, or facts git/docs already own.',
      'forget — delete a specific memory by id (destructive; only when clearly obsolete).',
      'Awareness Lite/SQLite is canonical; this tool shells the same CLI the octocode-awareness-lite skill documents.',
    ].join('\n'),
    promptSnippet: 'Recall/record/forget durable Awareness memory (first-class wrapper over the memory CLI)',
    promptGuidelines: [
      'Recall only when prior learning could change the approach; record only verified, reusable outcomes with a reference.',
      'Re-verify recalled facts before relying on them; never store secrets, logs, or routine status.',
    ],
    parameters: Type.Object({
      action: Type.Unsafe({ type: 'string', enum: ['recall', 'record', 'forget'], description: 'recall|record|forget' }),
      query: Type.Optional(Type.String({ description: 'recall: what to search for.' })),
      smart: Type.Optional(Type.Boolean({ description: 'recall: use scored/expanded smart recall.' })),
      label: Type.Optional(Type.String({ description: 'record: e.g. GOTCHA, BUG, DECISION, ARCHITECTURE, EXPERIENCE.' })),
      observation: Type.Optional(Type.String({ description: 'record: the reusable learning text.' })),
      importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'record: importance 1-10.' })),
      taskContext: Type.Optional(Type.String({ description: 'record: short context for when this matters.' })),
      memoryId: Type.Optional(Type.String({ description: 'forget: the memory id to delete.' })),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext): Promise<ToolCallResult> {
      const p = raw as unknown as MemoryParams;
      const cwd = ctx?.cwd ?? process.cwd();
      let args: string[];

      if (p.action === 'recall') {
        const query = String(p.query ?? '').trim();
        if (!query) return errorResult('[memory] recall requires a query.');
        args = ['memory', 'recall', '--query', query, '--workspace', cwd];
      } else if (p.action === 'record') {
        const label = String(p.label ?? '').trim();
        const observation = String(p.observation ?? '').trim();
        const importance = Number(p.importance);
        if (!label) return errorResult('[memory] record requires a label (e.g. GOTCHA).');
        if (!observation) return errorResult('[memory] record requires an observation.');
        if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
          return errorResult('[memory] record requires importance 1-10.');
        }
        const text = p.taskContext ? `${String(p.taskContext).trim()}: ${observation}` : observation;
        args = [
          'memory', 'store', '--label', label,
          '--text', text,
          '--workspace', cwd,
        ];
      } else if (p.action === 'forget') {
        const memoryId = String(p.memoryId ?? '').trim();
        if (!memoryId) return errorResult('[memory] forget requires a memoryId.');
        args = ['memory', 'forget', '--memory-id', memoryId, '--workspace', cwd];
      } else {
        return errorResult(`[memory] unknown action "${String((p as { action?: string }).action)}".`);
      }

      let out: MemoryCliResult;
      try {
        out = await runner(args);
      } catch (err) {
        return errorResult(`[memory] CLI error: ${err instanceof Error ? err.message : String(err)}`);
      }

      const json = parseJson(out.stdout);
      const jsonObject = json && !Array.isArray(json) ? json : null;
      const failed = out.code !== 0 || (jsonObject && jsonObject['ok'] === false);
      if (failed) {
        const msg = (jsonObject && typeof jsonObject['error'] === 'string' ? jsonObject['error'] : '') || out.stderr || `memory ${p.action} failed (exit ${out.code})`;
        return errorResult(`[memory] ${msg}`);
      }

      let summary: string;
      const details: Record<string, unknown> = { action: p.action, result: json };
      if (p.action === 'recall') {
        const count = Array.isArray(json) ? json.length : (jsonObject && typeof jsonObject['count'] === 'number' ? (jsonObject['count'] as number) : 0);
        summary = `Recalled ${count} memor${count === 1 ? 'y' : 'ies'} for "${p.query}".`;
        details['count'] = count;
      } else if (p.action === 'record') {
        const mem = (jsonObject?.['memory'] ?? jsonObject ?? {}) as Record<string, unknown>;
        const id = String(mem['memoryId'] ?? mem['memory_id'] ?? jsonObject?.['memoryId'] ?? jsonObject?.['memory_id'] ?? 'recorded');
        summary = `Recorded ${p.label} memory ${id}.`;
        details['memoryId'] = id;
      } else {
        const deleted = jsonObject?.['forgotten'] === true ? 1 : (jsonObject && typeof jsonObject['deleted'] === 'number' ? (jsonObject['deleted'] as number) : 0);
        summary = `Forgot ${deleted} memor${deleted === 1 ? 'y' : 'ies'}.`;
        details['deleted'] = deleted;
      }

      const text = json ? `${summary}\n${JSON.stringify(json)}` : summary;
      return { content: [{ type: 'text', text }], details } as unknown as ToolCallResult;
    },

    renderCall(raw: unknown, theme?: PiTheme) {
      const p = raw as MemoryParams;
      const action = String(p?.action ?? 'recall');
      const hint = p?.query ? `"${p.query}"` : p?.label ? `[${p.label}]` : p?.memoryId ? p.memoryId : '';
      const title = cliToolTitle(theme, 'memory');
      const body = paint(theme, 'dim', `${action} ${hint}`.trim());
      return makeRenderer((w) => [truncateToWidth(`${title} ${body}`, w)]);
    },

    renderResult(result: ToolCallResult, _opts: unknown, theme?: PiTheme) {
      const ok = !result.isError;
      const first = (result.content?.[0]?.text ?? '').split('\n')[0] || 'memory';
      const line = ok
        ? paint(theme, 'success', `${CLI_GLYPH.success} ${first}`)
        : paint(theme, 'error', `${CLI_GLYPH.error} ${first}`);
      return makeRenderer((w) => [truncateToWidth(line, w)]);
    },
  });
}
