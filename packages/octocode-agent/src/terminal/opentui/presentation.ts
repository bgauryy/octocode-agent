/**
 * Native interactive terminal adapter. Toolkit-facing shapes are private to this
 * directory so agent-core contracts remain semantic and terminal-neutral.
 */
import type { UiPort, UiInteractionRequest, UiInteractionResult } from '@octocodeai/agent-core';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { FooterConnectionState, FooterSnapshot } from './widgets/footer.js';
import type { HeaderSnapshot } from './widgets/header.js';
import type { PlanWidgetSnapshot } from './widgets/plan.js';
import type { StatusNotificationInput } from './widgets/status-notifications.js';

export type WorkingState = 'idle' | 'active' | 'cancelling' | 'failed';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';
export type PresentationMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type PresentationMessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';
export type PresentationToolStatus = 'pending' | 'running' | 'success' | 'error' | 'blocked' | 'cancelled';

export interface PresentationChromeFacts {
  readonly authority: 'runtime';
  readonly title: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly trust: 'trusted' | 'untrusted' | 'unknown';
  readonly connection: FooterConnectionState;
}

export type PresentationChromeUpdate = Omit<PresentationChromeFacts, 'connection'>;

export const MAX_PRESENTATION_MESSAGES = 200;
export const MAX_PRESENTATION_TOOLS = 100;
export const MAX_PRESENTATION_TURNS = 100;
export const MAX_PRESENTATION_TEXT = 16_000;
export const MAX_PRESENTATION_SECTION = 32_000;

export interface PresentationMessage {
  readonly id: string;
  readonly role: PresentationMessageRole;
  readonly turnId?: string;
  readonly status: PresentationMessageStatus;
  readonly segments: readonly {
    readonly kind: 'text' | 'thinking';
    readonly text: string;
  }[];
}

export interface PresentationToolRow {
  readonly callId: string;
  readonly name: string;
  readonly turnId?: string;
  readonly status: PresentationToolStatus;
  readonly input?: string;
  readonly progress?: {
    readonly message?: string;
    readonly current?: number;
    readonly total?: number;
  };
  readonly result?: string;
  readonly error?: { readonly message: string; readonly category?: string };
}

export interface PresentationTurn {
  readonly id: string;
  readonly status: 'active' | 'completed' | 'cancelled' | 'error';
}

export type PresentationInteractionRequest =
  | { readonly type: 'confirm'; readonly message: string }
  | { readonly type: 'select'; readonly message: string; readonly options: readonly string[] }
  | { readonly type: 'input'; readonly message: string; readonly initial?: string }
  | { readonly type: 'editor'; readonly message: string; readonly initial: string };

export interface PresentationInteraction {
  /** Monotonic identity used to discard stale rendered interaction instances. */
  readonly generation: number;
  readonly request: PresentationInteractionRequest;
  readonly status: 'pending' | 'validation' | 'accepted' | 'cancelled' | 'timeout' | 'unsupported';
  readonly validation?: string;
  readonly value?: string | boolean;
}

/** Runtime-owned semantic widget state. Display strings are deliberately excluded. */
export interface RuntimeWidgetState {
  readonly plan?: PlanWidgetSnapshot;
  readonly statusNotifications?: readonly StatusNotificationInput[];
}

export interface RuntimeWidgetSnapshots {
  /** `null` explicitly clears a previously projected plan; omission preserves it. */
  readonly plan?: PlanWidgetSnapshot | null;
  readonly statusNotifications?: readonly StatusNotificationInput[];
}

export type PresentationWidget =
  | { readonly id: string; readonly kind: 'text'; readonly text: string }
  | { readonly id: string; readonly kind: 'list'; readonly title?: string; readonly items: readonly string[] }
  | { readonly id: string; readonly kind: 'key-value'; readonly title?: string; readonly rows: readonly { readonly label: string; readonly value: string }[] }
  | { readonly id: string; readonly kind: 'progress'; readonly label: string; readonly current: number; readonly total?: number };

export interface PresentationState {
  readonly ready: boolean;
  readonly working: WorkingState;
  readonly chrome?: PresentationChromeFacts;
  readonly activeTurnId?: string;
  readonly turns: readonly PresentationTurn[];
  readonly messages: readonly PresentationMessage[];
  readonly tools: readonly PresentationToolRow[];
  readonly statuses: Readonly<Record<string, string>>;
  readonly notifications: readonly {
    severity: NotificationSeverity;
    message: string;
  }[];
  readonly widgets: Readonly<Record<string, PresentationWidget>>;
  readonly interactionHandler: 'required' | 'ready';
  readonly interaction?: PresentationInteraction;
  readonly runtimeWidgets?: RuntimeWidgetState;
}

