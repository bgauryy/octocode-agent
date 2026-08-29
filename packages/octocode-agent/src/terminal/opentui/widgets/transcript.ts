import { OpenTuiWidget } from './base.js';
import {
  MAX_WIDGET_TEXT_LENGTH,
  WidgetContractError,
  type WidgetAgentInstructions,
  type WidgetInput,
  type WidgetInputResult,
  type WidgetRenderAdapter,
  type WidgetRenderRegion,
  type WidgetRenderState,
} from './contracts.js';
import { assertStableTerminalId, sanitizeMultilineText, segmentGraphemes } from './sanitize.js';

export const MAX_TRANSCRIPT_GRAPHEMES = 4_096;
export const MAX_TRANSCRIPT_SEGMENTS_PER_MESSAGE = 128;
export const MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH = MAX_WIDGET_TEXT_LENGTH;
const MAX_TRANSCRIPT_MESSAGES = 200;
const MESSAGE_ROLES = new Set<TranscriptMessageRole>(['system', 'user', 'assistant', 'tool']);
const MESSAGE_STATUSES = new Set<TranscriptMessageStatus>(['streaming', 'complete', 'cancelled', 'error']);
const SEGMENT_KINDS = new Set<TranscriptMessage['segments'][number]['kind']>(['text', 'thinking']);

export type TranscriptMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type TranscriptMessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';

export interface TranscriptMessage {
  readonly id: string;
  readonly turnId?: string;
  readonly role: TranscriptMessageRole;
  readonly status: TranscriptMessageStatus;
  readonly segments: readonly {
    readonly kind: 'text' | 'thinking';
    readonly text: string;
  }[];
}

export interface TranscriptAnnouncement {
  readonly id: string;
  readonly politeness: 'polite' | 'assertive';
  readonly text: string;
}

export type TranscriptWidgetAction = {
  readonly type: 'scroll';
  readonly direction: 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'start' | 'end';
};

const TRANSCRIPT_INSTRUCTIONS: WidgetAgentInstructions = {
  purpose: 'Render the bounded, safe conversation transcript and its message activity.',
  useWhen: [
    'Showing user, assistant, system, and tool messages in chronological order.',
    'Reporting whether the active assistant message is still thinking or streaming text.',
  ],
  avoidWhen: [
    'Showing tool execution details that belong in the tool-progress widget.',
    'Collecting input or presenting a choice that requires an interactive input widget.',
  ],
  inputs: [
    'Pass immutable messages with stable message IDs and stable turn IDs when available.',
    'Mark every segment as text or thinking and every message with its terminal or streaming status.',
  ],
  stateAndOutput: [
    'Only text segments are rendered; thinking content is never exposed.',
    'alternateOutput() returns deterministic role-prefixed plain text with stable message and turn IDs.',
    'drainAnnouncements() returns deduplicated streaming updates and immediate terminal outcomes.',
  ],
  keys: [
    'Up/Down scroll one line; PageUp/PageDown scroll one viewport.',
    'Home moves to the first message; End moves to the newest message.',
  ],
  accessibility: [
    'Expose this focusable scroll region as a Conversation log with polite live updates.',
    'Preserve role prefixes and status words so meaning never depends on color or position.',
    'Offer alternate output for screen readers, redirected output, and non-interactive terminals.',
  ],
  recovery: [
    'Reject duplicate or unstable message identifiers instead of merging ambiguous records.',
    'Redact recognizable credentials, strip terminal control sequences, and bound output at grapheme boundaries.',
  ],
};

function roleLabel(role: TranscriptMessageRole): string { return role; }

function announcementRole(role: TranscriptMessageRole): string {
  return role === 'assistant' ? 'Assistant'
    : role === 'user' ? 'User'
      : role === 'tool' ? 'Tool'
        : 'System';
}

function boundedPlainText(value: string): string {
  const safe = sanitizeMultilineText(value, {
    maxGraphemes: MAX_TRANSCRIPT_GRAPHEMES,
    redactCredentials: true,
  });
  const parts = segmentGraphemes(safe);
  if (parts.length <= MAX_TRANSCRIPT_GRAPHEMES && safe.length <= MAX_WIDGET_TEXT_LENGTH) return safe;
  const kept: string[] = [];
  let codeUnits = 1;
  for (const part of parts) {
    if (kept.length >= MAX_TRANSCRIPT_GRAPHEMES - 1
      || codeUnits + part.length > MAX_WIDGET_TEXT_LENGTH) break;
    kept.push(part);
    codeUnits += part.length;
  }
  return `${kept.join('')}…`;
}

