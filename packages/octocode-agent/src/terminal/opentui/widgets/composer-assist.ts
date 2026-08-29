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
import {
  assertStableTerminalId,
  sanitizeSingleLineText,
  segmentGraphemes,
  truncateGraphemes,
} from './sanitize.js';

const MAX_SUGGESTIONS = 100;
const MAX_QUERY_GRAPHEMES = 256;
const MAX_LABEL_GRAPHEMES = 256;
const MAX_DESCRIPTION_GRAPHEMES = 512;
const MAX_DETAIL_GRAPHEMES = 1_024;
const MAX_VIEWPORT_DIMENSION = 10_000;
const MAX_ANNOUNCEMENTS = 32;

export type ComposerAssistMode = 'command' | 'file';
export type ComposerAssistState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface ComposerAssistSuggestion {
  readonly id: string;
  readonly kind: ComposerAssistMode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly disabledReason?: string;
}

export interface ComposerAssistSnapshot {
  readonly authority: 'runtime';
  readonly revision: number;
  readonly mode: ComposerAssistMode;
  readonly state: ComposerAssistState;
  readonly query: string;
  readonly suggestions: readonly ComposerAssistSuggestion[];
  readonly selectedId?: string;
  readonly errorMessage?: string;
}

export interface ComposerAssistWidgetOptions {
  readonly widthColumns?: number;
  readonly viewportRows?: number;
}

export type ComposerAssistIntent =
  | { readonly type: 'filter'; readonly mode: ComposerAssistMode; readonly query: string }
  | { readonly type: 'activate'; readonly suggestionId: string; readonly kind: ComposerAssistMode }
  | { readonly type: 'cancel'; readonly reason: 'escape' | 'interrupt' | 'semantic' };

export type ComposerAssistWidgetResult = WidgetInputResult<ComposerAssistIntent>;

export const COMPOSER_ASSIST_INSTRUCTIONS = {
  purpose: 'Present runtime-authoritative slash-command or file-reference suggestions beside the composer.',
  useWhen: [
    'The composer is filtering commands after slash or workspace files after at-sign input.',
    'The runtime can provide stable, bounded suggestion identities and lifecycle state.',
  ],
  avoidWhen: [
    'Use the select widget for a consequential finite answer unrelated to composer completion.',
    'Do not use this widget as a filesystem browser, command executor, permission prompt, or source of suggestion authority.',
  ],
  inputs: [
    'Provide immutable runtime-authoritative snapshots with monotonic revisions, one mode, one state, and stable suggestion IDs.',
    'Suggestions must match the snapshot mode and include a complete label plus optional description, detail, or disabled reason.',
  ],
  stateAndOutput: [
    'The widget owns only temporary highlight, viewport, and filter text; runtime snapshots own suggestions and committed selected ID.',
    'Typed outputs are filter, activate, or cancel intents; the widget has no filesystem access and no dispatch authority.',
  ],
  keys: [
    'Up and Down move; PageUp and PageDown page; Home and End jump; Enter requests activation.',
    'Typing and paste request filtering, Backspace edits the filter, and Escape or Ctrl-C cancels.',
  ],
  accessibility: [
    'Expose a labeled listbox with textual state, highlighted, selected, available, and disabled markers.',
    'Announce loading, empty, ready, error, and highlight changes without relying on animation or color.',
  ],
  recovery: [
    'Preserve the last valid snapshot when an update is stale or invalid and return invalid input results for disabled activation.',
    'Empty, loading, idle, and error states remain cancellable and never fabricate a selection.',
  ],
} as const satisfies WidgetAgentInstructions;

type ComposerAssistInstructions = typeof COMPOSER_ASSIST_INSTRUCTIONS;

function invalid(message: string): never {
  throw new WidgetContractError('validation', message);
}

function cleanText(value: string | undefined, field: string, maxGraphemes: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const safe = sanitizeSingleLineText(value.replace(/[\r\n\u2028\u2029]+/gu, ' '), {
    maxGraphemes,
    tabWidth: 1,
    redactCredentials: true,
  }).replace(/\s{2,}/gu, ' ').trim();
  if (!allowEmpty && safe.length === 0) invalid(`${field} must be a non-empty string`);
  return safe;
}

