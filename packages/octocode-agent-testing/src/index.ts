import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MockPiMode = 'tui' | 'rpc' | 'json' | 'print';

export interface MockToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface MockToolDefinition {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    context?: MockPiContext,
  ): Promise<unknown>;
  [key: string]: unknown;
}

export interface MockCommandDefinition {
  description?: string;
  handler(args: string, context: MockPiCommandContext): void | Promise<void>;
  [key: string]: unknown;
}

export interface MockSessionState {
  id: string;
  file: string;
  name?: string;
  generation: number;
  parentId?: string;
  leafId: string;
}

export interface MockPiContext {
  cwd: string;
  hasUI: boolean;
  mode: MockPiMode;
  ui: MockPiUi;
  sessionManager: MockSessionManager;
  isProjectTrusted(): boolean;
  compact(options: { customInstructions?: string; onComplete?(result?: unknown): void; onError?(error: Error): void }): void;
  getContextUsage(): { tokens: number | null; contextWindow: number };
  [key: string]: unknown;
}

export interface MockPiCommandContext extends MockPiContext {
  sendUserMessage(content: unknown, options?: Record<string, unknown>): void;
  newSession(options?: { withSession?(context: MockPiCommandContext): Promise<void> }): Promise<{ cancelled?: boolean }>;
  fork(entryId: string, options?: { withSession?(context: MockPiCommandContext): Promise<void> }): Promise<{ cancelled?: boolean }>;
  reload(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface MockSessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string;
  getSessionName(): string | undefined;
  getLeafId(): string;
  getBranch(): unknown[];
  getEntries(): unknown[];
}

export interface MockPiUi {
  notify(message: string, level?: string): void;
  confirm(title: string, message: string, options?: unknown): Promise<boolean>;
  select(title: string, items: string[], options?: unknown): Promise<string | undefined>;
  input(title: string, placeholder?: string, options?: unknown): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  custom<T>(factory: unknown, options?: unknown): Promise<T | undefined>;
  setHiddenThinkingLabel(label: string): void;
  setStatus(name: string, text: string | undefined): void;
  setWidget(name: string, content: unknown, options?: unknown): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(indicator?: unknown): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  pasteToEditor(text: string): void;
}

export type FlowEventKind =
  | 'agent.response'
  | 'browser.opened'
  | 'browser.request'
  | 'browser.response'
  | 'command.finished'
  | 'command.expanded'
  | 'command.registered'
  | 'command.started'
  | 'context.compacted'
  | 'event.emitted'
  | 'event.handled'
  | 'handler.registered'
  | 'message.custom'
  | 'message.user'
  | 'session.forked'
  | 'session.new'
  | 'session.restarted'
  | 'session.started'
  | 'session.tree'
  | 'state.changed'
  | 'tool.finished'
  | 'tool.registered'
  | 'tool.started'
  | 'tool.updated'
  | 'ui.dialog'
  | 'ui.editor'
  | 'ui.footer'
  | 'ui.header'
  | 'ui.notification'
  | 'ui.status'
  | 'ui.title'
  | 'ui.widget'
  | 'ui.working-indicator'
  | 'ui.working-message'
  | 'ui.working-visible';

export interface FlowEvent<T = unknown> {
  sequence: number;
  timestamp: number;
  kind: FlowEventKind;
  data: T;
}

export interface BrowserResponse {
  action: string;
  payload?: unknown;
}

export interface BrowserMessageRequest {
  url: string;
  message: string;
  origin?: string;
  contentType?: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface BrowserMessageResult {
  status: number;
  body: string;
}

export interface NormalizedFlowEvent {
  sequence: number;
  kind: FlowEventKind;
  data: unknown;
}

export interface IsolatedAwarenessContext<T> {
  root: string;
  workspace: string;
  dbPath: string;
  store: T;
  cleanup(): Promise<void>;
}

export type AwarenessStoreFactory<T> = (options: { workspace: string; dbPath: string }) => T | Promise<T>;

export interface ScriptedFlowResponses {
  confirms?: boolean[];
  selects?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  editors?: Array<string | undefined>;
  customs?: unknown[];
  agents?: unknown[];
  browsers?: BrowserResponse[];
}

export interface CustomInteractionScript {
  inputs: string[];
  focus?: boolean;
}

export interface PiFlowHarnessOptions {
  cwd?: string;
  hasUI?: boolean;
  mode?: MockPiMode;
  trusted?: boolean;
  sessionId?: string;
  contextTokens?: number | null;
  contextWindow?: number;
  now?: () => number;
  scripted?: ScriptedFlowResponses;
}

export interface RunToolOptions {
  id?: string;
  signal?: AbortSignal;
  onUpdate?: (update: unknown) => void;
  context?: MockPiContext;
}

export interface MockPiHost {
  registerTool(definition: MockToolDefinition): void;
  registerCommand(name: string, definition: MockCommandDefinition): void;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  sendUserMessage(content: unknown, options?: Record<string, unknown>): void;
  sendMessage(message: unknown, options?: Record<string, unknown>): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data?: unknown): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
}

type EventHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type QueueName = keyof ScriptedFlowResponses;

function cloneScript(scripted: ScriptedFlowResponses | undefined): Required<ScriptedFlowResponses> {
  return {
    confirms: [...(scripted?.confirms ?? [])],
    selects: [...(scripted?.selects ?? [])],
    inputs: [...(scripted?.inputs ?? [])],
    editors: [...(scripted?.editors ?? [])],
    customs: [...(scripted?.customs ?? [])],
    agents: [...(scripted?.agents ?? [])],
    browsers: [...(scripted?.browsers ?? [])],
  };
}

export class PiFlowHarness {
  readonly events: FlowEvent[] = [];
  readonly tools = new Map<string, MockToolDefinition>();
  readonly commands = new Map<string, MockCommandDefinition>();
  readonly durable = new Map<string, unknown>();
  readonly entries: unknown[] = [];
  readonly handlers = new Map<string, EventHandler[]>();
  readonly pi: MockPiHost;
  readonly ui: MockPiUi;
  context: MockPiCommandContext;
  session: MockSessionState;

