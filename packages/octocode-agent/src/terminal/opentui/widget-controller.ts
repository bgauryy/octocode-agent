import type { UiInteractionResult } from '@octocodeai/agent-core';

import type {
  NotificationSeverity,
  PresentationInteraction,
  PresentationState,
  PresentationToolRow,
  PresentationWidget,
} from './presentation.js';
import { ConfirmWidget } from './widgets/confirm.js';
import type { WidgetContract, WidgetInputResult, WidgetRenderAdapter } from './widgets/contracts.js';
import { EditorWidget } from './widgets/editor.js';
import { FooterWidget } from './widgets/footer.js';
import { HeaderWidget } from './widgets/header.js';
import { PlanWidget } from './widgets/plan.js';
import { PresentationSurfaceWidget, type PresentationSurfacePayload } from './widgets/presentation-surface.js';
import { PromptInputWidget } from './widgets/prompt-input.js';
import { SelectWidget } from './widgets/select.js';
import { StatusNotificationsWidget } from './widgets/status-notifications.js';
import { ToolProgressWidget, type ToolOutcomeClassification, type ToolProgressSnapshot } from './widgets/tool-progress.js';
import { TranscriptWidget } from './widgets/transcript.js';
import type {
  StatusNotificationAction,
  StatusNotificationInput,
  StatusNotificationOutput,
} from './widgets/status-notifications.js';
import { sanitizeSingleLineText } from './widgets/sanitize.js';
import { WidgetHost } from './widget-host.js';

export interface WidgetViewport {
  readonly widthColumns: number;
  readonly heightRows: number;
  readonly reducedMotion?: boolean;
  readonly alternateOutput?: boolean;
}

export type NativeInteractionEvent =
  | { readonly type: 'input-change'; readonly value: string; readonly cursor?: number }
  | { readonly type: 'input-submit'; readonly value: string; readonly cursor?: number }
  | { readonly type: 'editor-change'; readonly value: string; readonly cursor?: number }
  | { readonly type: 'editor-submit'; readonly value: string; readonly cursor?: number }
  | { readonly type: 'select-highlight'; readonly optionId: string }
  | { readonly type: 'select-submit'; readonly optionId: string }
  | { readonly type: 'confirm-highlight'; readonly index: number }
  | { readonly type: 'confirm-submit'; readonly index: number }
  | { readonly type: 'key'; readonly key: string };

interface InteractionAwareAdapter extends WidgetRenderAdapter {
  bindInteraction?(generation: number | undefined, widget: WidgetContract | undefined): void;
  focusWidget?(widgetId: string | undefined): void;
  navigateWidget?(widgetId: string, key: string, absoluteOffset?: number): void;
}

export interface SemanticWidgetAnnouncement {
  readonly source: string;
  readonly politeness: 'polite' | 'assertive';
  readonly text: string;
}

export interface StatusNotificationActionInvocation {
  readonly key: string;
  readonly action: StatusNotificationAction;
}

interface SurfaceProjection {
  readonly widget: PresentationSurfaceWidget;
  signature: string;
  revision: number;
}

export interface SemanticWidgetControllerOptions {
  readonly resolveInteraction?: (generation: number, result: UiInteractionResult) => void;
  /** Runtime-owned sink. Without it, action descriptors are removed before projection. */
  readonly statusAction?: (invocation: StatusNotificationActionInvocation) => void | Promise<void>;
  readonly callbackFailure?: (error: unknown) => void;
  /** Injectable clock for deterministic, monotonic tool progress throttling. */
  readonly nowMs?: () => number;
  /** Test/embedding seam for richer validated prompts not yet represented by UiInteractionRequest. */
  readonly interactionWidgetFactory?: (interaction: PresentationInteraction) => WidgetContract;
}

const DEFAULT_VIEWPORT: WidgetViewport = Object.freeze({
  widthColumns: 80,
  heightRows: 24,
  reducedMotion: false,
  alternateOutput: false,
});

function toolClassification(row: PresentationToolRow): ToolOutcomeClassification {
  const category = row.error?.category?.toLowerCase();
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'blocked') return category === 'permission' ? 'permission' : 'policy';
  if (category === 'validation') return 'validation';
  if (category === 'timeout') return 'timeout';
  return row.status === 'success' ? 'result' : 'system';
}

