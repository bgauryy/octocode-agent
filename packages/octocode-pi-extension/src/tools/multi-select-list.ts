/**
 * multi-select-list — pure list state for a checkbox-style multi-select overlay.
 *
 * Deliberately free of pi-coding-agent and Node APIs so the whole state machine
 * — cursor, toggles, min/max gating, rendering — is unit-testable standalone.
 * Keyboard decoding uses pi-tui's matchesKey/Key helpers so Kitty keyboard
 * protocol and legacy terminal byte sequences share one host-compatible path.
 */

import { Key, matchesKey } from '@earendil-works/pi-tui';

export interface MultiSelectItem {
  value: string;
  label?: string;
  description?: string;
  /** Optional multi-line preview shown under the item while it has cursor focus. */
  preview?: string;
}

/** Minimal theme surface, structurally compatible with PiTheme (method syntax → bivariant). */
export interface MultiSelectTheme {
  fg?(color: string, text: string): string;
  bold?(text: string): string;
}

export interface MultiSelectListOptions {
  /** Minimum selections required before confirm is allowed (default 0). */
  min?: number;
  /** Maximum selections allowed — further toggles are no-ops (default unlimited). */
  max?: number;
  /** Values pre-toggled on open (unknown values ignored, max respected). */
  initial?: string[];
}

export type MultiSelectKeyAction = 'up' | 'down' | 'toggle' | 'confirm' | 'cancel' | undefined;

/**
 * Map a stdin chunk to a multi-select action through pi-tui's key matcher:
 * arrows / ctrl-p / ctrl-n move, space toggles, enter confirms, and
 * esc / ctrl-c cancels. Anything else is ignored.
 */
export function multiSelectKeyAction(data: string): MultiSelectKeyAction {
  if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('p'))) return 'up';
  if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('n'))) return 'down';
  if (matchesKey(data, Key.space)) return 'toggle';
  if (matchesKey(data, Key.enter)) return 'confirm';
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) return 'cancel';
  return undefined;
}

/** Plain-text clip to `width` cells with a trailing ellipsis (no ANSI awareness needed — callers paint after clipping). */
function clip(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return text.slice(0, width - 1) + '…';
}

export class MultiSelectList {
  readonly items: MultiSelectItem[];
  readonly min: number;
  readonly max: number;
  cursor = 0;
  private readonly toggled = new Set<number>();

  constructor(items: MultiSelectItem[], opts: MultiSelectListOptions = {}) {
    this.items = (Array.isArray(items) ? items : []).filter(
      (i): i is MultiSelectItem => Boolean(i && typeof i.value === 'string' && i.value.length > 0),
    );
    const rawMin = Number.isFinite(opts.min) ? Math.max(0, Math.floor(opts.min!)) : 0;
    const rawMax = Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max!)) : Number.POSITIVE_INFINITY;
    // Clamp so the constraints stay satisfiable: min never exceeds the item
    // count, max never undercuts min (otherwise confirm would be unreachable).
    this.min = Math.min(rawMin, this.items.length);
    this.max = Math.max(rawMax, this.min);
    for (const value of opts.initial ?? []) {
      const index = this.items.findIndex((i) => i.value === value);
      if (index >= 0) this.toggle(index);
    }
  }

  /** Move the cursor by `delta`, clamped to the list bounds. Returns the new cursor. */
  moveCursor(delta: number): number {
    if (this.items.length === 0) return this.cursor;
    this.cursor = Math.min(this.items.length - 1, Math.max(0, this.cursor + delta));
    return this.cursor;
  }

  /**
   * Toggle the item at `index` (defaults to the cursor). Returns whether the
   * selection changed — adding beyond `max` is a gated no-op (returns false);
   * removing is always allowed.
   */
  toggle(index: number = this.cursor): boolean {
    if (index < 0 || index >= this.items.length) return false;
    if (this.toggled.has(index)) {
      this.toggled.delete(index);
      return true;
    }
    if (this.toggled.size >= this.max) return false;
    this.toggled.add(index);
    return true;
  }

  isToggled(index: number): boolean {
    return this.toggled.has(index);
  }

  selectionCount(): number {
    return this.toggled.size;
  }

  /** Whether enter may confirm: selection count within [min, max]. */
  canConfirm(): boolean {
    return this.toggled.size >= this.min && this.toggled.size <= this.max;
  }

  /** Selected values in item (display) order, not toggle order. */
  selectedValues(): string[] {
    return this.items.filter((_, i) => this.toggled.has(i)).map((i) => i.value);
  }

  /** Count + constraint summary shown as the footer line. */
  footerText(): string {
    const n = this.toggled.size;
    const parts = [`${n} selected`];
    if (this.min > 0) parts.push(`min ${this.min}`);
    if (Number.isFinite(this.max)) parts.push(`max ${this.max}`);
    parts.push(n < this.min ? `select ${this.min - n} more` : 'enter to confirm');
    return parts.join(' · ');
  }

  /**
   * Render the list to plain-or-painted lines:
   *   `› [x] Label — description` rows (cursor marker + checkbox glyphs),
   *   an indented preview block under the focused item, and a footer line
   *   (dim when confirmable, warning while below `min`).
   */
  render(width: number, theme?: MultiSelectTheme): string[] {
    const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
    const lines: string[] = [];
    this.items.forEach((item, i) => {
      const focused = i === this.cursor;
      const head = `${focused ? '›' : ' '} ${this.toggled.has(i) ? '[x]' : '[ ]'} ${item.label ?? item.value}`;
      const clippedHead = clip(head, width);
      let line = focused ? fg('accent', clippedHead) : clippedHead;
      if (item.description && clippedHead.length < width) {
        line += fg('muted', clip(` — ${item.description}`, width - clippedHead.length));
      }
      lines.push(line);
      if (focused && item.preview) {
        for (const previewLine of String(item.preview).split('\n')) {
          lines.push(fg('dim', clip(`    │ ${previewLine}`, width)));
        }
      }
    });
    lines.push(fg(this.canConfirm() ? 'dim' : 'warning', clip(this.footerText(), width)));
    return lines;
  }
}