  private readonly cwd: string;
  private readonly hasUI: boolean;
  private readonly mode: MockPiMode;
  private readonly trusted: boolean;
  private readonly contextTokens: number | null;
  private readonly contextWindow: number;
  private readonly clock: () => number;
  private readonly scripted: Required<ScriptedFlowResponses>;
  private activeTools: string[] = [];
  private sequence = 0;
  private toolSequence = 0;
  private editorText = '';
  private pendingPromptExpansions: Promise<void>[] = [];

  constructor(options: PiFlowHarnessOptions = {}) {
    this.cwd = options.cwd ?? '/workspace';
    this.hasUI = options.hasUI ?? true;
    this.mode = options.mode ?? 'tui';
    this.trusted = options.trusted ?? true;
    this.contextTokens = options.contextTokens ?? null;
    this.contextWindow = options.contextWindow ?? 200_000;
    let tick = 0;
    this.clock = options.now ?? (() => ++tick);
    this.scripted = cloneScript(options.scripted);
    const sessionId = options.sessionId ?? 'session-1';
    this.session = this.makeSession(sessionId, 0);
    this.ui = this.makeUi();
    this.context = this.makeContext();
    this.pi = this.makeHost();
    this.record('session.started', { ...this.session });
  }

  script<K extends QueueName>(queue: K, ...values: Required<ScriptedFlowResponses>[K]): void {
    this.scripted[queue].push(...values as never[]);
  }

  recordState(name: string, value: unknown): void {
    this.record('state.changed', { name, value });
  }

  eventsOf<T = unknown>(kind: FlowEventKind): Array<FlowEvent<T>> {
    return this.events.filter((event) => event.kind === kind) as Array<FlowEvent<T>>;
  }

  last<T = unknown>(kind: FlowEventKind): FlowEvent<T> | undefined {
    return this.eventsOf<T>(kind).at(-1);
  }

  assertSequence(expected: FlowEventKind[]): void {
    const actual = this.events.map((event) => event.kind);
    let cursor = 0;
    for (const kind of actual) {
      if (kind === expected[cursor]) cursor += 1;
    }
    if (cursor !== expected.length) {
      throw new Error(`Flow sequence not observed. Expected subsequence: ${expected.join(' -> ')}\nActual: ${actual.join(' -> ')}`);
    }
  }

  async emit(event: string, payload: unknown = {}): Promise<unknown[]> {
    this.record('event.emitted', { event, payload });
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) {
      const result = await handler(payload, this.context);
      results.push(result);
      this.record('event.handled', { event, result });
    }
    return results;
  }

