import { OpenTuiWidget } from './base.js';
import type {
  WidgetInput,
  WidgetInputResult,
  WidgetRenderAdapter,
  WidgetRenderRegion,
  WidgetRenderState,
} from './contracts.js';
import { assertStableTerminalId, sanitizeCollapsedSingleLine } from './sanitize.js';

export type StatusNotificationSlot = 'session' | 'agent' | 'tool' | 'permission' | 'system';
export type StatusNotificationLifecycle = 'active' | 'success' | 'warning' | 'error' | 'cleared';
export type StatusNotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface StatusNotificationAction {
  readonly id: string;
  readonly label: string;
}

export interface StatusNotificationInput {
  /** Canonical runtime authority is required because lifecycle derives announcement urgency. */
  readonly authority: 'runtime';
  readonly slot: StatusNotificationSlot;
  readonly id: string;
  readonly message: string;
  readonly lifecycle: StatusNotificationLifecycle;
  readonly action?: StatusNotificationAction;
}

export interface StatusNotificationItem extends StatusNotificationInput {
  readonly key: string;
  readonly order: number;
  readonly timestamp: number;
  readonly severity: StatusNotificationSeverity;
}

export interface StatusNotificationAnnouncement {
  readonly key: string;
  readonly severity: StatusNotificationSeverity;
  readonly role: 'status' | 'alert';
  readonly liveRegion: 'polite' | 'assertive';
  readonly text: string;
}

export interface StatusNotificationOutput {
  readonly type: 'action' | 'cancel';
  readonly key?: string;
  readonly action?: StatusNotificationAction;
}

export interface StatusNotificationsWidgetOptions {
  readonly itemLimit?: number;
  readonly historyLimit?: number;
  readonly announcementLimit?: number;
}

const DEFAULT_ITEM_LIMIT = 32;
const DEFAULT_HISTORY_LIMIT = 128;
const DEFAULT_ANNOUNCEMENT_LIMIT = 32;
const MIN_LIMIT = 1;
const MAX_ITEM_LIMIT = 64;
const MAX_HISTORY_LIMIT = 512;
const MAX_ANNOUNCEMENT_LIMIT = 64;
const ID_LIMIT = 80;
const MESSAGE_LIMIT = 1_000;
const ACTION_LABEL_LIMIT = 120;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

const VALID_SLOTS: ReadonlySet<string> = new Set([
  'session',
  'agent',
  'tool',
  'permission',
  'system',
]);

const VALID_LIFECYCLES: ReadonlySet<string> = new Set([
  'active',
  'success',
  'warning',
  'error',
  'cleared',
]);

const PRESENTATION: Readonly<Record<StatusNotificationSeverity, { glyph: string; word: string }>> = {
  info: { glyph: 'ℹ', word: 'INFO' },
  success: { glyph: '✓', word: 'SUCCESS' },
  warning: { glyph: '!', word: 'WARNING' },
  error: { glyph: '✗', word: 'ERROR' },
};

const AGENT_INSTRUCTIONS = {
  purpose: 'Maintain bounded, stable status and notification slots without allowing model-authored urgency.',
  useWhen: [
    'A real session, agent, tool, permission, or system lifecycle event needs a visible status item.',
    'A lifecycle-keyed item should be replaced, cleared, or offered with a runtime-dispatched action.',
  ],
  avoidWhen: [
    'The content belongs in the transcript or tool progress detail.',
    'There is no real lifecycle event or stable identity; never create decorative or speculative notifications.',
  ],
  inputs: [
    'Only the canonical runtime may supply authority=runtime with a supported slot, stable id, bounded message, lifecycle, and optional action descriptor.',
    'Use the same slot and id to replace or clear the same logical item.',
  ],
  stateAndOutput: [
    'The runtime derives severity and announcement urgency from lifecycle; the agent never supplies either.',
    'Active items map to info, success to success, warning to warning, and error to error.',
    'An action is returned to the owning runtime for validation and dispatch; rendering never executes it.',
    'The alternate output emits each current item once in timestamp, insertion-order, severity, identity, and message order.',
  ],
  keys: [
    'Arrow Up and Arrow Down move through items; Home and End jump to the first or last item.',
    'Enter activates the selected action when one exists; Escape or Ctrl-C returns cancellation to the owning view.',
  ],
  accessibility: [
    'Info and success updates use a polite status channel; warnings and errors use an assertive alert channel.',
    'Every item includes a textual severity and color-independent glyph.',
    'Reduced motion is inherently supported: this widget never uses a spinner, blink, or animated replacement.',
  ],
  recovery: [
    'Duplicate updates are ignored and pending announcements are bounded to prevent a notification storm.',
    'ANSI, OSC, terminal controls, and multiline injection are removed before any content is rendered.',
    'When capacity is reached, evict the oldest item deterministically and retain bounded history for inspection.',
  ],
} as const;

function validateLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < MIN_LIMIT || value > maximum) {
    throw new Error(`${label} must be an integer from ${MIN_LIMIT} to ${maximum}`);
  }
  return value;
}

function safeSingleLine(value: string, limit: number, label: string, allowEmpty = false): string {
  const normalized = sanitizeCollapsedSingleLine(value, {
    maxGraphemes: limit,
  });
  if (!allowEmpty && normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function normalizeInput(input: StatusNotificationInput): StatusNotificationInput {
  if (input.authority !== 'runtime') throw new Error('notification authority must be the canonical runtime');
  if (!VALID_SLOTS.has(input.slot)) throw new Error('notification slot is invalid');
  if (!VALID_LIFECYCLES.has(input.lifecycle)) throw new Error('notification lifecycle is invalid');
  const id = assertStableTerminalId(input.id, { maxLength: ID_LIMIT });
  const message = safeSingleLine(
    input.message,
    MESSAGE_LIMIT,
    'notification message',
    input.lifecycle === 'cleared',
  );
  const action = input.action === undefined
    ? undefined
    : Object.freeze({
        id: assertStableTerminalId(input.action.id, { maxLength: ID_LIMIT }),
        label: safeSingleLine(input.action.label, ACTION_LABEL_LIMIT, 'action label'),
      });
  return Object.freeze({
    authority: 'runtime',
    slot: input.slot,
    id,
    message,
    lifecycle: input.lifecycle,
    ...(action === undefined ? {} : { action }),
  });
}

function severityFor(lifecycle: Exclude<StatusNotificationLifecycle, 'cleared'>): StatusNotificationSeverity {
  switch (lifecycle) {
    case 'active': return 'info';
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'error': return 'error';
  }
}

function itemSignature(item: StatusNotificationInput): string {
  return JSON.stringify([item.message, item.lifecycle, item.action?.id, item.action?.label]);
}

export class StatusNotificationsWidget extends OpenTuiWidget<StatusNotificationOutput> {
  private readonly itemLimit: number;
  private readonly historyLimit: number;
  private readonly announcementLimit: number;
  private readonly activeItems = new Map<string, StatusNotificationItem>();
  private readonly historyItems: StatusNotificationItem[] = [];
  private readonly announcements: StatusNotificationAnnouncement[] = [];
  private nextOrder = 1;
  private selectedKey: string | undefined;

  constructor(id: string, options: StatusNotificationsWidgetOptions = {}) {
    super({
      id,
      kind: 'status.notifications',
      capabilities: { focusable: true, inputMode: 'selection' },
      accessibility: {
        role: 'listbox',
        label: 'Status and notifications',
        description: 'A bounded, keyboard-navigable list of runtime lifecycle updates.',
        liveRegion: 'polite',
        keyboardHelp: [
          'Use Arrow Up or Arrow Down to navigate, Home or End to jump, Enter for an action, and Escape or Ctrl-C to cancel.',
        ],
      },
      instructions: AGENT_INSTRUCTIONS,
    });
    this.itemLimit = validateLimit(options.itemLimit, DEFAULT_ITEM_LIMIT, MAX_ITEM_LIMIT, 'item limit');
    this.historyLimit = validateLimit(options.historyLimit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, 'history limit');
    this.announcementLimit = validateLimit(
      options.announcementLimit,
      DEFAULT_ANNOUNCEMENT_LIMIT,
      MAX_ANNOUNCEMENT_LIMIT,
      'announcement limit',
    );
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  get items(): readonly StatusNotificationItem[] {
    return Object.freeze([...this.activeItems.values()]);
  }

  get history(): readonly StatusNotificationItem[] {
    return Object.freeze([...this.historyItems]);
  }

  upsert(value: StatusNotificationInput, timestamp = Date.now()): void {
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > MAX_DATE_TIMESTAMP) {
      throw new Error('timestamp must be within the JavaScript Date ISO range');
    }
    const input = normalizeInput(value);
    const key = `${input.slot}:${input.id}`;
    const current = this.activeItems.get(key);

    if (input.lifecycle === 'cleared') {
      if (current === undefined) return;
      this.activeItems.delete(key);
      if (this.selectedKey === key) this.selectedKey = this.items[0]?.key;
      this.invalidate();
      return;
    }

    if (current !== undefined && itemSignature(current) === itemSignature(input)) return;

    const item = Object.freeze({
      ...input,
      key,
      order: current?.order ?? this.nextOrder++,
      timestamp,
      severity: severityFor(input.lifecycle),
    });
    this.activeItems.set(key, item);
    this.appendHistory(item);
    this.queueAnnouncement(item);
    this.evictOldestItems();
    this.selectedKey ??= item.key;
    this.invalidate();
  }

  takeAnnouncements(): readonly StatusNotificationAnnouncement[] {
    const pending = Object.freeze([...this.announcements]);
    this.announcements.length = 0;
    return pending;
  }

  toPlainText(): string {
    return this.items.map((item) => {
      const presentation = PRESENTATION[item.severity];
      const action = item.action === undefined ? '' : ` — action: ${item.action.label}`;
      return `${new Date(item.timestamp).toISOString()} ${item.order} ${presentation.glyph} [${presentation.word}] ${item.slot}/${item.id}: ${item.message}${action}`;
    }).join('\n');
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const items = this.items;
    return [
      { id: 'summary', role: 'status', text: `Status and notifications — ${items.length} item${items.length === 1 ? '' : 's'}` },
      ...(items.length === 0
        ? [{ id: 'empty', role: 'status' as const, text: 'No active notifications.' }]
        : items.map((item) => ({
            id: `item-${item.order}`,
            role: 'option' as const,
            text: this.renderItem(item),
          }))),
      {
        id: 'help',
        role: 'help',
        text: '↑/↓ navigate · Home/End jump · Enter action · Esc/Ctrl-C cancel',
      },
    ];
  }

  protected onInput(input: WidgetInput): WidgetInputResult<StatusNotificationOutput> {
    const items = this.items;
    if (input.type === 'cancel' || (input.type === 'key' && this.isCancelKey(input.key))) {
      return { status: 'handled', output: { type: 'cancel' } };
    }
    if (items.length === 0) return { status: 'ignored' };

    const selectedIndex = Math.max(0, items.findIndex((item) => item.key === this.selectedKey));
    if (input.type === 'key') {
      const key = input.key.toLowerCase();
      if (key === 'arrowdown' || key === 'j') {
        this.select(items[Math.min(items.length - 1, selectedIndex + 1)]?.key);
        return { status: 'handled' };
      }
      if (key === 'arrowup' || key === 'k') {
        this.select(items[Math.max(0, selectedIndex - 1)]?.key);
        return { status: 'handled' };
      }
      if (key === 'home') {
        this.select(items[0]?.key);
        return { status: 'handled' };
      }
      if (key === 'end') {
        this.select(items.at(-1)?.key);
        return { status: 'handled' };
      }
      if (key !== 'enter') return { status: 'ignored' };
    } else if (input.type !== 'submit') {
      return { status: 'ignored' };
    }

    const selected = items[selectedIndex];
    if (selected?.action === undefined) return { status: 'handled' };
    return {
      status: 'handled',
      output: {
        type: 'action',
        key: selected.key,
        action: selected.action,
      },
    };
  }

  private renderItem(item: StatusNotificationItem): string {
    const presentation = PRESENTATION[item.severity];
    const marker = item.key === this.selectedKey ? '>' : ' ';
    const action = item.action === undefined ? '' : ` · action: ${item.action.label}`;
    return `${marker} ${presentation.glyph} [${presentation.word}] ${item.slot}/${item.id}: ${item.message}${action}`;
  }

  private isCancelKey(key: string): boolean {
    switch (key.toLowerCase()) {
      case 'escape':
      case 'esc':
      case 'ctrl+c':
      case 'ctrl-c':
      case 'c-c':
      case '\u0003':
        return true;
      default:
        return false;
    }
  }

  private select(key: string | undefined): void {
    if (key !== undefined && key !== this.selectedKey) {
      this.selectedKey = key;
      this.invalidate();
    }
  }

  private appendHistory(item: StatusNotificationItem): void {
    this.historyItems.push(item);
    if (this.historyItems.length > this.historyLimit) {
      this.historyItems.splice(0, this.historyItems.length - this.historyLimit);
    }
  }

  private queueAnnouncement(item: StatusNotificationItem): void {
    const presentation = PRESENTATION[item.severity];
    this.announcements.push(Object.freeze({
      key: item.key,
      severity: item.severity,
      role: item.severity === 'warning' || item.severity === 'error' ? 'alert' : 'status',
      liveRegion: item.severity === 'warning' || item.severity === 'error' ? 'assertive' : 'polite',
      text: `${presentation.word}: ${item.message}`,
    }));
    if (this.announcements.length > this.announcementLimit) {
      this.announcements.splice(0, this.announcements.length - this.announcementLimit);
    }
  }

  private evictOldestItems(): void {
    while (this.activeItems.size > this.itemLimit) {
      const oldest = this.items.reduce((candidate, item) => (
        candidate === undefined || item.order < candidate.order ? item : candidate
      ), undefined as StatusNotificationItem | undefined);
      if (oldest === undefined) return;
      this.activeItems.delete(oldest.key);
      if (this.selectedKey === oldest.key) this.selectedKey = undefined;
    }
  }
}