function validProgress(row: PresentationToolRow): Pick<ToolProgressSnapshot, 'current' | 'total'> {
  const current = row.progress?.current;
  const total = row.progress?.total;
  return Number.isSafeInteger(current) && Number.isSafeInteger(total) && current! >= 0 && total! > 0 && current! <= total!
    ? { current, total }
    : {};
}

function parsedRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toolPresentation(row: PresentationToolRow): { readonly label?: string; readonly input?: string; readonly result?: string } {
  const input = parsedRecord(row.input);
  const result = parsedRecord(row.result);
  if (row.name === 'skill') {
    const action = input?.action;
    const skillName = typeof input?.name === 'string' ? input.name : undefined;
    const skills = Array.isArray(result?.skills) ? result.skills.length : undefined;
    return {
      label: 'Agent Skill',
      input: action === 'load' && skillName ? `Load ${skillName}` : action === 'list' ? 'List discovered skills' : row.input,
      result: skills === undefined ? row.result : `${skills} skills discovered`,
    };
  }
  if (row.name === 'plan') return { label: 'Plan and Tasks', input: row.input, result: row.result };
  if (row.name === 'askUser') return { label: 'Question', input: row.input, result: row.result };
  if (row.name === 'MCPTool') return { label: 'MCP', input: row.input, result: row.result };
  return { input: row.input, result: row.result };
}

function toolSnapshot(row: PresentationToolRow, reducedMotion: boolean): ToolProgressSnapshot {
  const presentation = toolPresentation(row);
  const summary = row.error?.message ?? presentation.result;
  return {
    authority: 'runtime',
    callId: row.callId,
    toolName: row.name,
    ...(presentation.label === undefined ? {} : { label: presentation.label }),
    status: row.status,
    ...(presentation.input === undefined ? {} : { inputSummary: presentation.input }),
    ...(row.progress?.message === undefined ? {} : { message: row.progress.message }),
    ...validProgress(row),
    ...(summary === undefined
      ? {}
      : { outcome: { authority: 'runtime', classification: toolClassification(row), summary } }),
    reducedMotion,
  };
}

function notificationLifecycle(severity: NotificationSeverity): StatusNotificationInput['lifecycle'] {
  switch (severity) {
    case 'info': return 'active';
    case 'success': return 'success';
    case 'warning': return 'warning';
    case 'error': return 'error';
  }
}

function surfacePayload(widget: PresentationWidget): PresentationSurfacePayload {
  switch (widget.kind) {
    case 'text': return { kind: 'text', text: widget.text };
    case 'list': return { kind: 'list', ...(widget.title === undefined ? {} : { title: widget.title }), items: [...widget.items] };
    case 'key-value': return {
      kind: 'key-value',
      ...(widget.title === undefined ? {} : { title: widget.title }),
      rows: widget.rows.map((row) => ({ ...row })),
    };
    case 'progress': return {
      kind: 'progress',
      label: widget.label,
      current: widget.current,
      ...(widget.total === undefined ? {} : { total: widget.total }),
    };
  }
}

type NavigableWidget = TranscriptWidget
  | ToolProgressWidget
  | PlanWidget
  | StatusNotificationsWidget
  | PresentationSurfaceWidget;

function isNavigableWidget(widget: WidgetContract): widget is NavigableWidget {
  return widget instanceof TranscriptWidget
    || widget instanceof ToolProgressWidget
    || widget instanceof PlanWidget
    || widget instanceof StatusNotificationsWidget
    || widget instanceof PresentationSurfaceWidget;
}

function interactionWidget(interaction: PresentationInteraction): WidgetContract {
  const id = `interaction-${interaction.generation}`;
  switch (interaction.request.type) {
    case 'confirm':
      return new ConfirmWidget({
        id,
        authority: 'runtime',
        question: interaction.request.message,
        consequence: 'Choosing Yes authorizes the requested action; No or cancel authorizes nothing.',
        risk: 'consequential',
      });
    case 'select':
      return new SelectWidget({
        id,
        label: interaction.request.message,
        consequential: true,
        options: interaction.request.options.map((label, index) => ({ id: `choice-${index + 1}`, label })),
      });
    case 'input':
      return new PromptInputWidget({
        id,
        question: interaction.request.message,
        ...(interaction.request.initial === undefined ? {} : { initialValue: interaction.request.initial }),
      });
    case 'editor':
      return new EditorWidget({ id, label: 'Multiline response', initialValue: interaction.request.initial });
  }
}