  async runTool(name: string, params: Record<string, unknown>, options: RunToolOptions = {}): Promise<unknown> {
    const definition = this.tools.get(name);
    if (!definition) throw new Error(`Unknown mocked Pi tool: ${name}`);
    const id = options.id ?? `tool-${++this.toolSequence}`;
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw signal.reason ?? new Error('Tool call aborted');
    const blocked = await this.emit('tool_call', { toolCallId: id, toolName: name, input: params });
    const block = blocked.find((value) => Boolean((value as { block?: boolean } | undefined)?.block));
    if (block) throw new Error((block as { reason?: string }).reason ?? `Tool ${name} blocked`);
    await this.emit('tool_execution_start', { toolCallId: id, toolName: name, args: params });
    this.record('tool.started', { id, name, params });
    try {
      const result = await definition.execute(id, params, signal, (update) => {
        this.record('tool.updated', { id, name, update });
        options.onUpdate?.(update);
      }, options.context ?? this.context);
      this.record('tool.finished', { id, name, result, isError: false });
      await this.emit('tool_execution_end', { toolCallId: id, toolName: name, result, isError: false });
      return result;
    } catch (error) {
      this.record('tool.finished', { id, name, error, isError: true });
      await this.emit('tool_execution_end', { toolCallId: id, toolName: name, result: error, isError: true });
      throw error;
    }
  }

