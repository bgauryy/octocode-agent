/**
 * custom-messages — branded transcript cards for Octocode lifecycle moments.
 *
 * Two custom message types get first-class renderers instead of pi's default
 * plain custom-message row:
 *  - compaction checkpoints (emitted from compaction-hooks on session_compact)
 *  - awareness handoffs (emitted when session awareness is handed to a
 *    successor context/agent)
 *
 * Contract discipline: `content` on a custom message ENTERS THE LLM CONTEXT,
 * so emitters keep it to one terse line; every rich field lives in `details`,
 * which only the renderer reads. Cards follow the box/rule visual language of
 * cli-design (`╭─ ◆ … │ … ╰─`) so transcript cards and tool rows read as one
 * system.
 */

import { paint } from '../tui/cli-design.js';
import type { PiInstance, PiTheme } from '../types.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';

export const COMPACTION_CHECKPOINT_TYPE = 'octocode-compaction-checkpoint';
export const AWARENESS_HANDOFF_TYPE = 'octocode-awareness-handoff';

const BRAND_GLYPH = '◆';
const MAX_SUMMARY_LINES = 8;
const MAX_LIST_ITEMS = 6;

// ─── Details payloads (renderer-only; never enter the LLM context) ───────────

export interface CompactionCheckpointDetails {
  /** Short human label for the checkpoint (entry id or reason). */
  label: string;
  reason?: string;
  tokensBefore?: number;
  /** True when the extension (not pi/user) triggered the compaction. */
  fromExtension?: boolean;
  readFiles?: string[];
  modifiedFiles?: string[];
  /** Compaction summary text (shown truncated when expanded). */
  summary?: string;
}

export interface AwarenessHandoffDetails {
  /** Short human label for the handoff. */
  label: string;
  from?: string;
  to?: string;
  goal?: string;
  status?: string;
  notes?: string[];
  artifacts?: string[];
}

// ─── Card builders (pure) ─────────────────────────────────────────────────────

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width));
}

function cardHeader(title: string, label: string, theme: PiTheme | undefined): string {
  return `${paint(theme, 'brand', BRAND_GLYPH)} ${paint(theme, 'title', title)}${paint(theme, 'dim', ' · ')}${paint(theme, 'brand', label)}`;
}

function boxTop(title: string, label: string, theme: PiTheme | undefined): string {
  return `${paint(theme, 'brand', '╭─')} ${cardHeader(title, label, theme)}`;
}

function boxBody(text: string, theme: PiTheme | undefined): string {
  return `${paint(theme, 'brand', '│')}  ${text}`;
}

function boxBottom(text: string, theme: PiTheme | undefined): string {
  return `${paint(theme, 'brand', '╰─')} ${paint(theme, 'muted', text)}`;
}

function listLine(title: string, items: string[], theme: PiTheme | undefined): string | undefined {
  if (items.length === 0) return undefined;
  const shown = items.slice(0, MAX_LIST_ITEMS).join(', ');
  const more = items.length > MAX_LIST_ITEMS ? `, … +${items.length - MAX_LIST_ITEMS}` : '';
  return `${paint(theme, 'muted', `${title} (${items.length}):`)} ${paint(theme, 'path', shown)}${paint(theme, 'dim', more)}`;
}

function compactionStatLine(details: CompactionCheckpointDetails, theme: PiTheme | undefined): string | undefined {
  const parts = [
    details.reason ? `reason: ${details.reason}` : '',
    details.tokensBefore !== undefined ? `tokens before: ${details.tokensBefore}` : '',
    details.fromExtension === undefined ? '' : `source: ${details.fromExtension ? 'octocode' : 'pi'}`,
  ].filter(Boolean);
  if (parts.length === 0) return undefined;
  return paint(theme, 'dim', parts.join(' · '));
}

/**
 * Branded compaction-checkpoint card. Collapsed = 1–2 lines (header + stat
 * line); expanded = full box with file lists and a summary excerpt.
 */