/**
 * Application-owned projection from canonical presentation state into semantic widget classes.
 * OpenTUI renderables are deliberately confined to the adapter.
 */
export class SemanticWidgetController {
  private readonly adapter: InteractionAwareAdapter;
  private readonly resolveInteraction?: (generation: number, result: UiInteractionResult) => void;
  private readonly statusAction?: (invocation: StatusNotificationActionInvocation) => void | Promise<void>;
  private readonly callbackFailure?: (error: unknown) => void;
  private readonly nowMs: () => number;
  private readonly interactionWidgetFactory: (interaction: PresentationInteraction) => WidgetContract;
  private readonly host: WidgetHost<NavigableWidget>;
  private viewport: WidgetViewport;
  private transcript?: TranscriptWidget;
  private readonly tools = new Map<string, ToolProgressWidget>();
  private readonly toolWidgetIds = new Map<string, string>();
  private nextToolWidgetId = 1;
  private header?: HeaderWidget;
  private footer?: FooterWidget;
  private plan?: PlanWidget;
  private statuses?: StatusNotificationsWidget;
  private readonly surfaces = new Map<string, SurfaceProjection>();
  private nextSurfaceWidgetId = 1;
  private runtimeHeaderSnapshot?: NonNullable<PresentationState['runtimeWidgets']>['header'];
  private runtimeFooterSnapshot?: NonNullable<PresentationState['runtimeWidgets']>['footer'];
  private interaction?: WidgetContract;
  private interactionGeneration?: number;
  private currentInteractionRequest?: PresentationInteraction['request'];
  private readonly derivedStatusIds = new Map<string, string>();
  private nextDerivedStatusId = 1;
  private readonly interactionAnnouncements: SemanticWidgetAnnouncement[] = [];
  private readonly interactionAnnouncementSignatures = new Set<string>();
  private readonly interactionAnnouncementSignatureOrder: string[] = [];
  private lastClockMs = 0;

  private static readonly INTERACTION_ANNOUNCEMENT_LIMIT = 32;
  private static readonly INTERACTION_DEDUPE_LIMIT = 64;

  constructor(
    adapter: WidgetRenderAdapter,
    viewport: WidgetViewport = DEFAULT_VIEWPORT,
    options: SemanticWidgetControllerOptions = {},
  ) {
    this.adapter = adapter;
    this.host = new WidgetHost(adapter, isNavigableWidget);
    this.viewport = this.normalizeViewport(viewport);
    this.resolveInteraction = options.resolveInteraction;
    this.statusAction = options.statusAction;
    this.callbackFailure = options.callbackFailure;
    this.nowMs = options.nowMs ?? Date.now;
    this.interactionWidgetFactory = options.interactionWidgetFactory ?? interactionWidget;
  }

  render(state: PresentationState): void {
    this.renderTranscript(state);
    this.renderTools(state);
    this.renderRuntimeSnapshots(state);
    this.renderPresentationSurfaces(state);
    this.renderStatuses(state);
    this.renderInteraction(state.interaction);
  }

  resize(viewport: WidgetViewport): void {
    this.viewport = this.normalizeViewport(viewport);
    this.transcript?.render(this.adapter);
    if (this.header && this.runtimeHeaderSnapshot) {
      this.header.update({ ...this.runtimeHeaderSnapshot, width: this.viewport.widthColumns });
      this.header.render(this.adapter);
    }
    if (this.footer && this.runtimeFooterSnapshot) {
      this.footer.update({
        ...this.runtimeFooterSnapshot,
        widthColumns: Math.min(1_000, Math.max(20, this.viewport.widthColumns)),
      });
      this.footer.render(this.adapter);
    }
    this.plan?.resize(Math.min(1_000, Math.max(20, this.viewport.widthColumns)), Math.max(1, Math.min(61, this.viewport.heightRows - 8)));
    for (const { widget } of this.surfaces.values()) {
      const surfaceWidth = this.viewport.widthColumns < 72
        ? this.viewport.widthColumns
        : Math.floor(this.viewport.widthColumns * 0.66);
      widget.resize(
        Math.min(240, Math.max(20, surfaceWidth)),
        Math.max(1, Math.min(16, this.viewport.heightRows - 8)),
      );
      widget.render(this.adapter);
    }
    if (this.interaction instanceof PromptInputWidget || this.interaction instanceof ConfirmWidget) {
      this.interaction.resize(this.viewport.widthColumns);
    } else if (this.interaction instanceof EditorWidget) {
      this.interaction.resize(this.viewport.widthColumns, Math.max(1, this.viewport.heightRows - 8));
    } else if (this.interaction instanceof SelectWidget) {
      this.interaction.resize(this.viewport.widthColumns, Math.max(1, Math.min(50, this.viewport.heightRows - 8)));
    }
    this.plan?.render(this.adapter);
    this.interaction?.render(this.adapter);
  }