function stableId(value: string, field: string): string {
  try {
    return assertStableTerminalId(value);
  } catch {
    return invalid(`${field} must be a stable terminal-safe ID`);
  }
}

function optionalText(value: string | undefined, field: string, maxGraphemes: number): string | undefined {
  return value === undefined ? undefined : cleanText(value, field, maxGraphemes);
}

function normalizeSnapshot(value: ComposerAssistSnapshot): ComposerAssistSnapshot {
  if (value.authority !== 'runtime') invalid('composer assist snapshot requires runtime authority');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) invalid('snapshot revision must be a non-negative integer');
  if (value.mode !== 'command' && value.mode !== 'file') invalid('snapshot mode is invalid');
  if (!['idle', 'loading', 'ready', 'empty', 'error'].includes(value.state)) invalid('snapshot state is invalid');
  if (!Array.isArray(value.suggestions) || value.suggestions.length > MAX_SUGGESTIONS) {
    invalid(`suggestions must contain no more than ${MAX_SUGGESTIONS} entries`);
  }
  if (value.state === 'ready' && value.suggestions.length === 0) invalid('ready state requires at least one suggestion');
  if (value.state !== 'ready' && value.suggestions.length !== 0) invalid(`${value.state} state cannot contain suggestions`);
  if (value.state === 'error' && value.errorMessage === undefined) invalid('error state requires errorMessage');
  if (value.state !== 'error' && value.errorMessage !== undefined) invalid('errorMessage is only valid in error state');

  const ids = new Set<string>();
  const suggestions = value.suggestions.map((suggestion, index) => {
    const id = stableId(suggestion.id, `suggestions[${index}].id`);
    if (ids.has(id)) invalid(`suggestion ID '${id}' is duplicated`);
    ids.add(id);
    if (suggestion.kind !== value.mode) invalid(`suggestions[${index}].kind must match snapshot mode`);
    return Object.freeze({
      id,
      kind: suggestion.kind,
      label: cleanText(suggestion.label, `suggestions[${index}].label`, MAX_LABEL_GRAPHEMES),
      ...(optionalText(suggestion.description, `suggestions[${index}].description`, MAX_DESCRIPTION_GRAPHEMES) === undefined
        ? {}
        : { description: optionalText(suggestion.description, `suggestions[${index}].description`, MAX_DESCRIPTION_GRAPHEMES) }),
      ...(optionalText(suggestion.detail, `suggestions[${index}].detail`, MAX_DETAIL_GRAPHEMES) === undefined
        ? {}
        : { detail: optionalText(suggestion.detail, `suggestions[${index}].detail`, MAX_DETAIL_GRAPHEMES) }),
      ...(optionalText(suggestion.disabledReason, `suggestions[${index}].disabledReason`, MAX_DESCRIPTION_GRAPHEMES) === undefined
        ? {}
        : { disabledReason: optionalText(suggestion.disabledReason, `suggestions[${index}].disabledReason`, MAX_DESCRIPTION_GRAPHEMES) }),
    });
  });
  const selectedId = value.selectedId === undefined ? undefined : stableId(value.selectedId, 'selectedId');
  if (selectedId !== undefined) {
    const selected = suggestions.find(({ id }) => id === selectedId);
    if (selected === undefined) invalid(`selectedId '${selectedId}' does not match a suggestion`);
    if (selected.disabledReason !== undefined) invalid(`selectedId '${selectedId}' is disabled`);
  }
  return Object.freeze({
    authority: 'runtime',
    revision: value.revision,
    mode: value.mode,
    state: value.state,
    query: cleanText(value.query, 'query', MAX_QUERY_GRAPHEMES, true),
    suggestions: Object.freeze(suggestions),
    ...(selectedId === undefined ? {} : { selectedId }),
    ...(value.errorMessage === undefined
      ? {}
      : { errorMessage: cleanText(value.errorMessage, 'errorMessage', MAX_DESCRIPTION_GRAPHEMES) }),
  });
}

function removeLastGrapheme(value: string): string {
  const parts = segmentGraphemes(value);
  parts.pop();
  return parts.join('');
}

function modeNoun(mode: ComposerAssistMode): string {
  return mode === 'command' ? 'command' : 'file';
}

function sentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