export type PresentationEvent =
  | { type: 'runtime-ready' }
  | { type: 'runtime-stopping' }
  | { type: 'runtime-failed' }
  | { type: 'context-cleared' }
  | { type: 'chrome-changed'; chrome: PresentationChromeUpdate }
  | { type: 'turn-started'; turnId: string }
  | { type: 'turn-ended'; turnId: string; outcome: 'completed' | 'cancelled' | 'error' }
  | { type: 'input-received'; text: string; messageId?: string; turnId?: string }
  | { type: 'user-message'; text: string; messageId?: string; turnId?: string }
  | { type: 'message-started'; messageId: string; role: PresentationMessageRole; turnId?: string }
  | { type: 'message-delta'; text: string; messageId?: string; role?: PresentationMessageRole; turnId?: string; segment?: 'text' | 'thinking' }
  | { type: 'message-ended'; messageId: string; status?: PresentationMessageStatus }
  | { type: 'tool-prepared'; callId: string; name: string; turnId?: string; input?: string }
  | { type: 'tool-requested'; callId: string; name: string; turnId?: string; input?: string }
  | { type: 'tool-started'; callId: string; name: string; turnId?: string }
  | { type: 'tool-progress'; callId: string; name?: string; message?: string; current?: number; total?: number }
  | { type: 'tool-updated'; callId: string; name?: string; message?: string; current?: number; total?: number }
  | { type: 'tool-result'; callId: string; name: string; result?: string }
  | { type: 'tool-ended'; callId: string; name: string; result?: string; error?: string; category?: string }
  | { type: 'tool-failed'; callId: string; name: string; message: string; category?: string }
  | { type: 'tool-blocked'; callId: string; name: string; message: string; category?: string }
  | { type: 'tool-cancelled'; callId: string; name: string; message?: string }
  | { type: 'interaction-handler-state'; ready: boolean }
  | { type: 'interaction-requested'; request: PresentationInteractionRequest }
  | { type: 'interaction-validation'; message: string }
  | { type: 'interaction-resolved'; result: { status: 'accepted'; value: string | boolean } | { status: 'cancelled' | 'timeout' | 'unsupported' } }
  | { type: 'runtime-widgets-changed'; snapshots: RuntimeWidgetSnapshots }
  | { type: 'status-changed'; name: string; text?: string }
  | { type: 'notification'; severity: NotificationSeverity; message: string }
  | {
      type: 'presentation-changed';
      property: 'working' | 'widget';
      value: unknown;
    };

/** Private renderer facade; concrete OpenTUI values never leave this module. */
export interface OpenTuiSemanticAnnouncement {
  readonly source: string;
  readonly politeness: 'polite' | 'assertive';
  readonly text: string;
}

export interface OpenTuiRendererFacade {
  render(state: PresentationState): void;
  /** Complete linear terminal output; this is an alternate-output seam, not an ARIA implementation. */
  alternateOutput?(): string;
  /** Drains semantic terminal announcements for tests and alternate-output hosts. */
  drainAnnouncements?(): readonly OpenTuiSemanticAnnouncement[];
  destroy(): void | Promise<void>;
}

export type OpenTuiInputOwnership = 'renderer' | 'external';

export type OpenTuiInputEvent =
  | { readonly type: 'line'; readonly line: string }
  | { readonly type: 'interrupt' };

export interface OpenTuiRendererEvents {
  readonly submitLine: (line: string) => void;
  readonly resolveInteraction: (generation: number, result: UiInteractionResult) => void;
  readonly interrupt: () => void;
  readonly failure?: (error: unknown) => void;
}

export interface OpenTuiTerminalDependencies {
  createRenderer: (events: OpenTuiRendererEvents) => Promise<OpenTuiRendererFacade>;
  readonly inputOwnership?: OpenTuiInputOwnership;
  store?: PresentationStore;
}

