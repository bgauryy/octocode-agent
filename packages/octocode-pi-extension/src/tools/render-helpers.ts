/**
 * Shared rendering utilities for Octocode Pi extension tool renderers.
 *
 * Centralises:
 *  - ANSI-aware line truncation (replaces 3 copies across the codebase)
 *  - Per-tool call-summary extraction (smart param display instead of raw JSON)
 *  - Per-tool result-stats extraction (counts, paths, match totals)
 *  - A tiny `makeRenderer` factory for the Component interface
 */

import { truncateToWidth as piTruncateToWidth, visibleWidth as piVisibleWidth } from '@earendil-works/pi-tui';

import {
  CLI_GLYPH,
  CLI_STATUS_TEXT,
  cliSpinnerFrame,
  cliStatusGlyph,
  cliStatusToken,
  cliToolTitle,
  paint,
} from '../tui/cli-design.js';
import type { PiTheme, RenderCallReturn, RenderContext, ToolCallResult } from '../types.js';

// ─── ANSI-safe width helpers ──────────────────────────────────────────────────
//
// Width measurement and truncation delegate to pi-tui's own visibleWidth /
// truncateToWidth. pi's renderer crashes any line whose pi-tui-measured width
// exceeds the terminal width, and pi's extension loader aliases the
// `@earendil-works/pi-tui` import to the host's bundled copy — so delegating
// guarantees we can never disagree with the arbiter of that check.

// sanitizeLine lives in palette.ts so cli-design (which render-helpers imports) can
// reuse it without a cycle. Imported for internal use and re-exported for existing importers.
import { sanitizeLine } from '../tui/palette.js';
export { sanitizeLine };

export function visibleWidth(str: string): number {
  return piVisibleWidth(sanitizeLine(str));
}

/**
 * Truncate `str` so its *visible* width (ANSI codes excluded) ≤ `maxWidth`.
 * When truncated, pi-tui inserts SGR resets around the appended ellipsis so
 * open colour sequences don't bleed into subsequent lines.
 */
export function truncateToWidth(
  str: string,
  maxWidth: number,
  ellipsis = '\u2026',
): string {
  return piTruncateToWidth(sanitizeLine(str), maxWidth, ellipsis);
}

/**
 * Truncate PLAIN text (no ANSI codes) to at most `maxWidth` visible cells,
 * counting CJK/emoji as their true width. Unlike pi-tui's truncateToWidth this
 * injects no SGR reset sequences (the input has no colour to bleed), so it is
 * safe for values that are theme-wrapped afterwards. `ellipsis` is appended
 * within the budget when truncation occurs (pass '' for a hard cut).
 */
export function truncatePlainToWidth(text: string, maxWidth: number, ellipsis = '\u2026'): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;
  const ellW = visibleWidth(ellipsis);
  if (maxWidth <= ellW) return ellipsis.slice(0, maxWidth) || ellipsis;
  const budget = maxWidth - ellW;
  let out = '';
  let used = 0;
  for (const ch of Array.from(text)) {
    const w = visibleWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}

/**
 * Word-wrap plain text (no ANSI codes) into lines of at most `maxWidth` visible
 * characters each. Words longer than `maxWidth` are hard-truncated on that boundary.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    // Budget by visible cell width, not byte/code-unit length — CJK/emoji are
    // 2 cells, so a .length check under-counts and lets a visually-too-wide line
    // through, which pi's TUI hard-clips (or crashes on).
    const safeWord = visibleWidth(word) > maxWidth ? truncatePlainToWidth(word, maxWidth, '') : word;
    if (!current) {
      current = safeWord;
    } else {
      const candidate = `${current} ${safeWord}`;
      if (visibleWidth(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = safeWord;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// ─── Tiny component factory ───────────────────────────────────────────────────

/**
 * Build a multi-line terminal component from pre-built lines.
 *
 * Applies `truncateToWidth` to **every** emitted line as a final safety net so
 * that no line can ever exceed the terminal width and crash pi's TUI, regardless
 * of whether the caller remembered to truncate individually.  Because
 * `truncateToWidth` is idempotent on already-short strings this has zero cost.
 */
