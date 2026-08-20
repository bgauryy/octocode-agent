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
import type { PiTheme, RenderCallReturn, ToolCallResult } from '../types.js';

// ─── ANSI-safe width helpers ──────────────────────────────────────────────────
//
// Width measurement and truncation delegate to pi-tui's own visibleWidth /
// truncateToWidth. pi's renderer crashes any line whose pi-tui-measured width
// exceeds the terminal width, and pi's extension loader aliases the
// `@earendil-works/pi-tui` import to the host's bundled copy — so delegating
// guarantees we can never disagree with the arbiter of that check.

/** C0/C1 control chars except tab (expanded below) and ESC (0x1B, ANSI). */
const CONTROL_CHAR_RE = /[\x00-\x08\x0A-\x1A\x1C-\x1F\x7F-\x9F]/g;

/**
 * Replace tabs with 3 spaces and other control characters with a space so the
 * string renders exactly as measured: pi-tui *counts* a tab as 3 columns but
 * emits it raw (terminals advance to their own tab stops), and counts other
 * control chars as 0 columns even though e.g. `\r` moves the cursor.
 */
export function sanitizeLine(str: string): string {
  if (!str.includes('\t') && !CONTROL_CHAR_RE.test(str)) {
    CONTROL_CHAR_RE.lastIndex = 0;
    return str;
  }
  CONTROL_CHAR_RE.lastIndex = 0;
  return str.replace(/\t/g, '   ').replace(CONTROL_CHAR_RE, ' ');
}

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
 * Word-wrap plain text (no ANSI codes) into lines of at most `maxWidth` visible
 * characters each. Words longer than `maxWidth` are hard-truncated on that boundary.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const safeWord = word.length > maxWidth ? word.slice(0, maxWidth) : word;
    if (!current) {
      current = safeWord;
    } else {
      const candidate = `${current} ${safeWord}`;
      if (candidate.length <= maxWidth) {
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
  if (p.length <= maxLen) return p;
  // keep last portion
  const short = '…' + p.slice(-(maxLen - 1));
  return short;
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
      const anchor = matchStr ? ` /${matchStr.slice(0, 20)}/` : start + end;
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
      const anchor = matchStr ? ` /${matchStr.slice(0, 20)}/` : start + end;
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
  const SKIP_KEYS = new Set(['id', 'reasoning', 'researchGoal', 'mainResearchGoal', 'resolveedPath']);
  const parts = Object.entries(q)
    .filter(([k]) => !SKIP_KEYS.has(k))
    .map(([, v]) => {
      const s = String(v ?? '');
      return s.length > 40 ? s.slice(0, 40) + '…' : s;
    })
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
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
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

  if (toolName === 'ghViewRepoStructure') {
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

  if (toolName === 'localViewStructure') {
    let entryCount = 0;
    for (const r of results) {
      const data = (r.data ?? {}) as Record<string, unknown>;
      if (typeof data.totalEntries === 'number') entryCount += data.totalEntries;
      else if (Array.isArray(data.files)) entryCount += data.files.length;
    }
    return { queryCount, summary: entryCount > 0 ? `${entryCount} entries` : undefined };
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
  return singleLineRenderer(rawLine);
}

/** Build the renderResult component for any octocode tool. */
export function buildOctocodeRenderResult(
  toolName: string,
  result: ToolCallResult,
  opts: { expanded?: boolean; isPartial?: boolean },
  theme?: PiTheme,
): RenderCallReturn {
  if (opts.isPartial) {
    const spinner = paint(theme, 'warning', cliSpinnerFrame());
    const nameStr = cliToolTitle(theme, toolName);
    const running = `${spinner} ${nameStr} ${paint(theme, 'dim', CLI_STATUS_TEXT.running)}`;
    return singleLineRenderer(running);
  }

  const ok = !result.isError;
  const stats = buildResultStats(toolName, result.details);

  // Build header: status glyph + toolName · stat-summary
  const icon = paint(theme, cliStatusToken(ok), cliStatusGlyph(ok));
  const nameStr = cliToolTitle(theme, toolName);

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
  const statStr = painted.length > 0
    ? `${paint(theme, 'dim', ' · ')}${painted.join(paint(theme, 'dim', ' · '))}`
    : '';

  const header = `${icon} ${nameStr}${statStr}`;

  if (!opts.expanded) {
    return singleLineRenderer(header);
  }

  // Expanded: show up to 25 lines of text content + truncation notice
  const text = (result.content as Array<{ type: string; text: string }>)
    ?.find?.((p) => p.type === 'text')?.text ?? '';
  const MAX_LINES = 25;
  const allLines = text.split('\n');
  const shownLines = allLines.slice(0, MAX_LINES);
  const omitted = allLines.length - shownLines.length;

  return makeRenderer((width) => {
    const out: string[] = [truncateToWidth(header, width)];
    for (const line of shownLines) {
      out.push(truncateToWidth(paint(theme, 'dim', line), width));
    }
    if (omitted > 0) {
      out.push(
        truncateToWidth(
          paint(theme, 'muted', `… ${omitted} more line${omitted === 1 ? '' : 's'} hidden (full output available to agent)`),
          width,
        ),
      );
    }
    return out;
  });
}