  getFocusableWidgetIds(): readonly string[] {
    const order: string[] = [];
    if (this.transcript) order.push(this.transcript.id);
    order.push(...[...this.tools.values()].map((widget) => widget.id));
    if (this.plan) order.push(this.plan.id);
    if (this.statuses) order.push(this.statuses.id);
    order.push(...[...this.surfaces.values()].map(({ widget }) => widget.id));
    return Object.freeze(order);
  }

  focusWidget(widgetId: string | undefined): boolean {
    return this.host.focus(widgetId);
  }

  handleFocusedNavigation(key: string): boolean {
    const widget = this.host.focused();
    if (!widget) return false;
    const normalized = key.toLowerCase();
    if (normalized === 'escape' || normalized === 'esc') {
      this.focusWidget(undefined);
      return true;
    }
    const widgetKey = normalized === 'return'
      ? 'enter'
      : widget instanceof TranscriptWidget
        ? ({ arrowup: 'up', arrowdown: 'down' }[normalized] ?? normalized)
        : normalized;
    const result = widget.handleInput({ type: 'key', key: widgetKey });
    if (result.status === 'ignored') return false;
    widget.render(this.adapter);
    if (widget instanceof StatusNotificationsWidget && result.output !== undefined) {
      this.dispatchStatusAction(widget, result.output);
    }
    const absoluteOffset = widget instanceof PlanWidget || widget instanceof PresentationSurfaceWidget
      ? widget.scrollOffset
      : undefined;
    this.adapter.navigateWidget?.(widget.id, normalized, absoluteOffset);
    return true;
  }

  /**
   * Route a generation-scoped native event through the active semantic widget.
   * Only a typed widget intent may resolve the runtime interaction.
   */
  handleNativeInteraction(generation: number, event: NativeInteractionEvent): void {
    if (generation !== this.interactionGeneration || !this.interaction) return;
    const widget = this.interaction;
    let result: WidgetInputResult;
    if (widget instanceof PromptInputWidget) {
      if (event.type !== 'input-change' && event.type !== 'input-submit' && event.type !== 'key') return;
      if (event.type !== 'key') {
        result = widget.replaceValue(event.value, event.cursor);
        if (result.status === 'invalid') {
          widget.render(this.adapter);
          this.queueValidationAnnouncement(widget, result.message);
          return;
        }
      }
      result = widget.handleInput(event.type === 'input-submit' ? { type: 'submit' } : event.type === 'key'
        ? { type: 'key', key: event.key }
        : { type: 'text', text: '' });
    } else if (widget instanceof EditorWidget) {
      if (event.type !== 'editor-change' && event.type !== 'editor-submit' && event.type !== 'key') return;
      if (event.type !== 'key') {
        result = widget.replaceValue(event.value, event.cursor);
        if (result.status === 'invalid') {
          widget.render(this.adapter);
          this.queueValidationAnnouncement(widget, result.message);
          return;
        }
      }
      result = widget.handleInput(event.type === 'editor-submit' ? { type: 'submit' } : event.type === 'key'
        ? { type: 'key', key: event.key }
        : { type: 'text', text: '' });
    } else if (widget instanceof SelectWidget) {
      if (event.type === 'select-highlight') result = widget.highlightById(event.optionId);
      else if (event.type === 'select-submit') result = widget.selectById(event.optionId);
      else if (event.type === 'key') result = widget.handleInput({ type: 'key', key: event.key });
      else return;
    } else if (widget instanceof ConfirmWidget) {
      if (event.type === 'confirm-highlight') result = widget.handleInput({ type: 'select', index: event.index });
      else if (event.type === 'confirm-submit') {
        const highlighted = widget.handleInput({ type: 'select', index: event.index });
        result = highlighted.status === 'handled'
          ? widget.handleInput({ type: 'submit' })
          : highlighted;
      } else if (event.type === 'key') result = widget.handleInput({ type: 'key', key: event.key });
      else return;
    } else {
      return;
    }

    widget.render(this.adapter);
    if (result.status === 'invalid') this.queueValidationAnnouncement(widget, result.message);
    if (!result.output || generation !== this.interactionGeneration) return;
    const resolved = this.toUiResult(widget, result.output);
    if (resolved) this.resolveInteraction?.(generation, resolved);
  }