  async runCommand(name: string, args = ''): Promise<void> {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Unknown mocked Pi command: ${name}`);
    this.record('command.started', { name, args });
    await command.handler(args, this.context);
    this.record('command.finished', { name, args });
  }

  /** Expand a Pi prompt, executing registered slash commands through their handler. */
  async expandPrompt(prompt: string): Promise<'command' | 'message'> {
    const normalized = prompt.replace(/\r\n?/g, '\n').trim();
    const commandMatch = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(normalized);
    const name = commandMatch?.[1];
    if (name && this.commands.has(name)) {
      const args = commandMatch?.[2] ?? '';
      this.record('command.expanded', { prompt: normalized, name, args });
      await this.runCommand(name, args);
      return 'command';
    }
    this.pi.sendUserMessage(normalized);
    return 'message';
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingPromptExpansions.length > 0) {
      await Promise.all(this.pendingPromptExpansions.splice(0));
    }
  }

  nextAgentResponse<T = unknown>(): T {
    const response = this.shift('agents', 'agent response') as T;
    this.record('agent.response', { response });
    return response;
  }

  async openBrowser(url: string): Promise<BrowserResponse> {
    this.record('browser.opened', { url });
    const response = this.shift('browsers', 'browser response') as BrowserResponse;
    this.record('browser.response', { url, response });
    return response;
  }

  /** POST browser feedback through the production loopback HTTP bridge. */
  async postBrowserMessage(request: BrowserMessageRequest): Promise<BrowserMessageResult> {
    const pageUrl = new URL(request.url);
    const base = pageUrl.href.endsWith('/') ? pageUrl : new URL(`${pageUrl.href}/`);
    const endpoint = new URL('__octocode/message', base);
    const origin = request.origin ?? pageUrl.origin;
    this.record('browser.request', {
      endpoint: endpoint.href,
      message: request.message,
      origin,
      contentType: request.contentType ?? 'application/json',
      method: request.method ?? 'POST',
    });
    const method = request.method ?? 'POST';
    const response = await fetch(endpoint, {
      method,
      headers: {
        origin,
        'content-type': request.contentType ?? 'application/json',
        ...request.headers,
      },
      body: method === 'POST' ? JSON.stringify({ message: request.message }) : undefined,
    });
    const result = { status: response.status, body: await response.text() };
    this.record('browser.response', { endpoint: endpoint.href, response: result });
    await this.waitForIdle();
    return result;
  }

  normalizedTranscript(): NormalizedFlowEvent[] {
    return this.events.map(({ sequence, kind, data }) => ({
      sequence,
      kind,
      data: normalizeTranscriptValue(data, this.cwd),
    }));
  }

  async restart(reason = 'resume'): Promise<void> {
    await this.emit('session_shutdown', { reason: 'reload' });
    this.session = this.makeSession(this.session.id, this.session.generation + 1, this.session.parentId);
    this.context = this.makeContext();
    this.record('session.restarted', { reason, session: { ...this.session } });
    await this.emit('session_start', { reason, previousSessionFile: this.session.file });
  }

  async newSession(): Promise<void> {
    await this.emit('session_shutdown', { reason: 'new' });
    const previousId = this.session.id;
    this.session = this.makeSession(`session-${this.session.generation + 2}`, this.session.generation + 1, previousId);
    this.context = this.makeContext();
    this.record('session.new', { previousId, session: { ...this.session } });
    await this.emit('session_start', { reason: 'new' });
  }

  async tree(entryId = this.session.leafId): Promise<void> {
    const before = await this.emit('session_before_tree', { entryId });
    if (before.some((value) => Boolean((value as { cancel?: boolean } | undefined)?.cancel))) return;
    this.session = this.makeSession(this.session.id, this.session.generation + 1, this.session.parentId);
    this.context = this.makeContext();
    this.record('session.tree', { entryId, session: { ...this.session } });
    await this.emit('session_tree', { entryId });
  }

  async fork(entryId = this.session.leafId): Promise<void> {
    const before = await this.emit('session_before_fork', { entryId, position: 'at' });
    if (before.some((value) => Boolean((value as { cancel?: boolean } | undefined)?.cancel))) return;
    const parentId = this.session.id;
    const nextId = `${parentId}-fork-${this.session.generation + 1}`;
    this.session = this.makeSession(nextId, this.session.generation + 1, parentId);
    this.context = this.makeContext();
    this.record('session.forked', { entryId, session: { ...this.session } });
    await this.emit('session_start', { reason: 'fork' });
  }

  private makeSession(id: string, generation: number, parentId?: string): MockSessionState {
    return {
      id,
      file: `${this.cwd}/.pi/sessions/${id}.jsonl`,
      generation,
      ...(parentId ? { parentId } : {}),
      leafId: `${id}:leaf`,
    };
  }

  private makeSessionManager(): MockSessionManager {
    return {
      getCwd: () => this.cwd,
      getSessionDir: () => `${this.cwd}/.pi/sessions`,
      getSessionId: () => this.session.id,
      getSessionFile: () => this.session.file,
      getSessionName: () => this.session.name,
      getLeafId: () => this.session.leafId,
      getBranch: () => [...this.entries],
      getEntries: () => [...this.entries],
    };
  }

  private makeContext(): MockPiCommandContext {
    const base: MockPiCommandContext = {
      cwd: this.cwd,
      hasUI: this.hasUI,
      mode: this.mode,
      ui: this.ui,
      sessionManager: this.makeSessionManager(),
      isProjectTrusted: () => this.trusted,
      getContextUsage: () => ({ tokens: this.contextTokens, contextWindow: this.contextWindow }),
      compact: (options) => {
        this.record('context.compacted', { instructions: options.customInstructions });
        options.onComplete?.({ compacted: true });
      },
      sendUserMessage: (content, options) => this.pi.sendUserMessage(content, options),
      newSession: async (options) => {
        await this.newSession();
        await options?.withSession?.(this.context);
        return {};
      },
      fork: async (entryId, options) => {
        await this.fork(entryId);
        await options?.withSession?.(this.context);
        return {};
      },
      reload: async () => this.restart('reload'),
      waitForIdle: async () => this.waitForIdle(),
    };
    return base;
  }

  private makeHost(): MockPiHost {
    return {
      registerTool: (definition) => {
        if (this.tools.has(definition.name)) throw new Error(`Duplicate mocked Pi tool: ${definition.name}`);
        this.tools.set(definition.name, definition);
        this.record('tool.registered', { name: definition.name });
      },
      registerCommand: (name, definition) => {
        if (this.commands.has(name)) throw new Error(`Duplicate mocked Pi command: ${name}`);
        this.commands.set(name, definition);
        this.record('command.registered', { name });
      },
      on: (event, handler) => {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
        this.record('handler.registered', { event });
      },
      sendUserMessage: (content, options) => {
        this.record('message.user', { content, options });
        if (typeof content === 'string' && options?.['expandPromptTemplates'] === true) {
          const pending = this.expandPrompt(content).then(() => undefined);
          this.pendingPromptExpansions.push(pending);
        }
      },
      sendMessage: (message, options) => this.record('message.custom', { message, options }),
      getActiveTools: () => [...this.activeTools],
      setActiveTools: (names) => { this.activeTools = [...names]; },
      appendEntry: (customType, data) => { this.entries.push({ type: 'custom', customType, data }); },
      setSessionName: (name) => { this.session.name = name; },
      getSessionName: () => this.session.name,
    };
  }

  private makeUi(): MockPiUi {
    return {
      notify: (message, level) => this.record('ui.notification', { message, level }),
      confirm: async (title, message) => this.dialog('confirm', title, { message }, this.shift('confirms', 'confirm response') as boolean),
      select: async (title, items) => this.dialog('select', title, { items }, this.shift('selects', 'select response') as string | undefined),
      input: async (title, placeholder) => this.dialog('input', title, { placeholder }, this.shift('inputs', 'input response') as string | undefined),
      editor: async (title, prefill) => this.dialog('editor', title, { prefill }, this.shift('editors', 'editor response') as string | undefined),
      custom: async <T>(factory: unknown, options?: unknown) => {
        const scripted = this.shift('customs', 'custom response');
        if (isCustomInteractionScript(scripted) && typeof factory === 'function') {
          const response = await new Promise<T | undefined>((resolve) => {
            const component = (factory as (
              tui: unknown,
              theme: unknown,
              keybindings: unknown,
              done: (value: T | undefined) => void,
            ) => { focused?: boolean; handleInput(data: string): void })(
              { requestRender: () => undefined }, undefined, undefined, resolve,
            );
            if (scripted.focus !== false) component.focused = true;
            for (const input of scripted.inputs) component.handleInput(input);
          });
          return this.dialog('custom', 'custom', { options, inputs: scripted.inputs }, response);
        }
        return this.dialog('custom', 'custom', { options }, scripted as T | undefined);
      },
      setHiddenThinkingLabel: (label) => this.record('ui.status', { name: 'hidden-thinking', text: label }),
      setStatus: (name, text) => this.record('ui.status', { name, text }),
      setWidget: (name, content, options) => this.record('ui.widget', { name, content, options }),
      setFooter: (factory) => this.record('ui.footer', { factory }),
      setHeader: (factory) => this.record('ui.header', { factory }),
      setTitle: (title) => this.record('ui.title', { title }),
      setWorkingMessage: (message) => this.record('ui.working-message', { message }),
      setWorkingVisible: (visible) => this.record('ui.working-visible', { visible }),
      setWorkingIndicator: (indicator) => this.record('ui.working-indicator', { indicator }),
      setEditorText: (text) => { this.editorText = text; this.record('ui.editor', { action: 'set', text }); },
      getEditorText: () => this.editorText,
      pasteToEditor: (text) => { this.editorText += text; this.record('ui.editor', { action: 'paste', text }); },
    };
  }

  private dialog<T>(dialog: string, title: string, request: unknown, response: T): T {
    this.record('ui.dialog', { dialog, title, request, response });
    return response;
  }

  private shift(queue: QueueName, label: string): unknown {
    const values = this.scripted[queue] as unknown[];
    if (values.length === 0) throw new Error(`No scripted ${label} remains`);
    return values.shift();
  }

  private record(kind: FlowEventKind, data: unknown): void {
    this.events.push({ sequence: ++this.sequence, timestamp: this.clock(), kind, data });
  }
}

function isCustomInteractionScript(value: unknown): value is CustomInteractionScript {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { inputs?: unknown }).inputs));
}

export function createPiFlowHarness(options: PiFlowHarnessOptions = {}): PiFlowHarness {
  return new PiFlowHarness(options);
}

/** Instantiate a real Awareness store against a disposable SQLite path. */
export async function createIsolatedAwarenessStore<T>(
  factory: AwarenessStoreFactory<T>,
  options: { prefix?: string; close?: (store: T) => void | Promise<void> } = {},
): Promise<IsolatedAwarenessContext<T>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'octocode-awareness-flow-'));
  const workspace = path.join(root, 'workspace');
  const dbPath = path.join(root, 'awareness.sqlite3');
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const store = await factory({ workspace, dbPath });
    let cleaned = false;
    return {
      root,
      workspace,
      dbPath,
      store,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await options.close?.(store);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function normalizeTranscriptValue(value: unknown, cwd: string): unknown {
  if (typeof value === 'string') return value.split(cwd).join('<workspace>');
  if (value instanceof Error) return { name: value.name, message: normalizeTranscriptValue(value.message, cwd) };
  if (Array.isArray(value)) return value.map((item) => normalizeTranscriptValue(item, cwd));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeTranscriptValue(item, cwd)]));
  }
  return value;
}
