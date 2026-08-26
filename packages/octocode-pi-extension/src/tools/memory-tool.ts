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

import { runAwarenessLiteInProcess } from '../assets.js';
import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { buildToolView } from './render-helpers.js';
import { buildQueryEnvelopeSchema, executeQueryBatch } from './query-envelope.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export interface MemoryCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type MemoryCliRunner = (args: string[]) => MemoryCliResult | Promise<MemoryCliResult>;

/**
 * Default runner: execute the Awareness Lite `memory` command IN-PROCESS via the
 * library (no child process). Store/list/forget and lexical recall are fast
 * local-SQLite ops. Kept async so the tool's execute path and the injectable
 * test seam are unchanged. Caveat: `recall --semantic` WITH an OCTOCODE_EMBED_CMD
 * configured runs the host embedder via spawnSync and would block the event loop
 * for its duration — that env is opt-in and unset by default here.
 */
const defaultRunner: MemoryCliRunner = async (args) => {
  try {
    const { code, stdout, stderr } = runAwarenessLiteInProcess(args);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 1, stdout: '', stderr: err instanceof Error ? err.message : 'memory CLI failed' };
  }
};

let runner: MemoryCliRunner = defaultRunner;

/** Test seam: override the CLI runner (pass null to restore the default). */
export function setMemoryCliRunnerForTests(fn: MemoryCliRunner | null): void {
  runner = fn ?? defaultRunner;
}

type MemoryAction = 'recall' | 'record' | 'forget' | 'review' | 'suggest';
type MemoryRecallMode = 'lexical' | 'semantic' | 'recent' | 'tagged';

interface MemoryParams {
  action: MemoryAction;
  query?: string;
  mode?: MemoryRecallMode;
  label?: string;
  observation?: string;
  importance?: number;
  taskContext?: string;
  source?: string;
  tags?: string[];
  changedFiles?: string[];
  limit?: number;
  memoryId?: string;
}

type ParsedJson = Record<string, unknown> | unknown[];

/**
 * Scan from the opening bracket at `open` tracking brace/bracket depth while
 * respecting string literals and escapes, and return the index just past the
 * matching close — or -1 if the structure never balances.
 */
function findBalancedEnd(s: string, open: number): number {
  const opener = s[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseJson(stdout: string): ParsedJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The CLI pretty-prints its JSON (multi-line), so parse the whole payload
  // first — a per-line scan can never match an indented object and silently
  // reported "0 memories" for every successful call.
  try { return JSON.parse(trimmed) as ParsedJson; } catch { /* fall through */ }
  // Balanced scan: awareness-lite may print pretty (multi-line) JSON surrounded
  // by plain log text. From each candidate opening bracket, walk forward to its
  // matching close (respecting strings/escapes) and try to parse that slice.
  // Trying successive openers tolerates a stray brace inside a leading log line.
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = findBalancedEnd(trimmed, i);
    if (end === -1) continue;
    try { return JSON.parse(trimmed.slice(i, end)) as ParsedJson; } catch { /* keep scanning */ }
  }
  // Last resort: a single JSON line among log output.
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

function validateRecordObservation(observation: string): string | null {
  if (observation.length < 8) return 'record observation is too short to be reusable; include the durable learning and evidence.';
  if (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(observation)) {
    return 'record observation looks like it contains a secret/token; do not store secrets in memory.';
  }
  const lines = observation.split(/\r?\n/);
  if (lines.length > 8 || observation.length > 1200) return 'record observation looks like a raw log/dump; store a short reusable learning with evidence instead.';
  if (/\b(?:tests?|build|typecheck|lint)\s+(?:passed|green|ok)\b/i.test(observation)) {
    return 'record observation looks like routine status; store only reusable learnings, gotchas, decisions, or command quirks.';
  }
  if (/\b(?:AGENTS\.md|CLAUDE\.md)\b/i.test(observation)) {
    return 'record observation references agent instruction files; fetch those from the repo instead of storing them in memory.';
  }
  return null;
}

function normalizeRecordTags(tags: unknown, importance: number): string {
  const tagValues = Array.isArray(tags) ? tags : [];
  const normalized = tagValues
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .filter((tag) => !/[\r\n,]/.test(tag));
  return [`importance:${importance}`, ...Array.from(new Set(normalized))].join(',');
}

function normalizeLimit(value: unknown, fallback = 20): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, 100);
}

interface MemoryItem {
  memoryId?: string;
  memory_id?: string;
  label?: string;
  text?: string;
  tags?: string[] | string;
  createdAt?: string;
  created_at?: string;
}