  alternateOutput(): string {
    const sections: string[] = [];
    if (this.header) sections.push(this.header.toPlainText());
    if (this.transcript) sections.push(this.transcript.alternateOutput());
    for (const widget of this.tools.values()) sections.push(widget.toPlainText({ expanded: true }));
    if (this.plan) sections.push(this.plan.toPlainText());
    for (const { widget } of this.surfaces.values()) sections.push(widget.alternateOutput());
    if (this.statuses) sections.push(this.statuses.toPlainText());
    if (this.interaction instanceof PromptInputWidget || this.interaction instanceof ConfirmWidget
      || this.interaction instanceof EditorWidget || this.interaction instanceof SelectWidget) {
      sections.push(this.interaction.alternateOutput());
    }
    if (this.footer) sections.push(this.footer.toPlainText());
    return sections.filter(Boolean).join('\n\n');
  }

  drainAnnouncements(): readonly SemanticWidgetAnnouncement[] {
    const announcements: SemanticWidgetAnnouncement[] = [];
    for (const item of this.transcript?.drainAnnouncements() ?? []) {
      announcements.push({ source: 'transcript', politeness: item.politeness, text: item.text });
    }
    for (const [callId, widget] of this.tools) {
      for (const text of widget.takeAnnouncements()) {
        announcements.push({ source: `tool:${callId}`, politeness: 'polite', text });
      }
    }
    for (const text of this.header?.takeAnnouncements() ?? []) {
      announcements.push({ source: 'header', politeness: 'polite', text });
    }
    for (const text of this.footer?.takeAnnouncements() ?? []) {
      announcements.push({ source: 'footer', politeness: 'polite', text });
    }
    for (const text of this.plan?.takeAnnouncements() ?? []) {
      announcements.push({ source: 'plan', politeness: 'polite', text });
    }
    for (const item of this.statuses?.takeAnnouncements() ?? []) {
      announcements.push({ source: `status:${item.key}`, politeness: item.liveRegion, text: item.text });
    }
    announcements.push(...this.interactionAnnouncements.splice(0));
    return Object.freeze(announcements);
  }

  destroy(): void {
    this.host.destroy();
    this.tools.clear();
    this.toolWidgetIds.clear();
    this.transcript = undefined;
    this.header = undefined;
    this.footer = undefined;
    this.plan = undefined;
    this.statuses = undefined;
    this.surfaces.clear();
    this.derivedStatusIds.clear();
    this.runtimeHeaderSnapshot = undefined;
    this.runtimeFooterSnapshot = undefined;
    this.interaction = undefined;
    this.interactionGeneration = undefined;
    this.currentInteractionRequest = undefined;
    this.interactionAnnouncements.length = 0;
    this.interactionAnnouncementSignatures.clear();
    this.interactionAnnouncementSignatureOrder.length = 0;
    this.adapter.bindInteraction?.(undefined, undefined);
  }

  private renderTranscript(state: PresentationState): void {
    const messages = state.messages.map((message) => ({
      id: message.id,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      role: message.role,
      status: message.status,
      segments: message.segments.map((segment) => ({ ...segment })),
    }));
    if (!this.transcript) {
      this.transcript = new TranscriptWidget('transcript', messages);
      this.host.register(this.transcript);
    } else {
      this.transcript.update(messages);
    }
    this.transcript.render(this.adapter);
  }

  private renderTools(state: PresentationState): void {
    const liveIds = new Set(state.tools.map(({ callId }) => callId));
    for (const [callId, widget] of this.tools) {
      if (liveIds.has(callId)) continue;
      this.host.remove(widget);
      this.tools.delete(callId);
      this.toolWidgetIds.delete(callId);
    }
    for (const row of state.tools) {
      const snapshot = toolSnapshot(row, this.viewport.reducedMotion === true);
      let widget = this.tools.get(row.callId);
      if (!widget) {
        const widgetId = this.toolWidgetIds.get(row.callId) ?? `tool-${this.nextToolWidgetId++}`;
        this.toolWidgetIds.set(row.callId, widgetId);
        widget = new ToolProgressWidget(widgetId, snapshot, this.readClock());
        this.tools.set(row.callId, widget);
        this.host.register(widget);
      } else {
        widget.update(snapshot, this.readClock());
      }
      widget.render(this.adapter);
    }
  }