export function buildCompactionCard(
  details: CompactionCheckpointDetails,
  expanded: boolean,
  theme: PiTheme | undefined,
  width: number,
): string[] {
  const label = details.label || 'checkpoint';
  const stat = compactionStatLine(details, theme);

  if (!expanded) {
    const lines = [cardHeader('Compaction checkpoint', label, theme)];
    if (stat) lines.push(`  ${stat}`);
    return lines.map((line) => fit(line, width));
  }

  const lines: (string | undefined)[] = [boxTop('Compaction checkpoint', label, theme)];
  if (stat) lines.push(boxBody(stat, theme));
  const read = listLine('read files', details.readFiles ?? [], theme);
  if (read) lines.push(boxBody(read, theme));
  const modified = listLine('modified files', details.modifiedFiles ?? [], theme);
  if (modified) lines.push(boxBody(modified, theme));
  if (details.summary) {
    const summaryLines = details.summary.split('\n');
    for (const line of summaryLines.slice(0, MAX_SUMMARY_LINES)) {
      lines.push(boxBody(paint(theme, 'dim', line), theme));
    }
    const omitted = summaryLines.length - MAX_SUMMARY_LINES;
    if (omitted > 0) {
      lines.push(boxBody(paint(theme, 'muted', `… ${omitted} more summary line${omitted === 1 ? '' : 's'}`), theme));
    }
  }
  lines.push(boxBottom('context compacted — resuming from checkpoint', theme));
  return lines.filter((line): line is string => Boolean(line)).map((line) => fit(line, width));
}

/**
 * Branded awareness-handoff card. Collapsed = 1–2 lines (header + route);
 * expanded = full box with goal, status, notes, and artifacts.
 */
export function buildHandoffCard(
  details: AwarenessHandoffDetails,
  expanded: boolean,
  theme: PiTheme | undefined,
  width: number,
): string[] {
  const label = details.label || 'handoff';
  const routeParts = [
    details.from || details.to ? `${details.from ?? '?'} → ${details.to ?? '?'}` : '',
    details.status ? `status: ${details.status}` : '',
  ].filter(Boolean);
  const route = routeParts.length > 0 ? paint(theme, 'dim', routeParts.join(' · ')) : undefined;

  if (!expanded) {
    const lines = [cardHeader('Awareness handoff', label, theme)];
    if (route) lines.push(`  ${route}`);
    return lines.map((line) => fit(line, width));
  }

  const lines: string[] = [boxTop('Awareness handoff', label, theme)];
  if (route) lines.push(boxBody(route, theme));
  if (details.goal) {
    lines.push(boxBody(`${paint(theme, 'muted', 'goal:')} ${paint(theme, 'dim', details.goal)}`, theme));
  }
  for (const note of (details.notes ?? []).slice(0, MAX_LIST_ITEMS)) {
    lines.push(boxBody(paint(theme, 'dim', `- ${note}`), theme));
  }
  const omittedNotes = (details.notes?.length ?? 0) - MAX_LIST_ITEMS;
  if (omittedNotes > 0) {
    lines.push(boxBody(paint(theme, 'muted', `… ${omittedNotes} more note${omittedNotes === 1 ? '' : 's'}`), theme));
  }
  const artifacts = listLine('artifacts', details.artifacts ?? [], theme);
  if (artifacts) lines.push(boxBody(artifacts, theme));
  lines.push(boxBottom('awareness handed off', theme));
  return lines.map((line) => fit(line, width));
}

// ─── Renderer registration ────────────────────────────────────────────────────

function detailsOf(message: unknown): Record<string, unknown> {
  if (message && typeof message === 'object') {
    const details = (message as { details?: unknown }).details;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      return details as Record<string, unknown>;
    }
  }
  return {};
}

/**
 * Register the branded renderers for both Octocode custom-message types.
 * First-registrant wins in pi, so this should run once at extension setup.
 */
export function registerOctocodeMessageRenderers(pi: PiInstance): void {
  pi.registerMessageRenderer?.(COMPACTION_CHECKPOINT_TYPE, (message, options, theme) =>
    makeRenderer((width) =>
      buildCompactionCard(
        detailsOf(message) as unknown as CompactionCheckpointDetails,
        options?.expanded === true,
        theme,
        width,
      ),
    ),
  );
  pi.registerMessageRenderer?.(AWARENESS_HANDOFF_TYPE, (message, options, theme) =>
    makeRenderer((width) =>
      buildHandoffCard(
        detailsOf(message) as unknown as AwarenessHandoffDetails,
        options?.expanded === true,
        theme,
        width,
      ),
    ),
  );
}

// ─── Emitters ─────────────────────────────────────────────────────────────────
//
// CRITICAL: `content` participates in the LLM context — keep it ONE terse line.
// All rich data rides in `details`, which only the renderer sees. No
// triggerTurn: these are passive transcript records, never turn starters.

export function emitCompactionCheckpoint(pi: PiInstance, details: CompactionCheckpointDetails): void {
  pi.sendMessage?.({
    customType: COMPACTION_CHECKPOINT_TYPE,
    content: `Compaction checkpoint saved: ${details.label}`,
    display: true,
    details,
  });
}

export function emitAwarenessHandoff(pi: PiInstance, details: AwarenessHandoffDetails): void {
  pi.sendMessage?.({
    customType: AWARENESS_HANDOFF_TYPE,
    content: `Awareness handoff recorded: ${details.label}`,
    display: true,
    details,
  });
}