function asMemoryItems(json: ParsedJson | null): MemoryItem[] {
  if (Array.isArray(json)) return json.filter((item): item is MemoryItem => typeof item === 'object' && item !== null) as MemoryItem[];
  if (!json || Array.isArray(json)) return [];
  const maybeMemories = json['memories'] ?? json['items'] ?? json['results'];
  if (Array.isArray(maybeMemories)) return maybeMemories.filter((item): item is MemoryItem => typeof item === 'object' && item !== null) as MemoryItem[];
  const maybeMemory = json['memory'];
  if (maybeMemory && typeof maybeMemory === 'object' && !Array.isArray(maybeMemory)) return [maybeMemory as MemoryItem];
  return [];
}

function reviewMemoryItems(items: MemoryItem[]): Array<{ memoryId: string; label: string; issues: string[]; preview: string }> {
  const now = Date.now();
  return items.map((item) => {
    const text = String(item.text ?? '');
    const tags = Array.isArray(item.tags) ? item.tags : String(item.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
    const issues: string[] = [];
    if (!/\bSource:/i.test(text)) issues.push('missing-source');
    if (text.length > 1200 || text.split(/\r?\n/).length > 8) issues.push('too-long');
    if (/\b(?:tests?|build|typecheck|lint)\s+(?:passed|green|ok)\b/i.test(text)) issues.push('routine-status');
    if (/\b(?:AGENTS\.md|CLAUDE\.md)\b/i.test(text)) issues.push('instruction-file-reference');
    if (tags.length === 0) issues.push('missing-tags');
    const created = Date.parse(String(item.createdAt ?? item.created_at ?? ''));
    if (Number.isFinite(created) && now - created > 90 * 24 * 60 * 60 * 1000) issues.push('older-than-90d');
    return {
      memoryId: String(item.memoryId ?? item.memory_id ?? 'unknown'),
      label: String(item.label ?? 'MEMORY'),
      issues,
      preview: text.slice(0, 160),
    };
  }).filter((item) => item.issues.length > 0);
}

function tagsFromChangedFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const tags = new Set<string>();
  for (const file of files) {
    const parts = String(file).split('/').filter(Boolean);
    if (parts[0] === 'packages' && parts[1]) tags.add(parts[1]);
    const filename = parts.at(-1);
    if (filename) tags.add(filename.replace(/\.[^.]+$/, ''));
  }
  return Array.from(tags);
}

