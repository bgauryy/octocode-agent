import { keyHint, type Theme } from '@earendil-works/pi-coding-agent';
import { Text, type Component } from '@earendil-works/pi-tui';
import { isRecord } from './util.js';

/**
 * Shared tool presentation, following Pi's built-in tools: a one-line call, a short result preview, and the
 * full output on expand (ctrl+o). Without a renderer Pi prints the raw JSON arguments and the whole output.
 */

/** Result lines shown while collapsed. */
export const COLLAPSED_LINES = 6;
/** Collapsed lines are clipped so one long line (minified JSON, a page of text) cannot fill the screen. */
const COLLAPSED_LINE_CHARS = 220;

/** Reuse the component Pi hands back for this render slot, as the built-in renderers do. */
export function textComponent(context: { lastComponent?: Component | undefined } | undefined, text: string): Text {
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text('', 0, 0);
  component.setText(text);
  return component;
}

export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => (part.type === 'text' ? (part.text ?? '') : part.type === 'image' ? '[image]' : '')).join('\n');
}

export const expandHint = () => keyHint('app.tools.expand', 'to expand');

/** First lines of `text` with a "more lines" hint when collapsed; every line when expanded. */
export function preview(text: string, theme: Theme, expanded: boolean, options: { max?: number; color?: 'toolOutput' | 'error' | 'muted'; hint?: () => string } = {}): string {
  const lines = text.replace(/\t/g, '   ').split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  if (lines.length === 0) return '';
  const max = options.max ?? COLLAPSED_LINES;
  const shown = expanded ? lines : lines.slice(0, max).map((line) => (line.length > COLLAPSED_LINE_CHARS ? `${line.slice(0, COLLAPSED_LINE_CHARS - 1)}…` : line));
  const body = shown.map((line) => theme.fg(options.color ?? 'toolOutput', line)).join('\n');
  const remaining = lines.length - shown.length;
  if (remaining <= 0) return body;
  return `${body}\n${theme.fg('muted', `… ${remaining} more line${remaining === 1 ? '' : 's'} (`)}${(options.hint ?? expandHint)()}${theme.fg('muted', ')')}`;
}

/** `title detail`, the call line every tool shares. */
export function callLine(theme: Theme, title: string, detail = ''): string {
  return `${theme.fg('toolTitle', theme.bold(title))}${detail ? ` ${detail}` : ''}`;
}

/** Why the model made this call, from the schema's reasoning field, on its own muted line. */
export function reasoningLine(theme: Theme, reasoning: unknown, indent = '  '): string | undefined {
  return typeof reasoning === 'string' && reasoning.trim() ? `${indent}${theme.fg('muted', `↳ ${theme.italic(reasoning.trim())}`)}` : undefined;
}

const TARGET_KEYS = ['path', 'filePath', 'pattern', 'keywords', 'keywordsToSearch', 'symbolName', 'packageName', 'query', 'url', 'name'] as const;
const WHY_KEYS = ['reasoning', 'researchGoal', 'description'] as const;

/** The most telling value of one query: its path, search terms, repository or package. */
export function queryTarget(query: Record<string, unknown>): string {
  const repo = typeof query['owner'] === 'string' && typeof query['repo'] === 'string' ? `${query['owner']}/${query['repo']}` : undefined;
  for (const key of TARGET_KEYS) {
    const value = query[key];
    const text = Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(' ') : typeof value === 'string' ? value : '';
    if (text) return repo && key !== 'path' ? `${repo} ${text}` : repo ? `${repo}/${text}` : text;
  }
  return repo ?? '';
}

/** Call summary for batched `{ queries: [...] }` tools (Octocode research) and plain-argument MCP tools. */
export function queriesSummary(args: unknown, theme: Theme, maxQueries = 4): string[] {
  if (!isRecord(args)) return [];
  const queries = Array.isArray(args['queries']) ? args['queries'].filter(isRecord) : [args];
  const lines = queries.slice(0, maxQueries).flatMap((query) => {
    const target = queryTarget(query);
    const why = WHY_KEYS.map((key) => query[key]).find((value) => typeof value === 'string' && value.trim());
    return [
      ...(target ? [`  ${theme.fg('accent', target.split('\n')[0]!.slice(0, 140))}`] : []),
      ...(why ? [reasoningLine(theme, why, '    ')!] : []),
    ];
  });
  if (queries.length > maxQueries) lines.push(theme.fg('muted', `  +${queries.length - maxQueries} more`));
  return lines;
}