export interface OpenTuiTerminal {
  readonly inputOwnership: OpenTuiInputOwnership;
  start(): Promise<void>;
  accept(event: PresentationEvent): void;
  interact?(request: UiInteractionRequest, signal: AbortSignal): Promise<UiInteractionResult>;
  acceptInput?(line: string): boolean;
  subscribeInput?(listener: (event: OpenTuiInputEvent) => void | Promise<void>): () => void;
  /** Fatal renderer or callback errors that require the owning loop to terminate. */
  subscribeFailure?(listener: (error: unknown) => void): () => void;
  cancelInteraction?(): boolean;
  stop(): Promise<void>;
  snapshot(): PresentationState;
}

export function createInitialPresentationState(): PresentationState {
  return {
    ready: false,
    working: 'idle',
    turns: [],
    messages: [],
    tools: [],
    statuses: {},
    notifications: [],
    widgets: {},
    interactionHandler: 'required',
  };
}

export function projectPresentationChrome(
  state: PresentationState,
  viewportWidth: number,
): { readonly header: HeaderSnapshot; readonly footer: FooterSnapshot } | undefined {
  const chrome = state.chrome;
  if (chrome === undefined) return undefined;
  const interactionActive = state.interaction?.status === 'pending' || state.interaction?.status === 'validation';
  const interactionType = interactionActive ? state.interaction?.request.type : undefined;
  const keyHints = interactionType === 'confirm'
    ? [
        { key: 'Enter', label: 'Choose', priority: 1 },
        { key: 'Esc/Ctrl-C', label: 'Cancel', priority: 2 },
        { key: 'Tab', label: 'Move choice', priority: 3 },
      ]
    : interactionType === 'select'
      ? [
          { key: 'Enter', label: 'Choose', priority: 1 },
          { key: 'Esc/Ctrl-C', label: 'Cancel', priority: 2 },
          { key: '↑/↓', label: 'Move choice', priority: 3 },
        ]
      : interactionType === 'input'
      ? [
          { key: 'Enter', label: 'Submit', priority: 1 },
          { key: 'Esc/Ctrl-C', label: 'Cancel', priority: 2 },
        ]
        : interactionType === 'editor'
          ? [
              { key: 'Meta-Enter', label: 'Submit', priority: 1 },
              { key: 'Esc/Ctrl-C', label: 'Cancel', priority: 2 },
            ]
    : state.working === 'active'
      ? [
          { key: 'Enter', label: 'Follow up', priority: 1 },
          { key: 'Esc/Ctrl-C', label: 'Cancel turn', priority: 2 },
          { key: '/steer', label: 'Redirect', priority: 3 },
          { key: 'Tab', label: 'Inspect activity', priority: 4 },
        ]
      : [
          { key: 'Enter', label: 'Send', priority: 1 },
          { key: 'Ctrl-C', label: 'Exit', priority: 2 },
          { key: 'Tab', label: 'Inspect activity', priority: 3 },
          { key: '/', label: 'Commands', priority: 4 },
          { key: '@', label: 'Files', priority: 5 },
        ];
  return {
    header: {
      authority: chrome.authority,
      title: chrome.title,
      ...(chrome.sessionId === undefined ? {} : { sessionId: chrome.sessionId }),
      ...(chrome.modelId === undefined ? {} : { modelId: chrome.modelId }),
      trust: chrome.trust,
      working: state.working,
      width: Math.min(10_000, Math.max(1, viewportWidth)),
    },
    footer: {
      authority: chrome.authority,
      activeMode: interactionActive ? 'respond' : 'chat',
      connection: chrome.connection,
      widthColumns: Math.min(1_000, Math.max(20, viewportWidth)),
      keyHints,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function widgetId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

function optionalTitle(value: unknown): string | undefined | false {
  return value === undefined ? undefined : typeof value === 'string' ? value : false;
}

export function parsePresentationWidget(value: unknown): PresentationWidget | { readonly id: string; readonly remove: true } | undefined {
  if (!isRecord(value)) return undefined;
  const id = widgetId(value.id);
  if (!id) return undefined;
  if (value.remove === true) return { id, remove: true };
  const title = optionalTitle(value.title);
  if (title === false) return undefined;
  switch (value.kind) {
    case 'text':
      return typeof value.text === 'string' ? { id, kind: 'text', text: value.text } : undefined;
    case 'list':
      return Array.isArray(value.items) && value.items.length <= 100 && value.items.every((item) => typeof item === 'string')
        ? { id, kind: 'list', ...(title === undefined ? {} : { title }), items: [...value.items] }
        : undefined;
    case 'key-value': {
      if (!Array.isArray(value.rows) || value.rows.length > 100) return undefined;
      const rows = value.rows.map((row) => isRecord(row) && typeof row.label === 'string' && typeof row.value === 'string'
        ? { label: row.label, value: row.value }
        : undefined);
      return rows.every((row) => row !== undefined)
        ? { id, kind: 'key-value', ...(title === undefined ? {} : { title }), rows: rows as { label: string; value: string }[] }
        : undefined;
    }
    case 'progress': {
      if (typeof value.label !== 'string' || !Number.isFinite(value.current) || (value.current as number) < 0) return undefined;
      if (value.total !== undefined && (!Number.isFinite(value.total) || (value.total as number) <= 0 || (value.current as number) > (value.total as number))) return undefined;
      return { id, kind: 'progress', label: value.label, current: value.current as number, ...(value.total === undefined ? {} : { total: value.total as number }) };
    }
    default:
      return undefined;
  }
}

function boundedText(text: string): string {
  return text.length <= MAX_PRESENTATION_TEXT ? text : text.slice(-MAX_PRESENTATION_TEXT);
}

function replaceMessage(
  state: PresentationState,
  message: PresentationMessage,
): PresentationState {
  const existing = state.messages.findIndex(({ id }) => id === message.id);
  const messages = existing < 0
    ? [...state.messages, message].slice(-MAX_PRESENTATION_MESSAGES)
    : state.messages.map((item, index) => index === existing ? message : item);
  return { ...state, messages };
}

function startMessage(
  state: PresentationState,
  message: Omit<PresentationMessage, 'segments'>,
): PresentationState {
  const existing = state.messages.find(({ id }) => id === message.id);
  return replaceMessage(state, {
    ...message,
    segments: existing?.segments ?? [],
  });
}

function appendMessageSegment(
  state: PresentationState,
  event: Extract<PresentationEvent, { type: 'message-delta' }>,
): PresentationState {
  const messageId = event.messageId
    ?? [...state.messages].reverse().find(({ role, status, turnId }) => role === 'assistant' && status === 'streaming' && turnId === (event.turnId ?? state.activeTurnId))?.id
    ?? `assistant:${event.turnId ?? state.activeTurnId ?? 'unscoped'}`;
  const existing = state.messages.find(({ id }) => id === messageId);
  const kind = event.segment ?? 'text';
  const previousSegments = existing?.segments ?? [];
  const last = previousSegments.at(-1);
  const segments = last?.kind === kind
    ? [...previousSegments.slice(0, -1), { kind, text: boundedText(last.text + event.text) }]
    : [...previousSegments, { kind, text: boundedText(event.text) }];
  return replaceMessage(state, {
    id: messageId,
    role: event.role ?? existing?.role ?? 'assistant',
    ...((event.turnId ?? existing?.turnId ?? state.activeTurnId) === undefined
      ? {}
      : { turnId: event.turnId ?? existing?.turnId ?? state.activeTurnId }),
    status: 'streaming',
    segments,
  });
}

function replaceTool(
  state: PresentationState,
  row: PresentationToolRow,
): PresentationState {
  const existing = state.tools.findIndex(({ callId }) => callId === row.callId);
  const tools = existing < 0
    ? [...state.tools, row].slice(-MAX_PRESENTATION_TOOLS)
    : state.tools.map((item, index) => index === existing ? row : item);
  return { ...state, tools };
}

function updateTool(
  state: PresentationState,
  callId: string,
  name: string | undefined,
  update: Partial<PresentationToolRow>,
): PresentationState {
  const existing = state.tools.find(({ callId: candidate }) => candidate === callId);
  return replaceTool(state, {
    callId,
    name: name ?? existing?.name ?? 'tool',
    ...((existing?.turnId ?? state.activeTurnId) === undefined ? {} : { turnId: existing?.turnId ?? state.activeTurnId }),
    status: existing?.status ?? 'pending',
    ...existing,
    ...update,
  });
}

export function reducePresentation(
  state: PresentationState,
  event: PresentationEvent,
): PresentationState {
  switch (event.type) {
    case 'context-cleared':
      return {
        ...state,
        working: 'idle',
        activeTurnId: undefined,
        statuses: Object.fromEntries(Object.entries(state.statuses).filter(([name]) => name !== 'context.usage')),
        interaction: undefined,
      };
    case 'runtime-ready':
      return {
        ...state,
        ready: true,
        working: 'idle',
        ...(state.chrome === undefined ? {} : { chrome: { ...state.chrome, connection: 'connected' as const } }),
      };
    case 'runtime-stopping':
      return {
        ...state,
        working: 'cancelling',
        ...(state.chrome === undefined ? {} : { chrome: { ...state.chrome, connection: 'connecting' as const } }),
      };
    case 'runtime-failed':
      return {
        ...state,
        working: 'failed',
        ...(state.chrome === undefined ? {} : { chrome: { ...state.chrome, connection: 'error' as const } }),
      };
    case 'chrome-changed':
      return {
        ...state,
        chrome: {
          ...event.chrome,
          connection: state.chrome?.connection
            ?? (state.working === 'failed' ? 'error' : state.ready ? 'connected' : 'connecting'),
        },
      };
    case 'turn-started': {
      const turns = [
        ...state.turns.filter(({ id }) => id !== event.turnId),
        { id: event.turnId, status: 'active' as const },
      ].slice(-MAX_PRESENTATION_TURNS);
      let pendingUserIndex = -1;
      for (let index = state.messages.length - 1; index >= 0; index -= 1) {
        const message = state.messages[index];
        if (message?.role === 'user' && message.turnId === undefined) {
          pendingUserIndex = index;
          break;
        }
      }
      const messages = pendingUserIndex < 0
        ? state.messages
        : state.messages.map((message, index) => index === pendingUserIndex ? { ...message, turnId: event.turnId } : message);
      return { ...state, activeTurnId: event.turnId, turns, messages, working: 'active' };
    }
    case 'turn-ended': {
      const turns = state.turns.some(({ id }) => id === event.turnId)
        ? state.turns.map((turn) => turn.id === event.turnId ? { ...turn, status: event.outcome } : turn)
        : [...state.turns, { id: event.turnId, status: event.outcome }].slice(-MAX_PRESENTATION_TURNS);
      return {
        ...state,
        activeTurnId: state.activeTurnId === event.turnId ? undefined : state.activeTurnId,
        turns,
        working: state.working === 'failed' ? 'failed' : 'idle',
      };
    }
    case 'input-received':
    case 'user-message': {
      const turnId = event.turnId ?? state.activeTurnId;
      return replaceMessage(state, {
        id: event.messageId ?? `user:${turnId ?? state.messages.length + 1}`,
        role: 'user',
        ...(turnId === undefined ? {} : { turnId }),
        status: 'complete',
        segments: [{ kind: 'text', text: boundedText(event.text) }],
      });
    }
    case 'message-started':
      return startMessage(state, {
        id: event.messageId,
        role: event.role,
        ...((event.turnId ?? state.activeTurnId) === undefined ? {} : { turnId: event.turnId ?? state.activeTurnId }),
        status: 'streaming',
      });
    case 'message-delta':
      return appendMessageSegment(state, event);
    case 'message-ended': {
      const message = state.messages.find(({ id }) => id === event.messageId);
      return message === undefined ? state : replaceMessage(state, {
        ...message,
        status: event.status ?? 'complete',
      });
    }
    case 'tool-prepared':
    case 'tool-requested':
      return replaceTool(state, {
        callId: event.callId,
        name: event.name,
        ...((event.turnId ?? state.activeTurnId) === undefined ? {} : { turnId: event.turnId ?? state.activeTurnId }),
        status: 'pending',
        ...(event.input === undefined ? {} : { input: boundedText(event.input) }),
      });
    case 'tool-started':
      return updateTool(state, event.callId, event.name, { status: 'running' });
    case 'tool-progress':
    case 'tool-updated':
      return updateTool(state, event.callId, event.name, {
        status: 'running',
        progress: {
          ...(event.message === undefined ? {} : { message: boundedText(event.message) }),
          ...(Number.isFinite(event.current) ? { current: event.current } : {}),
          ...(Number.isFinite(event.total) ? { total: event.total } : {}),
        },
      });
    case 'tool-result':
      return updateTool(state, event.callId, event.name, {
        status: 'success',
        ...(event.result === undefined ? {} : { result: boundedText(event.result) }),
      });
    case 'tool-ended':
      if (state.tools.find(({ callId }) => callId === event.callId)?.status === 'blocked') return state;
      return event.error === undefined
        ? updateTool(state, event.callId, event.name, {
          status: 'success',
          ...(event.result === undefined ? {} : { result: boundedText(event.result) }),
        })
        : updateTool(state, event.callId, event.name, {
          status: 'error',
          error: { message: boundedText(event.error), ...(event.category === undefined ? {} : { category: event.category }) },
        });
    case 'tool-failed':
      return updateTool(state, event.callId, event.name, {
        status: 'error',
        error: { message: boundedText(event.message), ...(event.category === undefined ? {} : { category: event.category }) },
      });
    case 'tool-blocked':
      return updateTool(state, event.callId, event.name, {
        status: 'blocked',
        error: { message: boundedText(event.message), ...(event.category === undefined ? {} : { category: event.category }) },
      });
    case 'tool-cancelled':
      return updateTool(state, event.callId, event.name, {
        status: 'cancelled',
        ...(event.message === undefined ? {} : { error: { message: boundedText(event.message) } }),
      });
    case 'interaction-handler-state': {
      const interactionHandler = event.ready ? 'ready' : 'required';
      return state.interactionHandler === interactionHandler ? state : { ...state, interactionHandler };
    }
    case 'interaction-requested':
      return {
        ...state,
        interaction: {
          generation: (state.interaction?.generation ?? 0) + 1,
          request: event.request.type === 'select'
            ? { ...event.request, options: [...event.request.options] }
            : { ...event.request },
          status: 'pending',
        },
      };
    case 'interaction-validation':
      return state.interaction === undefined ? state : {
        ...state,
        interaction: { ...state.interaction, status: 'validation', validation: event.message },
      };
    case 'interaction-resolved':
      return state.interaction === undefined ? state : {
        ...state,
        interaction: {
          generation: state.interaction.generation,
          request: state.interaction.request,
          status: event.result.status,
          ...(event.result.status === 'accepted' ? { value: event.result.value } : {}),
        },
      };
    case 'runtime-widgets-changed':
      {
        const runtimeWidgets: { plan?: PlanWidgetSnapshot; statusNotifications?: readonly StatusNotificationInput[] } = {
          ...state.runtimeWidgets,
        };
        if (event.snapshots.plan === null) delete runtimeWidgets.plan;
        else if (event.snapshots.plan !== undefined) runtimeWidgets.plan = event.snapshots.plan;
        if (event.snapshots.statusNotifications !== undefined) {
          runtimeWidgets.statusNotifications = [...event.snapshots.statusNotifications];
        }
        return { ...state, runtimeWidgets };
      }
    case 'notification':
      return {
        ...state,
        notifications: [
          ...state.notifications,
          { severity: event.severity, message: event.message },
        ].slice(-50),
      };
    case 'status-changed': {
      const statuses = { ...state.statuses };
      if (event.text == null) delete statuses[event.name];
      else statuses[event.name] = event.text;
      return { ...state, statuses };
    }
    case 'presentation-changed': {
      if (event.property === 'working') {
        const working = event.value;
        return working === 'idle' || working === 'active' || working === 'cancelling' || working === 'failed'
          ? { ...state, working }
          : state;
      }
      const widget = parsePresentationWidget(event.value);
      if (!widget) return state;
      const widgets = { ...state.widgets };
      if ('remove' in widget) delete widgets[widget.id];
      else widgets[widget.id] = widget;
      return { ...state, widgets };
    }
  }
}

function formatWidget(widget: PresentationWidget): string {
  switch (widget.kind) {
    case 'text': return widget.text;
    case 'list': return [widget.title, ...widget.items.map((item) => `- ${item}`)].filter((item): item is string => item !== undefined).join('\n');
    case 'key-value': return [widget.title, ...widget.rows.map((row) => `${row.label}: ${row.value}`)].filter((item): item is string => item !== undefined).join('\n');
    case 'progress': return `${widget.label}: ${widget.current}${widget.total === undefined ? '' : `/${widget.total}`}`;
  }
}

function boundedSection(parts: readonly string[]): string {
  const text = parts.filter(Boolean).join('\n');
  return text.length <= MAX_PRESENTATION_SECTION ? text : text.slice(-MAX_PRESENTATION_SECTION);
}

function formatMessage(message: PresentationMessage): string {
  const role = message.role === 'user'
    ? 'You'
    : message.role[0]!.toUpperCase() + message.role.slice(1);
  const content = message.segments.map((segment) => segment.kind === 'thinking' ? `[thinking] ${segment.text}` : segment.text);
  return [role, ...content, message.status === 'complete' ? '' : `[${message.status}]`].filter(Boolean).join('\n');
}

function formatMessages(state: PresentationState): string {
  let previousTurnId: string | undefined;
  const parts: string[] = [];
  for (const message of state.messages) {
    if (message.turnId !== undefined && message.turnId !== previousTurnId) {
      const turn = state.turns.find(({ id }) => id === message.turnId);
      parts.push(`Turn ${message.turnId}${turn === undefined ? '' : ` · ${turn.status}`}`);
      previousTurnId = message.turnId;
    }
    parts.push(formatMessage(message));
  }
  return boundedSection(parts);
}

function formatTool(row: PresentationToolRow): string {
  const progress = row.progress === undefined
    ? ''
    : [
      row.progress.message,
      row.progress.current === undefined
        ? undefined
        : `${row.progress.current}${row.progress.total === undefined ? '' : `/${row.progress.total}`}`,
    ].filter((part): part is string => part !== undefined).join(' · ');
  return [
    `${row.name} · ${row.status}`,
    row.input === undefined ? '' : `input: ${row.input}`,
    progress === '' ? '' : `progress: ${progress}`,
    row.result === undefined ? '' : `result: ${row.result}`,
    row.error === undefined ? '' : `${row.error.category === undefined ? 'error' : row.error.category}: ${row.error.message}`,
  ].filter(Boolean).join('\n');
}

function formatInteraction(interaction: PresentationInteraction | undefined): string {
  if (interaction === undefined) return '';
  const request = interaction.request;
  const prompt = request.type === 'editor' ? 'Editor input' : request.message;
  const options = request.type === 'select'
    ? request.options.map((option, index) => `${index + 1}. ${option}`)
    : request.type === 'confirm'
      ? ['yes / no']
      : [];
  return [
    prompt,
    ...options,
    interaction.validation ?? '',
    interaction.status === 'pending' || interaction.status === 'validation' ? `[${interaction.status}]` : `[${interaction.status}]`,
  ].filter(Boolean).join('\n');
}

export interface PresentationSections {
  readonly header: string;
  readonly messages: string;
  readonly tools: string;
  readonly sidebar: string;
  readonly editor: string;
  readonly footer: string;
}

export function formatPresentationSections(state: PresentationState): PresentationSections {
  return {
    header: boundedSection([
      'Octocode',
      state.ready ? `ready · ${state.working}` : `starting · ${state.working}`,
      `interactions · ${state.interactionHandler}`,
    ]),
    messages: formatMessages(state),
    tools: boundedSection(state.tools.map(formatTool)),
    sidebar: boundedSection([
      formatInteraction(state.interaction),
      ...Object.values(state.widgets).map(formatWidget),
      ...Object.entries(state.statuses).map(([name, value]) => `${name}: ${value}`),
      ...state.notifications.map((item) => `[${item.severity}] ${item.message}`),
    ]),
    editor: '',
    footer: '',
  };
}

export function formatPresentationFrame(state: PresentationState): string {
  return boundedSection(Object.values(formatPresentationSections(state)));
}

export interface PresentationStoreState {
  readonly presentation: PresentationState;
  readonly accept: (event: PresentationEvent) => void;
}

export type PresentationStore = StoreApi<PresentationStoreState>;

export function createPresentationStore(initial = createInitialPresentationState()): PresentationStore {
  return createStore<PresentationStoreState>()((set) => ({
    presentation: initial,
    accept: (event) => set((state) => {
      const presentation = reducePresentation(state.presentation, event);
      return presentation === state.presentation ? state : { presentation };
    }),
  }));
}

export type OpenTuiInteractionHandler = (
  request: UiInteractionRequest,
  signal: AbortSignal,
) => Promise<UiInteractionResult>;

/** Map the canonical semantic UI port onto the native terminal projection. */
export function createOpenTuiUiPort(
  terminal: OpenTuiTerminal,
  interact?: OpenTuiInteractionHandler,
): UiPort {
  const handler = interact ?? terminal.interact?.bind(terminal) ?? (async () => ({ status: 'unsupported' as const }));
  terminal.accept({ type: 'interaction-handler-state', ready: interact !== undefined || terminal.interact !== undefined });
  return {
    interact: handler,
    async notify(message, severity) {
      terminal.accept({ type: 'notification', message, severity });
    },
    async setStatus(slot, text) {
      terminal.accept({ type: 'status-changed', name: slot, text });
    },
    async present(command) {
      terminal.accept({
        type: 'presentation-changed',
        property: command.type,
        value: command.value,
      });
    },
  };
}
