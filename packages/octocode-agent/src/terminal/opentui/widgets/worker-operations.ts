import type {
  NativeWorkerInboxAction,
  NativeWorkerInboxEntry,
  NativeWorkerInboxSnapshot,
} from '../../../native-worker-operations-snapshot.js';
import type { NativeWorkerOperationIntent } from '../../../native-worker-operations.js';
import { OpenTuiWidget } from './base.js';
import type { WidgetInput, WidgetInputResult, WidgetRenderRegion } from './contracts.js';
import { fitTerminalText } from './layout.js';
import { assertStableTerminalId, sanitizeSingleLineText } from './sanitize.js';

const MAX_WORKERS = 50;
const MIN_WIDTH = 20;
const MAX_WIDTH = 1_000;
const MIN_ROWS = 1;
const MAX_ROWS = 50;
const STATES = new Set(['queued', 'starting', 'running', 'aborting', 'killing', 'succeeded', 'failed', 'aborted', 'killed']);
const ACTIONS = new Set<NativeWorkerInboxAction>(['inspect', 'send', 'follow-up', 'steer', 'abort']);

export interface WorkerOperationsWidgetOptions {
  readonly widthColumns?: number;
  readonly viewportRows?: number;
}

export type WorkerOperationsWidgetIntent = Extract<NativeWorkerOperationIntent, { type: 'inspect' }>;

const INSTRUCTIONS = {
  purpose: 'Render the runtime worker inbox and emit only generation-scoped, stable-ID inspection intents.',
  useWhen: [
    'A user needs to inspect live or terminal workers before choosing an input or process operation.',
    'The runtime supplies a renderer-neutral worker inbox snapshot with explicit safe actions.',
  ],
  avoidWhen: [
    'Worker process IDs, prompts, capabilities, hidden reasoning, or handback bodies are the requested input.',
    'A renderer would bypass the runtime worker operations controller or force-kill approval boundary.',
  ],
  inputs: [
    'Use only runtime-authoritative, monotonically increasing generation snapshots.',
    'Preserve stable worker IDs and the explicit available-actions list.',
  ],
  stateAndOutput: [
    'Open read-only: selection and Enter inspect worker status without mutating worker state.',
    'Show send, follow-up, steer, graceful abort, and approval-gated force-kill command forms for the selected worker.',
    'Never expose a PID, prompt, capability set, model packet, hidden reasoning, terminal reason, or handback body.',
  ],
  keys: [
    'Arrow Up and Arrow Down select a worker; Home and End jump to bounds.',
    'Enter emits one typed inspect intent carrying the visible generation and stable worker ID.',
  ],
  accessibility: [
    'Expose the inbox as a listbox and worker rows as textual state-bearing options.',
    'Keep force-kill approval and graceful-abort semantics explicit without relying on color.',
  ],
  recovery: [
    'Reject stale generations, authority drift, duplicate IDs, unsupported states/actions, and oversized snapshots.',
    'Refresh the inbox after a stale-generation result before sending another intent.',
  ],
} as const;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`${label} is outside its supported bounds`);
  }
  return normalized;
}

function safe(value: string, label: string, max = 2_048): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = sanitizeSingleLineText(value, { maxGraphemes: max, redactCredentials: true, tabWidth: 1 })
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) throw new Error(`${label} must be a bounded non-empty value`);
  return normalized;
}

function normalizeEntry(value: NativeWorkerInboxEntry, index: number): NativeWorkerInboxEntry {
  const id = assertStableTerminalId(value.workerId, { maxLength: 128 });
  if (!STATES.has(value.state)) throw new Error(`worker ${index} state is invalid`);
  if (!Number.isSafeInteger(value.queueDepth) || value.queueDepth < 0) throw new Error(`worker ${index} queue depth is invalid`);
  if (!Array.isArray(value.availableActions) || value.availableActions.some((action) => !ACTIONS.has(action))) {
    throw new Error(`worker ${index} actions are invalid`);
  }
  if (new Set(value.availableActions).size !== value.availableActions.length) throw new Error(`worker ${index} actions contain duplicates`);
  return Object.freeze({
    workerId: id,
    state: value.state,
    queueDepth: value.queueDepth,
    ...(value.planStepId === undefined ? {} : { planStepId: assertStableTerminalId(value.planStepId, { maxLength: 128 }) }),
    ...(value.taskLabel === undefined ? {} : { taskLabel: safe(value.taskLabel, `worker ${index} task label`) }),
    ...(value.terminalOutcome === undefined ? {} : { terminalOutcome: value.terminalOutcome }),
    availableActions: Object.freeze([...value.availableActions]),
    forceKillAvailable: value.forceKillAvailable === true,
  });
}