export function makeRenderer(lines: (width: number) => string[]): RenderCallReturn {
  return {
    render: (width = 80) => lines(width).map((line) => truncateToWidth(line, width)),
    invalidate() { /* no-op */ },
  };
}

export function singleLineRenderer(rawLine: string): RenderCallReturn {
  return makeRenderer((w) => [truncateToWidth(rawLine, w)]);
}

/**
 * Like makeRenderer but memoizes rendered lines per width (docs/tui.md
 * "Performance"). Use ONLY when the line data is fixed at construction time — the
 * closure must capture no live mutable state. Safe for the tool-row builders
 * below (a fresh renderResult/renderCall call rebuilds them when data changes).
 * Do NOT use for the footer / status-panel / spinner renderers, whose closures
 * read live state at render time and must recompute every frame. invalidate()
 * drops the cache (Pi calls it on theme change).
 */
export function makeCachedRenderer(lines: (width: number) => string[]): RenderCallReturn {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render(width = 80) {
      if (cachedLines && cachedWidth === width) return cachedLines;
      cachedLines = lines(width).map((line) => truncateToWidth(line, width));
      cachedWidth = width;
      return cachedLines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

// ─── Tool-call summary (replaces raw JSON dump in renderCall) ─────────────────

type QueryLike = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' && v ? v : '';
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}
function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '');
}
function shortPath(p: string, maxLen = 50): string {
  if (visibleWidth(p) <= maxLen) return p;
  // Keep the tail (the most specific path segments), cell-width aware so CJK
  // segments count double and surrogate pairs are never split.
  const chars = Array.from(p);
  let width = 1; // leading ellipsis
  let start = chars.length;
  while (start > 0 && width + visibleWidth(chars[start - 1]!) <= maxLen) {
    width += visibleWidth(chars[start - 1]!);
    start -= 1;
  }
  return '…' + chars.slice(start).join('');
}

/**
 * Extract a human-readable one-liner from a tool call's args object.
 * All octocode tools take `{ queries: [...] }` at the top level.
 * Dispatches per tool name to show the most useful information.
 */