  private renderRuntimeSnapshots(state: PresentationState): void {
    const snapshots = state.runtimeWidgets;
    this.runtimeHeaderSnapshot = snapshots?.header;
    this.runtimeFooterSnapshot = snapshots?.footer;
    const header = snapshots?.header === undefined
      ? undefined
      : { ...snapshots.header, width: this.viewport.widthColumns };
    const footer = snapshots?.footer === undefined
      ? undefined
      : {
          ...snapshots.footer,
          widthColumns: Math.min(1_000, Math.max(20, this.viewport.widthColumns)),
        };
    this.header = this.updateOptional(this.header, header, (value) => new HeaderWidget('header', value));
    this.footer = this.updateOptional(this.footer, footer, (value) => new FooterWidget('footer', value));
    this.plan = this.updateOptional(this.plan, snapshots?.plan, (value) => new PlanWidget('plan', value, {
      widthColumns: Math.min(1_000, Math.max(20, this.viewport.widthColumns)),
      viewportRows: Math.max(1, Math.min(61, this.viewport.heightRows - 8)),
    }));

  }

  private renderPresentationSurfaces(state: PresentationState): void {
    const desired = new Map<string, { readonly sourceId: string; readonly payload: PresentationSurfacePayload }>();
    for (const [id, widget] of Object.entries(state.widgets).sort(([left], [right]) => left.localeCompare(right))) {
      desired.set(`widget:${id}`, { sourceId: `widget-${id}`, payload: surfacePayload(widget) });
    }
    for (const [key, projection] of this.surfaces) {
      if (desired.has(key)) continue;
      this.host.remove(projection.widget);
      this.surfaces.delete(key);
    }
    for (const [key, value] of desired) {
      const payload = value.payload;
      const signature = JSON.stringify(payload);
      let projection = this.surfaces.get(key);
      if (!projection) {
        const widget = new PresentationSurfaceWidget(`presentation-${this.nextSurfaceWidgetId++}`, {
          authority: 'runtime',
          id: value.sourceId,
          revision: 0,
          payload,
        }, {
          widthColumns: Math.min(240, Math.max(20, this.viewport.widthColumns)),
          viewportRows: Math.max(1, Math.min(16, this.viewport.heightRows - 8)),
        });
        projection = { widget, signature, revision: 0 };
        this.surfaces.set(key, projection);
        this.host.register(widget);
      } else if (projection.signature !== signature) {
        projection.signature = signature;
        projection.revision += 1;
        projection.widget.update({
          authority: 'runtime',
          id: value.sourceId,
          revision: projection.revision,
          payload,
        });
      }
      projection.widget.render(this.adapter);
    }
  }