function stateAnnouncement(snapshot: ComposerAssistSnapshot): string {
  const noun = modeNoun(snapshot.mode);
  switch (snapshot.state) {
    case 'idle': return snapshot.mode === 'command' ? 'Type / for commands.' : 'Type @ for files.';
    case 'loading': return `Loading ${noun} suggestions…`;
    case 'empty': return `No ${noun} suggestions.`;
    case 'error': return `${snapshot.mode === 'command' ? 'Command' : 'File'} suggestions failed: ${sentence(snapshot.errorMessage!)}`;
    case 'ready': return `${snapshot.mode === 'command' ? 'Commands' : 'Files'} ready, ${snapshot.suggestions.length} suggestions.`;
  }
}

export class ComposerAssistWidget extends OpenTuiWidget<ComposerAssistIntent, ComposerAssistInstructions> {
  private snapshotValue: ComposerAssistSnapshot;
  private highlightedIdValue?: string;
  private filterQueryValue: string;
  private widthColumns: number;
  private viewportRows: number;
  private scrollOffsetValue = 0;
  private pendingAnnouncements: string[] = [];

  constructor(id: string, initial: ComposerAssistSnapshot, options: ComposerAssistWidgetOptions = {}) {
    const snapshot = normalizeSnapshot(initial);
    super({
      id,
      kind: 'composer.assist',
      capabilities: { focusable: true, inputMode: 'selection' },
      accessibility: {
        role: 'listbox',
        label: snapshot.mode === 'command' ? 'Command suggestions' : 'File suggestions',
        description: 'Runtime-authoritative composer completions. Activation emits an intent but performs no command or filesystem action.',
        liveRegion: 'polite',
        keyboardHelp: [
          'Arrow keys move; Home, End, PageUp, and PageDown jump',
          'Typing filters; Enter requests activation; Escape or Ctrl-C closes',
        ],
      },
      instructions: COMPOSER_ASSIST_INSTRUCTIONS,
    });
    this.snapshotValue = snapshot;
    this.filterQueryValue = snapshot.query;
    this.widthColumns = this.dimension(options.widthColumns ?? 80, 'widthColumns');
    this.viewportRows = this.dimension(options.viewportRows ?? 8, 'viewportRows');
    this.highlightedIdValue = this.initialHighlight(snapshot);
    this.queueAnnouncement(stateAnnouncement(snapshot));
  }

  override render(adapter?: WidgetRenderAdapter): WidgetRenderState {
    return super.render(adapter);
  }

  get snapshot(): ComposerAssistSnapshot { return this.snapshotValue; }
  get suggestions(): readonly ComposerAssistSuggestion[] { return this.snapshotValue.suggestions; }
  get selectedId(): string | undefined { return this.snapshotValue.selectedId; }
  get highlightedId(): string | undefined { return this.highlightedIdValue; }
  get filterQuery(): string { return this.filterQueryValue; }
  get scrollOffset(): number { return this.scrollOffsetValue; }

  update(value: ComposerAssistSnapshot): void {
    const next = normalizeSnapshot(value);
    if (next.revision <= this.snapshotValue.revision) invalid('snapshot revision must increase monotonically');
    const priorHighlight = this.highlightedIdValue;
    this.snapshotValue = next;
    this.filterQueryValue = next.query;
    this.highlightedIdValue = next.suggestions.some(({ id, disabledReason }) => id === priorHighlight && disabledReason === undefined)
      ? priorHighlight
      : this.initialHighlight(next);
    this.ensureVisible();
    this.queueAnnouncement(stateAnnouncement(next));
    this.invalidate();
  }

  resize(widthColumns: number, viewportRows: number): void {
    this.widthColumns = this.dimension(widthColumns, 'widthColumns');
    this.viewportRows = this.dimension(viewportRows, 'viewportRows');
    this.ensureVisible();
    this.invalidate();
  }

  highlightById(id: string): ComposerAssistWidgetResult {
    const stable = stableId(id, 'suggestionId');
    const suggestion = this.snapshotValue.suggestions.find((item) => item.id === stable);
    if (suggestion === undefined) return { status: 'invalid', message: `Suggestion ${stable} does not exist.` };
    if (suggestion.disabledReason !== undefined) {
      return { status: 'invalid', message: `Suggestion ${stable} is disabled: ${sentence(suggestion.disabledReason)}` };
    }
    this.highlightedIdValue = stable;
    this.ensureVisible();
    this.queueAnnouncement(`${suggestion.label}${suggestion.description === undefined ? '' : `. ${suggestion.description}`}`);
    this.invalidate();
    return { status: 'handled' };
  }