export function buildToolCallSummary(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const queries = Array.isArray(a.queries) ? (a.queries as QueryLike[]) : [];
  const q = queries[0] ?? {};
  const more = queries.length > 1 ? ` +${queries.length - 1}` : '';

  // ── GitHub tools ─────────────────────────────────────────────────────────
  if (toolName.startsWith('gh')) {
    const repo = [str(q.owner), str(q.repo)].filter(Boolean).join('/');

    if (toolName === 'ghSearchCode') {
      const kw = arr(q.keywords).join(' ');
      const lang = str(q.language);
      const fn = str(q.filename);
      const parts = [
        kw ? `"${kw}"` : '',
        fn ? `file:${fn}` : '',
        lang ? `lang:${lang}` : '',
        repo ? `in ${repo}` : '',
      ].filter(Boolean).join(' ');
      return (parts + more).trim();
    }

    if (toolName === 'ghSearchRepos') {
      const kw = arr(q.keywords).join(' ');
      const lang = str(q.language);
      return ([kw ? `"${kw}"` : '', lang ? `lang:${lang}` : ''].filter(Boolean).join(' ') + more).trim();
    }

    if (toolName === 'ghGetFileContent') {
      const p = str(q.path);
      const matchStr = str(q.matchString);
      const start = q.startLine != null ? `:${q.startLine}` : '';
      const end = q.endLine != null ? `-${q.endLine}` : '';
      const anchor = matchStr ? ` /${truncatePlainToWidth(matchStr, 20, '')}/` : start + end;
      return (`${repo}${p ? `:${p}` : ''}${anchor}` + more).trim();
    }

    if (toolName === 'ghViewRepoStructure') {
      const p = str(q.path);
      return (`${repo}${p && p !== '.' ? `/${p}` : ''}` + more).trim();
    }

    if (toolName === 'ghHistoryResearch') {
      const type = str(q.type) || 'prs';
      const prNum = q.prNumber != null ? `#${q.prNumber}` : '';
      return (`${repo} ${type}${prNum}` + more).trim();
    }

    if (toolName === 'ghCloneRepo') {
      const sp = str(q.sparsePath);
      return (`${repo}${sp ? `/${sp}` : ''}` + more).trim();
    }

    return (repo + more).trim();
  }

  // ── Local tools ───────────────────────────────────────────────────────────
  if (toolName.startsWith('local') || toolName === 'lspGetSemantics') {
    if (toolName === 'localSearchCode') {
      const kw = str(q.searchText ?? q.keywords);
      const p = str(q.path);
      const mode = str(q.mode);
      const modeTag = mode && mode !== 'paginated' ? `[${mode}] ` : '';
      return (`${modeTag}${kw ? `"${kw}"` : ''}${p ? ` in ${shortPath(p)}` : ''}` + more).trim();
    }

    if (toolName === 'localGetFileContent') {
      const p = str(q.path);
      const start = q.startLine != null ? `:${q.startLine}` : '';
      const end = q.endLine != null ? `-${q.endLine}` : '';
      const matchStr = str(q.matchString);
      const anchor = matchStr ? ` /${truncatePlainToWidth(matchStr, 20, '')}/` : start + end;
      return (shortPath(p) + anchor + more).trim();
    }

    if (toolName === 'localViewStructure') {
      const p = str(q.path);
      const depth = q.maxDepth != null ? ` depth:${q.maxDepth}` : '';
      return (shortPath(p) + depth + more).trim();
    }

    if (toolName === 'localFindFiles') {
      const p = str(q.path);
      const names = arr(q.names).join(', ');
      const pat = str(q.pathPattern);
      return (`${shortPath(p)}${names ? ` [${names}]` : ''}${pat ? ` ${pat}` : ''}` + more).trim();
    }

    if (toolName === 'localBinaryInspect') {
      const p = str(q.path);
      const mode = str(q.mode);
      return (`${basename(p)}${mode ? ` (${mode})` : ''}` + more).trim();
    }

    if (toolName === 'lspGetSemantics') {
      const sym = str(q.symbolName);
      const type = str(q.type) || 'definition';
      const uri = str(q.uri);
      const file = uri ? basename(uri.replace(/\?.*$/, '')) : '';
      const line = q.lineHint != null ? `:${q.lineHint}` : '';
      return (`${type}${sym ? ` "${sym}"` : ''}${file ? ` in ${file}${line}` : ''}` + more).trim();
    }

    // localBinaryInspect fallthrough
    const p = str(q.path);
    return (shortPath(p) + more).trim();
  }

  // ── npm ──────────────────────────────────────────────────────────────────
  if (toolName === 'npmSearch') {
    const pkg = str(q.packageName);
    return (pkg + more).trim();
  }

  // ── fallback: pick the 3 most informative string values ──────────────────
  const SKIP_KEYS = new Set(['id', 'reasoning', 'researchGoal', 'mainResearchGoal', 'resolvedPath']);
  const parts = Object.entries(q)
    .filter(([k]) => !SKIP_KEYS.has(k))
    .map(([, v]) => truncatePlainToWidth(String(v ?? ''), 40))
    .filter(Boolean)
    .slice(0, 3);
  return (parts.join(' ') + more).trim();
}

// ─── Result stats (replaces generic "N items" in renderResult) ────────────────

export interface ResultStats {
  /** Total query count that produced results */
  queryCount?: number;
  /** Human-readable match/result total */
  summary?: string;
  /** Short file/repo paths to show inline */
  paths?: string[];
  /** Small preview values that show what data came back without dumping the full payload. */
  previews?: string[];
  /** Whether any result had an error */
  hasError?: boolean;
}

/**
 * Extract meaningful result stats from a tool's `details` object.
 * The structured output from octocode tools is typically:
 *   `{ results: [{ id, data: { ... tool-specific ... } }] }`
 */
function previewText(value: unknown, max = 72): string {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return truncatePlainToWidth(clean, max);
}

