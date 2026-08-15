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
  assert.ok(
    ui.lines.some((l) => l.includes('Octocode')),
    `banner should mention Octocode, got: ${JSON.stringify(ui.lines)}`,
  );

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

test('renders streamed text deltas from runtime events', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();

  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello, ' },
  });
  runtime.session.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'world!' },
  });

  assert.equal(ui.deltas, 'Hello, world!');

  await ui.submit('/quit');
  await done;
});

test('renders a tool-call notification', async () => {
  const runtime = new FakeRuntime();
  const ui = new FakeUi();
  const shell = createOctocodeShell(runtime, { ui });

  const done = shell.run();
  runtime.session.emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1' });

  assert.ok(
    ui.lines.some((l) => l.includes('bash')),
    'tool notification should mention the tool name',
  );

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
