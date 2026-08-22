import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createOctocodeShell } from '../src/shell/index.js';
import type {
  ShellRuntime,
  ShellSession,
  ShellSessionEvent,
  ShellUi,
} from '../src/shell/index.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** Event-emitting AgentSession stand-in with a prompt/abort spy. */
class FakeSession implements ShellSession {
  isStreaming = false;
  readonly prompted: string[] = [];
  abortCalls = 0;

  private listeners: ((event: ShellSessionEvent) => void)[] = [];

  async prompt(text: string): Promise<void> {
    this.prompted.push(text);
  }

  subscribe(listener: (event: ShellSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  /** Test helper: drive an event through the shell's subscription. */
  emit(event: ShellSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

class FakeRuntime implements ShellRuntime {
  readonly session = new FakeSession();
}

/** Headless ShellUi that records output and exposes submit/abort triggers. */
class FakeUi implements ShellUi {
  readonly lines: string[] = [];
  deltas = '';
  started = false;
  stopped = false;

  private submitHandler?: (text: string) => void | Promise<void>;
  private abortHandler?: () => void;

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
  print(line: string): void {
    this.lines.push(line);
  }
  appendDelta(text: string): void {
    this.deltas += text;
  }
  onSubmit(handler: (text: string) => void | Promise<void>): void {
    this.submitHandler = handler;
  }
  onAbort(handler: () => void): void {
    this.abortHandler = handler;
  }

  /** Test helper: simulate an editor submission. */
  async submit(text: string): Promise<void> {
    await this.submitHandler?.(text);
  }

  /** Test helper: simulate Escape / Ctrl+C. */
  abort(): void {
    this.abortHandler?.();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('emits the branded banner on startup', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui, version: '1.4.0' });

  const done = shell.run();
  // Banner is printed synchronously during run() before it awaits quit.
  assert.ok(ui.started, 'ui.start() must be called');
  // The banner's brand identity is the OCTOCODE block art (the redundant
  // text wordmark line was removed) — assert the art, version, and tagline.
  assert.ok(
    ui.lines.some((l) => l.includes('██████╗')),
    `banner should render the OCTOCODE block art, got: ${JSON.stringify(ui.lines)}`,
  );
  assert.ok(ui.lines.some((l) => l.includes('v1.4.0')), 'banner shows the version');
  assert.ok(ui.lines.some((l) => l.includes('Your AI coding agent')), 'banner shows the tagline');

  await ui.submit('/quit');
  assert.equal(await done, 0);
});

test('submitted prompt reaches session.prompt', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  await ui.submit('hello world');

  assert.deepEqual(runtime.session.prompted, ['hello world']);
  assert.ok(
    ui.lines.some((l) => l.includes('hello world')),
    'user input should be echoed to the transcript',
  );

  await ui.submit('exit');
  await done;
});

test('renders streamed text and thinking blocks from runtime events', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();

  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_start' },
  });
  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'checking facts' },
  });
  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_end' },
  });
  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello, ' },
  });
  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'world!' },
  });

  assert.ok(ui.lines.some((l) => l.includes('thinking')), 'thinking block should be visible');
  assert.ok(ui.deltas.includes('checking facts'), 'thinking deltas should stream instead of being dropped');
  assert.ok(ui.deltas.includes('Hello, world!'), 'text deltas should still stream');

  await ui.submit('/quit');
  await done;
});

test('renders modern tool call, update, and response rows', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  runtime.session.emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1', args: { command: 'echo ok' } });
  runtime.session.emit({ type: 'tool_execution_update', toolName: 'bash', toolCallId: 't1', partialResult: { stdout: 'ok' } });
  runtime.session.emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 't1', result: { exitCode: 0 } });

  assert.ok(ui.lines.some((l) => l.includes('bash') && l.includes('running')), 'tool start should mention the running tool');
  assert.ok(ui.lines.some((l) => l.includes('stdout')), 'tool update should show a compact payload');
  assert.ok(ui.lines.some((l) => l.includes('✓') && l.includes('bash')), 'tool completion should show success');

  await ui.submit('/quit');
  await done;
});

test('Escape / Ctrl+C aborts the current operation', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  ui.abort();
  // abort() is fire-and-forget inside the handler; allow the microtask to run.
  await Promise.resolve();

  assert.equal(runtime.session.abortCalls, 1);

  await ui.submit('/quit');
  await done;
});

test('quit path resolves and tears down the subscription + ui', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  assert.equal(runtime.session.listenerCount, 1, 'shell must subscribe on run');

  await ui.submit('/quit');
  assert.equal(await done, 0);
  assert.ok(ui.stopped, 'ui.stop() must be called on quit');
  assert.equal(runtime.session.listenerCount, 0, 'shell must unsubscribe on quit');
});

test('blank submissions are ignored (no prompt, no quit)', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  await ui.submit('   ');

  assert.deepEqual(runtime.session.prompted, []);

  await ui.submit('/quit');
  await done;
});

test('slash command help is handled locally', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  await ui.submit('/help');

  assert.deepEqual(runtime.session.prompted, []);
  assert.ok(ui.lines.some((l) => l.includes('OctocodeShell commands')));
  assert.ok(ui.lines.some((l) => l.includes('/quit')));

  await ui.submit('/quit');
  await done;
});

test('unknown slash commands are rejected locally', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  await ui.submit('/not-a-command');

  assert.deepEqual(runtime.session.prompted, []);
  assert.ok(ui.lines.some((l) => l.includes('unknown command: /not-a-command')));

  await ui.submit('/quit');
  await done;
});