function normalizeSnapshot(value: NativeWorkerInboxSnapshot): NativeWorkerInboxSnapshot {
  if (value.authority !== 'runtime') throw new Error('worker inbox snapshot requires runtime authority');
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('worker inbox generation is invalid');
  if (!Number.isFinite(value.capturedAt) || value.capturedAt < 0) throw new Error('worker inbox capture time is invalid');
  if (!Array.isArray(value.workers) || value.workers.length > MAX_WORKERS) throw new Error('worker inbox exceeds its item bound');
  const workers = value.workers.map((entry, index) => normalizeEntry(entry, index + 1));
  if (new Set(workers.map(({ workerId }) => workerId)).size !== workers.length) throw new Error('worker inbox contains duplicate stable IDs');
  const selectedWorkerId = value.selectedWorkerId === undefined
    ? undefined
    : assertStableTerminalId(value.selectedWorkerId, { maxLength: 128 });
  if (selectedWorkerId !== undefined && !workers.some(({ workerId }) => workerId === selectedWorkerId)) {
    throw new Error('selected worker is not present in the inbox');
  }
  return Object.freeze({
    authority: 'runtime',
    generation: value.generation,
    capturedAt: value.capturedAt,
    ...(selectedWorkerId === undefined ? {} : { selectedWorkerId }),
    workers: Object.freeze(workers),
  });
}

export class WorkerOperationsWidget extends OpenTuiWidget<WorkerOperationsWidgetIntent> {
  private snapshotValue: NativeWorkerInboxSnapshot;
  private widthColumns: number;
  private viewportRows: number;
  private selectedIndex = 0;
  private scrollOffset = 0;

  constructor(id: string, snapshot: NativeWorkerInboxSnapshot, options: WorkerOperationsWidgetOptions = {}) {
    super({
      id,
      kind: 'worker-operations',
      capabilities: { focusable: true, inputMode: 'selection' },
      accessibility: {
        role: 'listbox',
        label: 'Worker inbox',
        description: 'A safe worker list with generation-scoped inspection and explicit operation commands.',
        liveRegion: 'polite',
        keyboardHelp: ['Use arrows to select and Enter to inspect; worker mutation remains runtime-owned.'],
      },
      instructions: INSTRUCTIONS,
    });
    this.snapshotValue = normalizeSnapshot(snapshot);
    this.widthColumns = boundedInteger(options.widthColumns, 80, MIN_WIDTH, MAX_WIDTH, 'worker inbox width');
    this.viewportRows = boundedInteger(options.viewportRows, 8, MIN_ROWS, MAX_ROWS, 'worker inbox rows');
    const selected = this.snapshotValue.selectedWorkerId;
    if (selected !== undefined) this.selectedIndex = this.snapshotValue.workers.findIndex(({ workerId }) => workerId === selected);
    this.revealSelection();
  }

  get selectedWorkerId(): string | undefined {
    return this.snapshotValue.workers[this.selectedIndex]?.workerId;
  }

  update(value: NativeWorkerInboxSnapshot): void {
    const next = normalizeSnapshot(value);
    if (next.generation < this.snapshotValue.generation) throw new Error('stale generation for worker inbox');
    if (next.generation === this.snapshotValue.generation) {
      if (JSON.stringify(next) === JSON.stringify(this.snapshotValue)) return;
      throw new Error('a worker inbox generation cannot describe different state');
    }
    const selected = this.selectedWorkerId;
    this.snapshotValue = next;
    this.selectedIndex = selected === undefined ? 0 : Math.max(0, next.workers.findIndex(({ workerId }) => workerId === selected));
    this.revealSelection();
    this.invalidate();
  }

  resize(widthColumns: number, viewportRows: number): void {
    this.widthColumns = boundedInteger(widthColumns, 80, MIN_WIDTH, MAX_WIDTH, 'worker inbox width');
    this.viewportRows = boundedInteger(viewportRows, 8, MIN_ROWS, MAX_ROWS, 'worker inbox rows');
    this.revealSelection();
    this.invalidate();
  }