export function buildResultStats(toolName: string, details: unknown): ResultStats {
  if (!details || typeof details !== 'object') return {};
  const d = details as Record<string, unknown>;

  const results = Array.isArray(d.results) ? (d.results as Record<string, unknown>[]) : [];
  const queryCount = results.length > 0 ? results.length : undefined;

  // Per-tool structured extraction
  if (toolName === 'ghSearchCode' || toolName === 'ghSearchRepos') {
    // data.items[] is the search result list; data.totalCount is the GH API total
    let total = 0;
    let repos: string[] = [];
    const previews: string[] = [];
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      if (typeof data.totalCount === 'number') total += data.totalCount;
      else if (Array.isArray(data.items)) total += data.items.length;
      if (Array.isArray(data.items)) {
        for (const item of (data.items as Record<string, unknown>[]).slice(0, 3)) {
          const repo = item.repository && typeof item.repository === 'object'
            ? item.repository as Record<string, unknown>
            : undefined;
          const name = str(item.fullName ?? item.name ?? repo?.fullName ?? item.path);
          if (toolName === 'ghSearchRepos' && name) repos.push(name);
          if (name) previews.push(previewText(name));
        }
      }
    }
    return {
      queryCount,
      summary: total > 0 ? `${total} results` : undefined,
      paths: repos.length > 0 ? repos : undefined,
      previews: previews.length > 0 ? previews.slice(0, 3) : undefined,
    };
  }

  if (toolName === 'ghGetFileContent') {
    const paths: string[] = [];
    const previews: string[] = [];
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const p = str(data.path ?? data.filePath);
      if (p) paths.push(basename(p));
      const text = str(data.content ?? data.text ?? data.contentView);
      if (text) previews.push(previewText(text));
    }
    return { queryCount, paths: paths.slice(0, 4), previews: previews.slice(0, 2) };
  }

  // Same shape for the GitHub and local structure browsers.
  if (toolName === 'ghViewRepoStructure' || toolName === 'localViewStructure') {
    let entryCount = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      if (typeof data.totalEntries === 'number') entryCount += data.totalEntries;
      else if (Array.isArray(data.files)) entryCount += data.files.length;
    }
    return { queryCount, summary: entryCount > 0 ? `${entryCount} entries` : undefined };
  }

  if (toolName === 'ghCloneRepo') {
    const paths: string[] = [];
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const p = str(data.localPath ?? data.path);
      if (p) paths.push(shortPath(p, 45));
    }
    return { queryCount, paths: paths.slice(0, 2) };
  }

  if (toolName === 'localSearchCode') {
    let matchCount = 0;
    let fileCount = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      if (typeof data.totalMatches === 'number') matchCount += data.totalMatches;
      if (typeof data.totalFiles === 'number') fileCount += data.totalFiles;
      else if (Array.isArray(data.matches)) matchCount += data.matches.length;
    }
    const parts = [
      matchCount > 0 ? `${matchCount} matches` : '',
      fileCount > 0 ? `${fileCount} files` : '',
    ].filter(Boolean);
    return { queryCount, summary: parts.join(', ') || undefined };
  }

  if (toolName === 'localGetFileContent') {
    const paths: string[] = [];
    const previews: string[] = [];
    let lines = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const p = str(data.path ?? data.resolvedPath);
      if (p) paths.push(basename(p));
      if (typeof data.totalLines === 'number') lines += data.totalLines;
      const text = str(data.content ?? data.text ?? data.contentView);
      if (text) previews.push(previewText(text));
    }
    return {
      queryCount,
      paths: paths.slice(0, 4),
      summary: lines > 0 ? `${lines} lines` : undefined,
      previews: previews.slice(0, 2),
    };
  }

  if (toolName === 'localFindFiles') {
    let fileCount = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      if (Array.isArray(data.entries)) fileCount += data.entries.length;
      else if (typeof data.totalEntries === 'number') fileCount += data.totalEntries;
    }
    return { queryCount, summary: fileCount > 0 ? `${fileCount} files` : undefined };
  }

  if (toolName === 'lspGetSemantics') {
    const paths: string[] = [];
    let refCount = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      // definition: data.location.uri
      if (data.location && typeof data.location === 'object') {
        const loc = data.location as Record<string, unknown>;
        const uri = str(loc.uri);
        if (uri) paths.push(`${basename(uri.replace(/\?.*$/, ''))}:${loc.line ?? ''}`);
      }
      // references: data.references[]
      if (Array.isArray(data.references)) refCount += data.references.length;
      if (Array.isArray(data.symbols)) refCount += data.symbols.length;
    }
    return {
      queryCount,
      paths: paths.slice(0, 3),
      summary: refCount > 0 ? `${refCount} refs` : undefined,
    };
  }

  if (toolName === 'npmSearch') {
    const paths: string[] = [];
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const name = str(data.name ?? data.packageName);
      const version = str(data.version);
      if (name) paths.push(version ? `${name}@${version}` : name);
    }
    return { queryCount, paths: paths.slice(0, 3) };
  }

  if (toolName === 'ghHistoryResearch') {
    let count = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      if (Array.isArray(data.items)) count += data.items.length;
      else if (Array.isArray(data.prs)) count += data.prs.length;
      else if (Array.isArray(data.commits)) count += data.commits.length;
    }
    return { queryCount, summary: count > 0 ? `${count} items` : undefined };
  }

  // Generic fallback: count results
  return { queryCount };
}