  activateById(id: string): ComposerAssistWidgetResult {
    const highlighted = this.highlightById(id);
    if (highlighted.status !== 'handled') return highlighted;
    const suggestion = this.snapshotValue.suggestions.find((item) => item.id === this.highlightedIdValue)!;
    return { status: 'handled', output: { type: 'activate', suggestionId: suggestion.id, kind: suggestion.kind } };
  }

  takeAnnouncements(): readonly string[] {
    const values = Object.freeze([...this.pendingAnnouncements]);
    this.pendingAnnouncements = [];
    return values;
  }

  alternateOutput(): string {
    const lines = [
      `${this.snapshotValue.mode === 'command' ? 'Commands' : 'Files'} — ${this.snapshotValue.state.toUpperCase()} — revision ${this.snapshotValue.revision}`,
      `Filter: ${this.filterQueryValue || '(empty)'}`,
      `Selected: ${this.snapshotValue.selectedId ?? 'none'}`,
    ];
    if (this.snapshotValue.state !== 'ready') lines.push(stateAnnouncement(this.snapshotValue));
    this.snapshotValue.suggestions.forEach((suggestion, index) => {
      const marker = suggestion.disabledReason !== undefined
        ? `disabled: ${suggestion.disabledReason}`
        : suggestion.id === this.snapshotValue.selectedId ? 'selected' : 'available';
      const detail = suggestion.description ?? suggestion.detail;
      lines.push(`${index + 1}. [${marker}] ${suggestion.label}${detail === undefined ? '' : ` — ${detail}`} (id=${suggestion.id}, kind=${suggestion.kind})`);
    });
    return truncateGraphemes(lines.join('\n'), MAX_WIDGET_TEXT_LENGTH);
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const heading = `${this.snapshotValue.mode === 'command' ? 'Commands' : 'Files'} · ${this.snapshotValue.state.toUpperCase()} · filter: ${this.filterQueryValue || '(empty)'}`;
    const regions: WidgetRenderRegion[] = [
      { id: 'summary', role: 'status', text: this.fit(heading) },
    ];
    if (this.snapshotValue.state !== 'ready') {
      regions.push({ id: 'state', role: this.snapshotValue.state === 'error' ? 'status' : 'content', text: this.fit(stateAnnouncement(this.snapshotValue)) });
    } else {
      const visible = this.snapshotValue.suggestions.slice(this.scrollOffsetValue, this.scrollOffsetValue + this.viewportRows);
      visible.forEach((suggestion, visibleIndex) => {
        const marker = suggestion.disabledReason !== undefined
          ? 'disabled'
          : suggestion.id === this.snapshotValue.selectedId ? 'selected' : 'available';
        const detail = suggestion.disabledReason ?? suggestion.description ?? suggestion.detail;
        regions.push({
          id: `suggestion-${this.scrollOffsetValue + visibleIndex + 1}`,
          role: 'option',
          text: this.fit(`${suggestion.id === this.highlightedIdValue ? '>' : ' '} [${marker}] ${suggestion.label}${detail === undefined ? '' : ` — ${detail}`}`),
        });
      });
    }
    regions.push({
      id: 'help',
      role: 'help',
      text: this.fit('↑/↓ move · PgUp/PgDn page · Home/End bounds · Enter choose · Esc close · typing filters'),
    });
    return regions;
  }