  private renderStatuses(state: PresentationState): void {
    const desired: StatusNotificationInput[] = (state.runtimeWidgets?.statusNotifications ?? []).map((item) => (
      this.statusAction === undefined && item.action !== undefined
        ? {
            authority: item.authority,
            slot: item.slot,
            id: item.id,
            message: item.message,
            lifecycle: item.lifecycle,
          }
        : item
    ));
    const occupied = new Set(desired.map(({ slot, id }) => `${slot}:${id}`));
    const activeDerivedSources = new Set<string>();
    const uniqueId = (sourceKey: string): string => {
      activeDerivedSources.add(sourceKey);
      const existing = this.derivedStatusIds.get(sourceKey);
      if (existing !== undefined && !occupied.has(`system:${existing}`)) {
        occupied.add(`system:${existing}`);
        return existing;
      }
      let candidate: string;
      do candidate = `presentation-${this.nextDerivedStatusId++}`;
      while (occupied.has(`system:${candidate}`));
      this.derivedStatusIds.set(sourceKey, candidate);
      occupied.add(`system:${candidate}`);
      return candidate;
    };
    for (const [name, text] of Object.entries(state.statuses)
      .sort(([left], [right]) => left.localeCompare(right))) {
      desired.push({
        authority: 'runtime',
        slot: 'system',
        id: uniqueId(`status:${name}`),
        message: `${name}: ${text}`,
        lifecycle: 'active',
      });
    }
    const notificationOccurrences = new Map<string, number>();
    state.notifications.forEach((notification) => {
      const signature = JSON.stringify([notification.severity, notification.message]);
      const occurrence = (notificationOccurrences.get(signature) ?? 0) + 1;
      notificationOccurrences.set(signature, occurrence);
      desired.push({
        authority: 'runtime',
        slot: 'system',
        id: uniqueId(`notification:${signature}:${occurrence}`),
        message: notification.message,
        lifecycle: notificationLifecycle(notification.severity),
      });
    });
    for (const sourceKey of this.derivedStatusIds.keys()) {
      if (!activeDerivedSources.has(sourceKey)) this.derivedStatusIds.delete(sourceKey);
    }

    if (desired.length === 0) {
      if (this.statuses) this.host.remove(this.statuses);
      this.statuses = undefined;
      return;
    }
    if (!this.statuses) {
      this.statuses = new StatusNotificationsWidget('status-notifications', {
        itemLimit: 64,
        historyLimit: 512,
        announcementLimit: 64,
      });
      this.host.register(this.statuses);
    }
    const incomingKeys = new Set(desired
      .filter(({ lifecycle }) => lifecycle !== 'cleared')
      .map(({ slot, id }) => `${slot}:${id}`));
    for (const item of this.statuses.items) {
      if (incomingKeys.has(item.key)) continue;
      this.statuses.upsert({
        authority: 'runtime',
        slot: item.slot,
        id: item.id,
        message: item.message,
        lifecycle: 'cleared',
      }, this.readClock());
    }
    for (const item of desired) this.statuses.upsert(item, this.readClock());
    this.statuses.render(this.adapter);
  }

  private renderInteraction(interaction: PresentationInteraction | undefined): void {
    const visible = interaction !== undefined && (interaction.status === 'pending' || interaction.status === 'validation');
    if (!visible) {
      if (this.interaction) this.host.remove(this.interaction);
      this.interaction = undefined;
      this.interactionGeneration = undefined;
      this.currentInteractionRequest = undefined;
      this.adapter.bindInteraction?.(undefined, undefined);
      return;
    }
    if (!this.interaction || this.interactionGeneration !== interaction.generation) {
      if (this.interaction) this.host.remove(this.interaction);
      this.interaction = this.interactionWidgetFactory(interaction);
      this.interactionGeneration = interaction.generation;
      this.currentInteractionRequest = interaction.request;
      this.interactionAnnouncements.length = 0;
      this.interactionAnnouncementSignatures.clear();
      this.interactionAnnouncementSignatureOrder.length = 0;
      this.host.register(this.interaction);
      this.adapter.bindInteraction?.(interaction.generation, this.interaction);
      this.queueInteractionAnnouncement(this.interaction);
    }
    if (interaction.validation !== undefined) {
      this.queueValidationAnnouncement(this.interaction, interaction.validation);
    }
    this.interaction.render(this.adapter);
  }

  private updateOptional<T extends HeaderWidget | FooterWidget | PlanWidget, S>(
    current: T | undefined,
    snapshot: S | undefined,
    create: (snapshot: S) => T,
  ): T | undefined {
    if (snapshot === undefined) {
      if (current) this.host.remove(current);
      return undefined;
    }
    if (!current) {
      const widget = create(snapshot);
      this.host.register(widget);
      widget.render(this.adapter);
      return widget;
    }
    current.update(snapshot as never);
    current.render(this.adapter);
    return current;
  }

  private normalizeViewport(viewport: WidgetViewport): WidgetViewport {
    if (!Number.isSafeInteger(viewport.widthColumns) || viewport.widthColumns < 1 || viewport.widthColumns > 10_000) {
      throw new Error('widget viewport width must be an integer from 1 to 10000');
    }
    if (!Number.isSafeInteger(viewport.heightRows) || viewport.heightRows < 1 || viewport.heightRows > 10_000) {
      throw new Error('widget viewport height must be an integer from 1 to 10000');
    }
    return Object.freeze({ ...viewport });
  }

