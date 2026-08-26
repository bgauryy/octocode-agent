/** Pure, React-shaped terminal components shared by footer, widgets, and cards. */
import type { PiTheme } from '../types.js';
import { CURSOR_MARKER } from '@earendil-works/pi-tui';
import { paint, SEP, type SemanticToken } from './palette.js';
import { truncateToWidth, visibleWidth } from '../tools/render-helpers.js';

export interface TuiRenderContext {
  width: number;
  theme?: PiTheme;
}

export type TuiComponent<Props> = (props: Props, context: TuiRenderContext) => string[];

export interface InlineSegment {
  text: string;
  token?: SemanticToken;
  attention?: boolean;
}

function safeWidth(width: number): number {
  return Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function segmentText(segment: InlineSegment, theme?: PiTheme): string {
  const colored = paint(theme, segment.token ?? 'dim', segment.text);
  return segment.attention ? (theme?.bold?.(colored) ?? colored) : colored;
}

export interface InlineRowsProps {
  segments: readonly InlineSegment[];
  separator?: string;
  prioritizeAttention?: boolean;
  prefix?: string;
}

/** Pack semantic segments into responsive rows; never discard a tail segment. */
export const renderInlineRows: TuiComponent<InlineRowsProps> = (props, context) => {
  const width = safeWidth(context.width);
  const separator = props.separator ?? SEP;
  const ordered = props.prioritizeAttention
    ? [...props.segments].sort((a, b) => Number(Boolean(b.attention)) - Number(Boolean(a.attention)))
    : [...props.segments];
  const rows: string[] = [];
  let row = props.prefix ?? '';
  for (const segment of ordered.filter((item) => item.text.trim().length > 0)) {
    const value = segmentText(segment, context.theme);
    const joiner = row ? separator : '';
    const candidate = `${row}${joiner}${value}`;
    if (row && visibleWidth(candidate) > width) {
      rows.push(truncateToWidth(row, width));
      row = value;
    } else {
      row = candidate;
    }
    if (visibleWidth(row) > width) {
      rows.push(truncateToWidth(row, width));
      row = '';
    }
  }
  if (row) rows.push(truncateToWidth(row, width));
  return rows;
};

export interface StackProps {
  sections: readonly (readonly string[])[];
}

export const renderStack: TuiComponent<StackProps> = (props, context) => {
  const width = safeWidth(context.width);
  return props.sections.flatMap((section) => section)
    .filter((line) => line.length > 0)
    .map((line) => truncateToWidth(line, width));
};

export interface FrameProps {
  title: string;
  body: readonly string[];
  footer?: string;
  borderToken?: SemanticToken;
  titleToken?: SemanticToken;
  footerToken?: SemanticToken;
}

export interface OpenFrameProps {
  lines: readonly string[];
  borderToken?: SemanticToken;
}

/** Close legacy left-rail frames while callers migrate their body rows to FrameProps. */
export const closeFrameLines: TuiComponent<OpenFrameProps> = (props, context) => {
  const width = safeWidth(context.width);
  if (props.lines.length === 0) return [];
  if (width === 1) return props.lines.map(() => paint(context.theme, props.borderToken ?? 'dim', '│'));
  return props.lines.map((line, index) => {
    const right = index === 0 ? '╮' : index === props.lines.length - 1 ? '╯' : '│';
    if (line.includes(CURSOR_MARKER)) {
      const markerAt = line.indexOf(CURSOR_MARKER);
      const before = truncateToWidth(line.slice(0, markerAt), width - 1);
      const remaining = Math.max(0, width - 1 - visibleWidth(before));
      const after = fit(line.slice(markerAt + CURSOR_MARKER.length), remaining);
      return `${before}${CURSOR_MARKER}${after}${paint(context.theme, props.borderToken ?? 'dim', right)}`;
    }
    return `${fit(line, width - 1)}${paint(context.theme, props.borderToken ?? 'dim', right)}`;
  });
};

function frameRule(
  left: string,
  right: string,
  label: string | undefined,
  width: number,
  theme: PiTheme | undefined,
  borderToken: SemanticToken,
  labelToken: SemanticToken,
): string {
  if (width === 1) return paint(theme, borderToken, left);
  const innerWidth = width - 2;
  const labelBudget = Math.max(0, innerWidth - 3);
  const clippedLabel = label ? truncateToWidth(label, labelBudget) : '';
  const labelPart = clippedLabel ? `─ ${clippedLabel} ` : '';
  const fill = '─'.repeat(Math.max(0, innerWidth - visibleWidth(labelPart)));
  if (!clippedLabel) return paint(theme, borderToken, `${left}${fill}${right}`);
  return `${paint(theme, borderToken, `${left}─ `)}${paint(theme, labelToken, clippedLabel)}${paint(theme, borderToken, ` ${fill}${right}`)}`;
}

/** Render a fully closed, cell-width-perfect frame. */
export const renderFrame: TuiComponent<FrameProps> = (props, context) => {
  const width = safeWidth(context.width);
  const borderToken = props.borderToken ?? 'dim';
  const lines = [frameRule('╭', '╮', props.title, width, context.theme, borderToken, props.titleToken ?? 'brand')];
  if (width === 1) return lines;
  const innerWidth = width - 2;
  for (const bodyLine of props.body) {
    lines.push(`${paint(context.theme, borderToken, '│')}${fit(` ${bodyLine}`, innerWidth)}${paint(context.theme, borderToken, '│')}`);
  }
  lines.push(frameRule('╰', '╯', props.footer, width, context.theme, borderToken, props.footerToken ?? 'muted'));
  return lines;
};