  toPlainText(): string {
    const lines = [
      `Worker inbox — generation ${this.snapshotValue.generation} — ${this.snapshotValue.workers.length} workers`,
      ...this.snapshotValue.workers.map((entry, index) => `${index + 1}. ${entry.workerId} [${entry.state.toUpperCase()}] · queue ${entry.queueDepth}`),
    ];
    const selected = this.snapshotValue.workers[this.selectedIndex];
    if (selected !== undefined) lines.push(...this.actionLines(selected));
    return lines.join('\n');
  }

  protected renderRegions(): readonly WidgetRenderRegion[] {
    const end = Math.min(this.snapshotValue.workers.length, this.scrollOffset + this.viewportRows);
    const visible = this.snapshotValue.workers.slice(this.scrollOffset, end);
    const selected = this.snapshotValue.workers[this.selectedIndex];
    return [
      {
        id: 'summary',
        role: 'status',
        text: fitTerminalText(`Worker inbox · generation ${this.snapshotValue.generation} · ${this.snapshotValue.workers.length} workers`, this.widthColumns),
      },
      ...visible.map((entry, visibleIndex) => {
        const index = this.scrollOffset + visibleIndex;
        return {
          id: `worker-${entry.workerId}`,
          role: 'option' as const,
          tone: this.tone(entry),
          text: fitTerminalText(`${index === this.selectedIndex ? '>' : ' '} ${entry.workerId} [${entry.state.toUpperCase()}] · queue ${entry.queueDepth}`, this.widthColumns),
        };
      }),
      {
        id: 'actions',
        role: 'content',
        text: fitTerminalText(selected === undefined ? 'No workers to inspect.' : this.actionLines(selected).join(' · '), this.widthColumns),
      },
      { id: 'help', role: 'help', text: 'Read only first · ↑/↓ select · Enter inspect · mutations use shown generation' },
    ];
  }

  protected onInput(input: WidgetInput): WidgetInputResult<WorkerOperationsWidgetIntent> {
    if (input.type !== 'key') return { status: 'ignored' };
    if (this.snapshotValue.workers.length === 0) return { status: 'ignored' };
    const key = input.key.toLowerCase();
    if (key === 'enter' || key === 'return') {
      return {
        status: 'handled',
        output: {
          type: 'inspect',
          expectedGeneration: this.snapshotValue.generation,
          workerId: this.snapshotValue.workers[this.selectedIndex]!.workerId,
        },
      };
    }
    const previous = this.selectedIndex;
    if (key === 'arrowdown' || key === 'j') this.selectedIndex = Math.min(this.snapshotValue.workers.length - 1, this.selectedIndex + 1);
    else if (key === 'arrowup' || key === 'k') this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (key === 'home') this.selectedIndex = 0;
    else if (key === 'end') this.selectedIndex = this.snapshotValue.workers.length - 1;
    else return { status: 'ignored' };
    if (previous !== this.selectedIndex) {
      this.revealSelection();
      this.invalidate();
    }
    return { status: 'handled' };
  }

  private actionLines(entry: NativeWorkerInboxEntry): string[] {
    const prefix = `${entry.workerId} ${this.snapshotValue.generation}`;
    const lines = [`Read-only: /workers status ${prefix}`];
    if (entry.availableActions.includes('send')) lines.push(`Send: /workers send ${prefix} <message>`);
    if (entry.availableActions.includes('follow-up')) lines.push(`Follow-up: /workers follow-up ${prefix} <message>`);
    if (entry.availableActions.includes('steer')) lines.push(`Steer: /workers steer ${prefix} <message>`);
    if (entry.availableActions.includes('abort')) lines.push(`Graceful abort: /workers abort ${prefix} [reason]`);
    if (entry.forceKillAvailable) lines.push(`Force kill (approval required): /workers kill ${prefix} [reason]`);
    return lines;
  }

  private tone(entry: NativeWorkerInboxEntry): 'info' | 'success' | 'warning' | 'error' {
    if (entry.state === 'succeeded') return 'success';
    if (entry.state === 'failed' || entry.state === 'killed') return 'error';
    if (entry.state === 'aborting' || entry.state === 'killing' || entry.state === 'aborted') return 'warning';
    return 'info';
  }

  private revealSelection(): void {
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    else if (this.selectedIndex >= this.scrollOffset + this.viewportRows) this.scrollOffset = this.selectedIndex - this.viewportRows + 1;
    this.scrollOffset = Math.max(0, Math.min(Math.max(0, this.snapshotValue.workers.length - this.viewportRows), this.scrollOffset));
  }
}