function validateStableId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new WidgetContractError('validation', `${field} is invalid`);
  }
  try {
    return assertStableTerminalId(value, { maxLength: 128 });
  } catch {
    throw new WidgetContractError('validation', `${field} is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateMessages(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  if (!Array.isArray(messages) || messages.length > MAX_TRANSCRIPT_MESSAGES) {
    throw new WidgetContractError('validation', 'transcript messages exceed their item bound');
  }
  const ids = new Set<string>();
  return Object.freeze(messages.map((candidate: unknown) => {
    if (!isRecord(candidate)) {
      throw new WidgetContractError('validation', 'transcript message must be an object');
    }
    const id = validateStableId(candidate.id, 'transcript message id');
    const turnId = candidate.turnId === undefined
      ? undefined
      : validateStableId(candidate.turnId, 'transcript turn id');
    if (typeof candidate.role !== 'string' || !MESSAGE_ROLES.has(candidate.role as TranscriptMessageRole)) {
      throw new WidgetContractError('validation', 'transcript message role is invalid');
    }
    if (typeof candidate.status !== 'string' || !MESSAGE_STATUSES.has(candidate.status as TranscriptMessageStatus)) {
      throw new WidgetContractError('validation', 'transcript message status is invalid');
    }
    if (!Array.isArray(candidate.segments)
      || candidate.segments.length > MAX_TRANSCRIPT_SEGMENTS_PER_MESSAGE) {
      throw new WidgetContractError('validation', 'transcript message segments exceed their item bound');
    }
    if (ids.has(id)) {
      throw new WidgetContractError('validation', `transcript message id '${id}' is duplicated`);
    }
    ids.add(id);
    const segments = candidate.segments.map((segment: unknown) => {
      if (!isRecord(segment)
        || typeof segment.kind !== 'string'
        || !SEGMENT_KINDS.has(segment.kind as TranscriptMessage['segments'][number]['kind'])) {
        throw new WidgetContractError('validation', 'transcript segment kind is invalid');
      }
      if (typeof segment.text !== 'string') {
        throw new WidgetContractError('validation', 'transcript segment text must be a string');
      }
      if (segment.text.length > MAX_TRANSCRIPT_SEGMENT_TEXT_LENGTH) {
        throw new WidgetContractError('validation', 'transcript segment text exceeds its length bound');
      }
      return Object.freeze({
        kind: segment.kind as TranscriptMessage['segments'][number]['kind'],
        text: segment.text,
      });
    });
    return Object.freeze({
      id,
      ...(turnId === undefined ? {} : { turnId }),
      role: candidate.role as TranscriptMessageRole,
      status: candidate.status as TranscriptMessageStatus,
      segments: Object.freeze(segments),
    });
  }));
}

function visibleText(message: TranscriptMessage): string {
  return message.segments
    .filter(({ kind }) => kind === 'text')
    .map(({ text }) => text)
    .join('');
}

function hasThinking(message: TranscriptMessage): boolean {
  return message.segments.some(({ kind }) => kind === 'thinking');
}

function contentLine(message: TranscriptMessage): string {
  return `${roleLabel(message.role)}: ${visibleText(message)}`;
}

function alternateLine(message: TranscriptMessage): string {
  const turn = message.turnId === undefined ? 'unscoped' : message.turnId;
  const thoughtStatus = hasThinking(message) ? ' [thinking]' : '';
  return `[turn=${turn} message=${message.id} status=${message.status}] ${contentLine(message)}${thoughtStatus}`;
}

export class TranscriptWidget extends OpenTuiWidget<TranscriptWidgetAction> {
  private messages: readonly TranscriptMessage[];
  private readonly announced = new Set<string>();
  private pendingAnnouncements: TranscriptAnnouncement[] = [];

  constructor(id: string, messages: readonly TranscriptMessage[] = []) {
    super({
      id,
      kind: 'transcript',
      capabilities: { focusable: true, inputMode: 'keys' },
      accessibility: {
        role: 'log',
        label: 'Conversation',
        description: 'Scrollable chronological messages with role and status labels.',
        liveRegion: 'polite',
        keyboardHelp: [
          'Up and Down scroll one line.',
          'PageUp and PageDown scroll one page.',
          'Home and End move to the beginning and end.',
        ],
      },
      instructions: TRANSCRIPT_INSTRUCTIONS,
    });
    this.messages = validateMessages(messages);
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  update(messages: readonly TranscriptMessage[]): void {
    const next = validateMessages(messages);
    for (const message of next) {
      const announcement = this.createAnnouncement(message);
      if (announcement !== undefined && !this.announced.has(announcement.id)) {
        this.announced.add(announcement.id);
        this.pendingAnnouncements.push(announcement);
      }
    }
    this.messages = next;
    this.invalidate();
  }

  drainAnnouncements(): readonly TranscriptAnnouncement[] {
    const announcements = Object.freeze([...this.pendingAnnouncements]);
    this.pendingAnnouncements = [];
    return announcements;
  }

  alternateOutput(): string {
    return boundedPlainText(this.messages.map(alternateLine).join('\n'));
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const activity = this.messages
      .filter((message) => message.status === 'streaming' && hasThinking(message))
      .map((message) => `${roleLabel(message.role)}: Thinking…`)
      .join('\n');
    return [
      { id: 'messages', role: 'content', text: boundedPlainText(this.messages.map(contentLine).join('\n')) },
      ...(activity.length === 0 ? [] : [{ id: 'activity', role: 'status' as const, text: boundedPlainText(activity) }]),
    ];
  }

  protected onInput(input: WidgetInput): WidgetInputResult<TranscriptWidgetAction> {
    if (input.type !== 'key') return { status: 'ignored' };
    const direction: Record<string, TranscriptWidgetAction['direction']> = {
      up: 'line-up',
      down: 'line-down',
      pageup: 'page-up',
      pagedown: 'page-down',
      home: 'start',
      end: 'end',
    };
    const action = direction[input.key.toLowerCase()];
    return action === undefined
      ? { status: 'ignored' }
      : { status: 'handled', output: { type: 'scroll', direction: action } };
  }

  private createAnnouncement(message: TranscriptMessage): TranscriptAnnouncement | undefined {
    const name = announcementRole(message.role);
    switch (message.status) {
      case 'streaming':
        return {
          id: `${message.id}:streaming`,
          politeness: 'polite',
          text: `${name} response is updating.`,
        };
      case 'complete':
        return {
          id: `${message.id}:complete`,
          politeness: 'polite',
          text: `${name} message completed.`,
        };
      case 'error':
        return {
          id: `${message.id}:error`,
          politeness: 'assertive',
          text: `${name} message failed.`,
        };
      case 'cancelled':
        return {
          id: `${message.id}:cancelled`,
          politeness: 'assertive',
          text: `${name} message was cancelled.`,
        };
    }
  }
}
