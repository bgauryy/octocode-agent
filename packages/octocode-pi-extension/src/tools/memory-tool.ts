/**
 * memory — a first-class wrapper over the Awareness `memory` CLI.
 *
 * Awareness owns durable cross-run memory (SQLite), but recall/record were only
 * reachable by the model shelling `$OCTOCODE_AWARENESS_CLI memory …`. That path
 * has no tool-stream visibility and depends on the model remembering the exact
 * flags. This tool makes recall/record/forget first-class: validated arguments,
 * a visible tool row (renderCall/renderResult), and structured results.
 *
 * It is a thin bridge — Awareness/SQLite remains canonical. It does not cache,
 * mutate, or reinterpret memory; it shells the same CLI the skill documents.
 */

import { execFileSync } from 'node:child_process';
import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export interface MemoryCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type MemoryCliRunner = (args: string[]) => MemoryCliResult | Promise<MemoryCliResult>;

const AWARENESS_AGENT_ENV_VAR = 'OCTOCODE_AGENT_ID';

/** Default runner: invoke the bundled Awareness CLI via node. */
const defaultRunner: MemoryCliRunner = (args) => {
  const cli = process.env['OCTOCODE_AWARENESS_CLI'];
  if (!cli) return { code: 127, stdout: '', stderr: 'OCTOCODE_AWARENESS_CLI is not set' };
  try {
    const stdout = execFileSync('node', [cli, ...args], { encoding: 'utf8', timeout: 20_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? 'memory CLI failed' };
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

function agentId(): string {
  return process.env[AWARENESS_AGENT_ENV_VAR]?.trim() || 'pi';
}

function parseJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The CLI may emit log lines before the JSON; take the last JSON-looking line.
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('{')) {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { /* keep scanning */ }
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
      'Awareness/SQLite is canonical; this tool shells the same CLI the octocode-awareness skill documents.',
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
        args = ['memory', 'recall', '--query', query, ...(p.smart ? ['--smart'] : []), '--workspace', cwd, '--compact'];
      } else if (p.action === 'record') {
        const label = String(p.label ?? '').trim();
        const observation = String(p.observation ?? '').trim();
        const importance = Number(p.importance);
        if (!label) return errorResult('[memory] record requires a label (e.g. GOTCHA).');
        if (!observation) return errorResult('[memory] record requires an observation.');
        if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
          return errorResult('[memory] record requires importance 1-10.');
        }
        args = [
          'memory', 'record', '--agent-id', agentId(), '--label', label,
          '--observation', observation, '--importance', String(importance),
          ...(p.taskContext ? ['--task-context', String(p.taskContext)] : []),
          '--workspace', cwd, '--compact',
        ];
      } else if (p.action === 'forget') {
        const memoryId = String(p.memoryId ?? '').trim();
        if (!memoryId) return errorResult('[memory] forget requires a memoryId.');
        args = ['memory', 'forget', '--memory-id', memoryId, '--compact'];
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
      const failed = out.code !== 0 || (json && json['ok'] === false);
      if (failed) {
        const msg = (json && typeof json['error'] === 'string' ? json['error'] : '') || out.stderr || `memory ${p.action} failed (exit ${out.code})`;
        return errorResult(`[memory] ${msg}`);
      }

      let summary: string;
      const details: Record<string, unknown> = { action: p.action, result: json };
      if (p.action === 'recall') {
        const count = json && typeof json['count'] === 'number' ? (json['count'] as number) : 0;
        summary = `Recalled ${count} memor${count === 1 ? 'y' : 'ies'} for "${p.query}".`;
        details['count'] = count;
      } else if (p.action === 'record') {
        const mem = (json?.['memory'] ?? {}) as Record<string, unknown>;
        const id = String(mem['memory_id'] ?? json?.['memory_id'] ?? 'recorded');
        summary = `Recorded ${p.label} memory ${id}.`;
        details['memoryId'] = id;
      } else {
        const deleted = json && typeof json['deleted'] === 'number' ? (json['deleted'] as number) : 0;
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
      const title = theme?.fg('toolTitle', theme.bold('memory')) ?? 'memory';
      const body = theme?.fg('dim', `${action} ${hint}`.trim()) ?? `${action} ${hint}`.trim();
      return makeRenderer((w) => [truncateToWidth(`${title} ${body}`, w)]);
    },

    renderResult(result: ToolCallResult, _opts: unknown, theme?: PiTheme) {
      const ok = !result.isError;
      const first = (result.content?.[0]?.text ?? '').split('\n')[0] || 'memory';
      const line = ok
        ? (theme?.fg('success', `\u2713 ${first}`) ?? `\u2713 ${first}`)
        : (theme?.fg('error', `\u2717 ${first}`) ?? `\u2717 ${first}`);
      return makeRenderer((w) => [truncateToWidth(line, w)]);
    },
  });
}