// ─── renderCall / renderResult builders ──────────────────────────────────────

function stringifyToolPayload(payload: unknown): string {
  if (payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function renderLabeledPayloadLines(label: string, payload: string, theme?: PiTheme): RenderCallReturn {
  const maxLines = 25;
  const allLines = payload.split('\n');
  const shownLines = allLines.slice(0, maxLines);
  const omitted = allLines.length - shownLines.length;
  return makeCachedRenderer((width) => {
    const out = [truncateToWidth(paint(theme, 'muted', `${label}:`), width)];
    for (const line of shownLines) {
      out.push(truncateToWidth(paint(theme, 'dim', `  ${line}`), width));
    }
    if (omitted > 0) {
      out.push(truncateToWidth(paint(theme, 'muted', `  … ${omitted} more line${omitted === 1 ? '' : 's'} hidden`), width));
    }
    return out;
  });
}

/** Build the renderCall component for any octocode tool. */
export function buildOctocodeRenderCall(
  toolName: string,
  args: unknown,
  theme?: PiTheme,
): RenderCallReturn {
  const summary = buildToolCallSummary(toolName, args);
  const icon = paint(theme, 'brand', CLI_GLYPH.tool);
  const nameStr = cliToolTitle(theme, toolName, { bold: true });
  const summaryStr = summary
    ? `${paint(theme, 'dim', ' · ')}${paint(theme, 'dim', summary)}`
    : '';
  const rawLine = `${icon} ${nameStr}${summaryStr}`;
  const requestPayload = stringifyToolPayload(args);
  // Data is fixed here (args/theme captured); cache by width to skip per-frame
  // recompute while streaming.
  if (!requestPayload || requestPayload === '{}') {
    return makeCachedRenderer((width) => [truncateToWidth(rawLine, width)]);
  }
  const requestRenderer = renderLabeledPayloadLines('request', requestPayload, theme);
  return makeCachedRenderer((width) => [
    truncateToWidth(rawLine, width),
    ...requestRenderer.render(width),
  ]);
}

/** First non-empty, trimmed line of a result's text content (its error message or summary). */
/** Max visible cells of the inline `→ result` preview on a collapsed row. */
const RESULT_PREVIEW_MAX = 100;

function firstResultTextLine(result: ToolCallResult): string {
  const text = (result.content as Array<{ type: string; text: string }> | undefined)
    ?.find?.((p) => p?.type === 'text')?.text ?? '';
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** Expanded body: header + labeled response text + a truncation notice. */
function buildExpandedResultBody(header: string, result: ToolCallResult, theme?: PiTheme): RenderCallReturn {
  const text = (result.content as Array<{ type: string; text: string }>)
    ?.find?.((p) => p.type === 'text')?.text ?? '';
  const responseRenderer = renderLabeledPayloadLines('response', text, theme);
  return makeCachedRenderer((width) => [
    truncateToWidth(header, width),
    ...responseRenderer.render(width),
  ]);
}

/** Build the renderResult component for any octocode tool. */
export function buildOctocodeRenderResult(
  toolName: string,
  result: ToolCallResult,
  opts: { expanded?: boolean; isPartial?: boolean },
  theme?: PiTheme,
  context?: RenderContext,
): RenderCallReturn {
  if (opts.isPartial) {
    const nameStr = cliToolTitle(theme, toolName);
    // Evaluate the spinner frame at render time, not construction time — pi
    // re-invokes render() on each tick, so baking cliSpinnerFrame() into a
    // captured string would freeze the spinner for the whole partial phase.
    return makeRenderer((_w) => {
      const spinner = paint(theme, 'brand', cliSpinnerFrame());
      return [`${spinner} ${nameStr} ${paint(theme, 'dim', CLI_STATUS_TEXT.running)}`];
    });
  }

  // Pi ignores isError in the returned ToolCallResult value and instead sets a
  // system-level context.isError when execute() throws or the call is rejected
  // (e.g. schema validation). Honor both so an error row never renders as a
  // misleading success/empty row.
  const isError = Boolean(result.isError) || Boolean(context?.isError);
  const ok = !isError;
  const icon = paint(theme, cliStatusToken(ok), cliStatusGlyph(ok));
  const nameStr = cliToolTitle(theme, toolName);

  // On error, surface the actual failure text — execute() error results carry
  // the message in the first text content line — so the row explains WHY it
  // failed instead of showing a bare error glyph with no data.
  if (isError) {
    const errText = firstResultTextLine(result);
    const errSeg = errText
      ? `${paint(theme, 'dim', ' · ')}${paint(theme, 'error', truncatePlainToWidth(errText, 200))}`
      : '';
    const header = `${icon} ${nameStr}${errSeg}`;
    return opts.expanded ? buildExpandedResultBody(header, result, theme) : makeCachedRenderer((width) => [truncateToWidth(header, width)]);
  }

  const stats = buildResultStats(toolName, result.details);

  // Summary (counts) stays muted; paths get the dedicated `path` colour so a
  // glance separates "what happened" from "which files". Painted as separate SGR
  // spans — safe under pi-tui width measurement (OSC 8 hyperlinks are not, so
  // clickable links are intentionally omitted from TUI rows).
  const summarySeg = stats.summary
    ? stats.summary
    : stats.queryCount !== undefined && stats.queryCount > 1
      ? `${stats.queryCount} queries`
      : '';
  const pathSeg = stats.paths && stats.paths.length > 0 ? stats.paths.join(', ') : '';

  const previewSeg = stats.previews && stats.previews.length > 0 ? stats.previews.join(' | ') : '';
  const painted: string[] = [];
  if (summarySeg) painted.push(paint(theme, 'dim', summarySeg));
  if (pathSeg) painted.push(paint(theme, 'path', pathSeg));
  if (previewSeg) painted.push(paint(theme, 'dim', `“${previewSeg}”`));
  // Every result row carries the result: when the tool reported no structured
  // preview, show the first line of its response (`→ …`) so the operator reads
  // the outcome inline instead of expanding the row (ctrl+o still shows all).
  if (!previewSeg) {
    const firstLine = firstResultTextLine(result);
    if (firstLine) painted.push(paint(theme, 'dim', `→ ${truncatePlainToWidth(firstLine, RESULT_PREVIEW_MAX)}`));
  }
  const statStr = painted.length > 0
    ? `${paint(theme, 'dim', ' · ')}${painted.join(paint(theme, 'dim', ' · '))}`
    : '';

  const header = `${icon} ${nameStr}${statStr}`;

  return opts.expanded ? buildExpandedResultBody(header, result, theme) : makeCachedRenderer((width) => [truncateToWidth(header, width)]);
}