  private toUiResult(widget: WidgetContract, output: unknown): UiInteractionResult | undefined {
    if (!output || typeof output !== 'object' || !('type' in output)) return undefined;
    if (output.type === 'cancel') return { status: 'cancelled' };
    if (output.type === 'timeout') return { status: 'timeout' };
    if ((widget instanceof PromptInputWidget || widget instanceof EditorWidget)
      && output.type === 'submit' && 'value' in output && typeof output.value === 'string') {
      return { status: 'accepted', value: output.value };
    }
    if (widget instanceof ConfirmWidget && output.type === 'decision'
      && 'confirmed' in output && typeof output.confirmed === 'boolean') {
      return { status: 'accepted', value: output.confirmed };
    }
    if (widget instanceof SelectWidget && output.type === 'select'
      && 'optionId' in output && typeof output.optionId === 'string') {
      const index = Number.parseInt(output.optionId.replace(/^choice-/u, ''), 10) - 1;
      const request = this.currentInteractionRequest;
      if (request?.type !== 'select' || !Number.isSafeInteger(index) || index < 0) return undefined;
      const value = request.options[index];
      return value === undefined ? undefined : { status: 'accepted', value };
    }
    return undefined;
  }

  private dispatchStatusAction(widget: StatusNotificationsWidget, value: unknown): void {
    if (this.statusAction === undefined || !value || typeof value !== 'object') return;
    const output = value as Partial<StatusNotificationOutput>;
    if (output.type !== 'action' || typeof output.key !== 'string' || output.action === undefined
      || typeof output.action.id !== 'string' || typeof output.action.label !== 'string') return;
    const selected = widget.items.find(({ key }) => key === output.key);
    if (selected?.action === undefined
      || selected.action.id !== output.action.id
      || selected.action.label !== output.action.label) return;
    const invocation: StatusNotificationActionInvocation = Object.freeze({
      key: selected.key,
      action: Object.freeze({ ...selected.action }),
    });
    queueMicrotask(() => {
      void Promise.resolve()
        .then(() => this.statusAction?.(invocation))
        .catch((error: unknown) => this.callbackFailure?.(error));
    });
  }

  private queueInteractionAnnouncement(widget: WidgetContract): void {
    const { label, description, liveRegion } = widget.accessibility;
    if (liveRegion === 'off') return;
    this.queueInteractionAnnouncementValue({
      source: `interaction:${widget.id}`,
      politeness: liveRegion,
      text: description === undefined ? label : `${label}. ${description}`,
    });
  }

  private queueValidationAnnouncement(widget: WidgetContract, message: string | undefined): void {
    const text = message === undefined ? '' : sanitizeSingleLineText(message.replace(/[\r\n]+/gu, ' '), {
      maxGraphemes: 512,
      tabWidth: 1,
      redactCredentials: true,
    }).replace(/\s{2,}/gu, ' ').trim();
    if (!text) return;
    this.queueInteractionAnnouncementValue({
      source: `interaction:${widget.id}:validation`,
      politeness: widget.accessibility.liveRegion === 'off' ? 'polite' : widget.accessibility.liveRegion,
      text,
    });
  }

  private queueInteractionAnnouncementValue(announcement: SemanticWidgetAnnouncement): void {
    const signature = JSON.stringify([announcement.source, announcement.politeness, announcement.text]);
    if (this.interactionAnnouncementSignatures.has(signature)) return;
    this.interactionAnnouncementSignatures.add(signature);
    this.interactionAnnouncementSignatureOrder.push(signature);
    if (this.interactionAnnouncementSignatureOrder.length > SemanticWidgetController.INTERACTION_DEDUPE_LIMIT) {
      const evicted = this.interactionAnnouncementSignatureOrder.shift();
      if (evicted !== undefined) this.interactionAnnouncementSignatures.delete(evicted);
    }
    this.interactionAnnouncements.push(Object.freeze({ ...announcement }));
    if (this.interactionAnnouncements.length > SemanticWidgetController.INTERACTION_ANNOUNCEMENT_LIMIT) {
      this.interactionAnnouncements.splice(
        0,
        this.interactionAnnouncements.length - SemanticWidgetController.INTERACTION_ANNOUNCEMENT_LIMIT,
      );
    }
  }

  private readClock(): number {
    const value = this.nowMs();
    if (!Number.isFinite(value) || value < 0) throw new Error('widget clock must return a non-negative finite value');
    this.lastClockMs = Math.max(this.lastClockMs, value);
    return this.lastClockMs;
  }
}