  protected onInput(input: WidgetInput): ComposerAssistWidgetResult {
    if (input.type === 'text' || input.type === 'paste') return this.filter(input.text);
    if (input.type === 'cancel') return { status: 'handled', output: { type: 'cancel', reason: 'semantic' } };
    if (input.type === 'submit') return this.activateHighlighted();
    if (input.type === 'select') {
      const suggestion = this.snapshotValue.suggestions[input.index];
      return suggestion === undefined
        ? { status: 'invalid', message: 'Suggestion index is out of range.' }
        : this.highlightById(suggestion.id);
    }
    if (input.type !== 'key') return { status: 'ignored' };
    const key = input.key.toLowerCase();
    if (key === 'escape' || key === 'esc') return { status: 'handled', output: { type: 'cancel', reason: 'escape' } };
    if (key === 'ctrl+c') return { status: 'handled', output: { type: 'cancel', reason: 'interrupt' } };
    if (key === 'enter' || key === 'return') return this.activateHighlighted();
    if (key === 'backspace') {
      this.filterQueryValue = removeLastGrapheme(this.filterQueryValue);
      this.invalidate();
      return { status: 'handled', output: { type: 'filter', mode: this.snapshotValue.mode, query: this.filterQueryValue } };
    }
    if (key === 'home') return this.moveToBoundary(false);
    if (key === 'end') return this.moveToBoundary(true);
    if (key === 'arrowup' || key === 'up' || key === 'k') return this.move(-1, true);
    if (key === 'arrowdown' || key === 'down' || key === 'j') return this.move(1, true);
    if (key === 'pageup') return this.move(-this.viewportRows, false);
    if (key === 'pagedown') return this.move(this.viewportRows, false);
    return { status: 'ignored' };
  }

  private filter(text: string): ComposerAssistWidgetResult {
    const safe = cleanText(text, 'filter text', MAX_QUERY_GRAPHEMES, true);
    this.filterQueryValue = truncateGraphemes(this.filterQueryValue + safe, MAX_QUERY_GRAPHEMES, '');
    this.invalidate();
    return { status: 'handled', output: { type: 'filter', mode: this.snapshotValue.mode, query: this.filterQueryValue } };
  }

  private activateHighlighted(): ComposerAssistWidgetResult {
    if (this.highlightedIdValue === undefined) return { status: 'invalid', message: 'No enabled suggestion is available.' };
    return this.activateById(this.highlightedIdValue);
  }

  private move(delta: number, wrap: boolean): ComposerAssistWidgetResult {
    const enabled = this.enabledSuggestions();
    if (enabled.length === 0) return { status: 'invalid', message: 'No enabled suggestion is available.' };
    const current = enabled.findIndex(({ id }) => id === this.highlightedIdValue);
    let next = (current < 0 ? 0 : current) + delta;
    if (wrap) next = ((next % enabled.length) + enabled.length) % enabled.length;
    else next = Math.max(0, Math.min(enabled.length - 1, next));
    return this.highlightById(enabled[next]!.id);
  }

  private moveToBoundary(end: boolean): ComposerAssistWidgetResult {
    const enabled = this.enabledSuggestions();
    if (enabled.length === 0) return { status: 'invalid', message: 'No enabled suggestion is available.' };
    return this.highlightById((end ? enabled.at(-1) : enabled[0])!.id);
  }

  private enabledSuggestions(): readonly ComposerAssistSuggestion[] {
    return this.snapshotValue.suggestions.filter(({ disabledReason }) => disabledReason === undefined);
  }

  private initialHighlight(snapshot: ComposerAssistSnapshot): string | undefined {
    return snapshot.selectedId ?? snapshot.suggestions.find(({ disabledReason }) => disabledReason === undefined)?.id;
  }

  private ensureVisible(): void {
    const index = this.snapshotValue.suggestions.findIndex(({ id }) => id === this.highlightedIdValue);
    if (index < 0) {
      this.scrollOffsetValue = 0;
      return;
    }
    if (index < this.scrollOffsetValue) this.scrollOffsetValue = index;
    if (index >= this.scrollOffsetValue + this.viewportRows) this.scrollOffsetValue = index - this.viewportRows + 1;
    const maximum = Math.max(0, this.snapshotValue.suggestions.length - this.viewportRows);
    this.scrollOffsetValue = Math.max(0, Math.min(maximum, this.scrollOffsetValue));
  }

  private queueAnnouncement(value: string): void {
    if (this.pendingAnnouncements.at(-1) === value) return;
    this.pendingAnnouncements.push(value);
    if (this.pendingAnnouncements.length > MAX_ANNOUNCEMENTS) {
      this.pendingAnnouncements.splice(0, this.pendingAnnouncements.length - MAX_ANNOUNCEMENTS);
    }
  }

  private fit(value: string): string {
    return truncateGraphemes(value, Math.max(1, this.widthColumns));
  }

  private dimension(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VIEWPORT_DIMENSION) {
      invalid(`${field} must be an integer from 1 to ${MAX_VIEWPORT_DIMENSION}`);
    }
    return value;
  }
}