function preflightMemoryParams(p: MemoryParams): void {
  if (!['recall', 'record', 'forget', 'review', 'suggest'].includes(String(p.action))) {
    throw new Error(`unknown action "${String(p.action)}".`);
  }
  if (p.action === 'suggest' || p.action === 'record') {
    const observation = String(p.observation ?? '').trim();
    if (!observation) throw new Error(`${p.action} requires an observation.`);
    const validationError = validateRecordObservation(observation);
    if (validationError) throw new Error(validationError);
  }
  if (p.action === 'record') {
    if (!String(p.label ?? '').trim()) throw new Error('record requires a label (e.g. GOTCHA).');
    const importance = Number(p.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
      throw new Error('record requires importance 1-10.');
    }
  }
  if (p.action === 'recall' && (p.mode ?? 'lexical') !== 'recent') {
    const tags = Array.isArray(p.tags) ? p.tags.map(String).filter(Boolean) : [];
    if (!String(p.query ?? ((p.mode ?? 'lexical') === 'tagged' ? tags[0] ?? '' : '')).trim()) {
      throw new Error(`recall mode ${p.mode ?? 'lexical'} requires a query${p.mode === 'tagged' ? ' or at least one tag' : ''}.`);
    }
  }
  if (p.action === 'forget' && !String(p.memoryId ?? '').trim()) {
    throw new Error('forget requires a memoryId.');
  }
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
      'Recall, record, review, suggest, or forget durable Awareness memory (cross-run SQLite) as a first-class tool.',
      'recall — retrieve prior verified learnings by query; modes: lexical/tagged (substring), semantic (--semantic), recent (list latest). Treat results as leads; re-verify against current source/tests.',
      'record — persist a reusable, verified learning/gotcha/decision with a label, importance (1-10), optional tags, and optional source/evidence. Never store secrets, raw logs, routine status, or facts git/docs already own.',
      'review — read memories and flag stale/low-quality candidates; never mutates. suggest — validate and shape a candidate record; never stores automatically.',
      'forget — delete a specific memory by id (destructive; only when clearly obsolete).',
      'Awareness Lite/SQLite is canonical; this tool shells the same CLI documented in the prompt-owned <awareness> section.',
    ].join('\n'),
    promptSnippet: 'Recall/record/review/suggest/forget durable Awareness memory (first-class wrapper over the memory CLI)',
    promptGuidelines: [
      'Recall at task start when prior learning could change the approach. Mode: lexical/tagged for known terms or package names; semantic for concepts or error patterns; recent for last-session context.',
      'Record after confirming a fix or decision — not mid-session speculation. Labels: GOTCHA (trap/footgun), BUG (confirmed defect), DECISION (arch choice), ARCHITECTURE (system shape), EXPERIENCE (pattern/lesson). Importance: 8–10 = repo-wide gotcha or arch decision; 5–7 = package-level pattern; 1–4 = one-off. Always include source (file:line or check command) and taskContext.',
      'Use suggest before record when uncertain; review/forget to prune stale entries. Never store secrets, logs, routine status, or facts git/docs already own.',
    ],
    parameters: buildQueryEnvelopeSchema(Type, Type.Object({
      action: Type.Unsafe({ type: 'string', enum: ['recall', 'record', 'forget', 'review', 'suggest'], description: 'recall|record|forget|review|suggest' }),
      query: Type.Optional(Type.String({ description: 'recall/review: what to search for.' })),
      mode: Type.Optional(Type.Unsafe({ type: 'string', enum: ['lexical', 'semantic', 'recent', 'tagged'], description: 'recall: lexical|semantic|recent|tagged.' })),
      label: Type.Optional(Type.String({ description: 'record label or recall/review label filter, e.g. GOTCHA, BUG, DECISION, ARCHITECTURE, EXPERIENCE.' })),
      observation: Type.Optional(Type.String({ description: 'record: the reusable learning text.' })),
      importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'record: importance 1-10.' })),
      taskContext: Type.Optional(Type.String({ description: 'record: short context for when this matters.' })),
      source: Type.Optional(Type.String({ description: 'record: source/evidence reference, e.g. file:line and/or check command.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'record/recall tagged/suggest: searchable tags such as package, area, tool, or bug class.' })),
      changedFiles: Type.Optional(Type.Array(Type.String(), { description: 'suggest: changed files used to derive candidate tags.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'recall/review: max memories to return or inspect.' })),
      memoryId: Type.Optional(Type.String({ description: 'forget: the memory id to delete.' })),
    }, { additionalProperties: false }), {
      reasoningDescription: 'Concise reason this memory operation is necessary.',
    }),

    async execute(id: string, raw: Record<string, unknown>, signal, onUpdate, ctx?: PiContext): Promise<ToolCallResult> {
      const envelopeQueries = Array.isArray(raw.queries)
        ? raw.queries as Record<string, unknown>[]
        : [];
      const queryCount = envelopeQueries.length;
      if (queryCount === 1) {
        try {
          preflightMemoryParams(envelopeQueries[0] as unknown as MemoryParams);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const action = String((envelopeQueries[0] as Record<string, unknown>)['action'] ?? '');
          return errorResult(`[memory] ${action === 'suggest' ? 'suggestion rejected: ' : ''}${message}`);
        }
      }
      return executeQueryBatch({
        toolCallId: id,
        raw,
        signal,
        onUpdate: typeof onUpdate === 'function' ? onUpdate as (update: ToolCallResult) => void : undefined,
        ctx,
        passthroughSingle: true,
        preflight: queryCount > 1
          ? (query) => { preflightMemoryParams(query as unknown as MemoryParams); }
          : undefined,
        async execute(query) {
      const p = query as unknown as MemoryParams;
      const cwd = ctx?.cwd ?? process.cwd();
      let args: string[];

      if (p.action === 'suggest') {
        const observation = String(p.observation ?? '').trim();
        if (!observation) return errorResult('[memory] suggest requires an observation to validate.');
        const validationError = validateRecordObservation(observation);
        if (validationError) return errorResult(`[memory] suggestion rejected: ${validationError}`);
        const importance = Number.isInteger(Number(p.importance)) ? Math.min(Math.max(Number(p.importance), 1), 10) : 5;
        const suggestedTags = Array.from(new Set([...(Array.isArray(p.tags) ? p.tags.map(String) : []), ...tagsFromChangedFiles(p.changedFiles)])).filter(Boolean);
        const candidate = {
          action: 'record',
          label: String(p.label ?? 'EXPERIENCE').trim() || 'EXPERIENCE',
          observation,
          importance,
          taskContext: String(p.taskContext ?? '').trim() || undefined,
          source: String(p.source ?? '').trim() || undefined,
          tags: suggestedTags,
        };
        return {
          content: [{ type: 'text', text: `Suggested memory candidate (not recorded).\n${JSON.stringify(candidate)}` }],
          details: { action: 'suggest', candidate },
        } as unknown as ToolCallResult;
      }

      if (p.action === 'recall') {
        const mode = p.mode ?? 'lexical';
        const limit = normalizeLimit(p.limit, 20);
        if (mode === 'recent') {
          args = ['memory', 'list', '--limit', String(limit), '--workspace', cwd];
        } else {
          const tags = Array.isArray(p.tags) ? p.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
          const query = String(p.query ?? (mode === 'tagged' ? tags[0] ?? '' : '')).trim();
          if (!query) return errorResult(`[memory] recall mode ${mode} requires a query${mode === 'tagged' ? ' or at least one tag' : ''}.`);
          args = ['memory', 'recall', '--query', query, '--limit', String(limit), '--workspace', cwd];
          if (p.label) args.splice(args.length - 2, 0, '--label', String(p.label).trim());
          if (mode === 'semantic') args.splice(args.length - 2, 0, '--semantic');
        }
      } else if (p.action === 'review') {
        const limit = normalizeLimit(p.limit, 20);
        const query = String(p.query ?? '').trim();
        const label = String(p.label ?? '').trim();
        if (query || label) {
          args = ['memory', 'recall', '--limit', String(limit), '--workspace', cwd];
          if (query) args.splice(args.length - 2, 0, '--query', query);
          if (label) args.splice(args.length - 2, 0, '--label', label);
        } else {
          args = ['memory', 'list', '--limit', String(limit), '--workspace', cwd];
        }
      } else if (p.action === 'record') {
        const label = String(p.label ?? '').trim();
        const observation = String(p.observation ?? '').trim();
        const importance = Number(p.importance);
        if (!label) return errorResult('[memory] record requires a label (e.g. GOTCHA).');
        if (!observation) return errorResult('[memory] record requires an observation.');
        const validationError = validateRecordObservation(observation);
        if (validationError) return errorResult(`[memory] ${validationError}`);
        if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
          return errorResult('[memory] record requires importance 1-10.');
        }
        const taskContext = String(p.taskContext ?? '').trim();
        const source = String(p.source ?? '').trim();
        const textParts = [taskContext ? `${taskContext}: ${observation}` : observation];
        if (source) textParts.push(`Source: ${source}`);
        args = [
          'memory', 'store', '--label', label,
          '--text', textParts.join('\n'),
          // Awareness Lite `memory store` has no importance column; persist the
          // validated 1-10 value as a tag so it is durably recorded and
          // recall-searchable instead of being silently dropped.
          '--tags', normalizeRecordTags(p.tags, importance),
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
        const count = asMemoryItems(json).length || (jsonObject && typeof jsonObject['count'] === 'number' ? (jsonObject['count'] as number) : 0);
        summary = p.mode === 'recent'
          ? `Recalled ${count} recent memor${count === 1 ? 'y' : 'ies'}.`
          : `Recalled ${count} memor${count === 1 ? 'y' : 'ies'} for "${p.query ?? (Array.isArray(p.tags) ? p.tags[0] : '')}".`;
        details['count'] = count;
      } else if (p.action === 'review') {
        const items = asMemoryItems(json);
        const candidates = reviewMemoryItems(items);
        summary = `Reviewed ${items.length} memor${items.length === 1 ? 'y' : 'ies'}; found ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} for cleanup or rewrite.`;
        details['count'] = items.length;
        details['candidates'] = candidates;
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

      const payload = p.action === 'review' ? { result: json, candidates: details['candidates'] } : json;
      const text = payload ? `${summary}\n${JSON.stringify(payload)}` : summary;
      return { content: [{ type: 'text', text }], details } as unknown as ToolCallResult;
        },
      });
    },

    renderCall(raw: unknown, theme?: PiTheme) {
      const envelope = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const queries = Array.isArray(envelope['queries']) ? envelope['queries'] as MemoryParams[] : [];
      const p = queries[0] ?? {} as MemoryParams;
      const action = String(p?.action ?? 'recall');
      const hint = p?.query ? `"${p.query}"` : p?.label ? `[${p.label}]` : p?.memoryId ? p.memoryId : '';
      return buildToolView({ name: 'memory', state: 'request', segments: [{ text: action, token: 'bright' }, ...(hint ? [{ text: hint, token: 'dim' as const }] : [])] }, theme);
    },

    renderResult(result: ToolCallResult, _opts: unknown, theme?: PiTheme) {
      const ok = !result.isError;
      const first = ((result.content?.[0] as { text?: string } | undefined)?.text ?? '').split('\n')[0] || 'memory';
      return buildToolView({ name: 'memory', state: ok ? 'success' : 'error', segments: [{ text: first, token: ok ? 'dim' : 'error' }] }, theme);
    },
  });
}
