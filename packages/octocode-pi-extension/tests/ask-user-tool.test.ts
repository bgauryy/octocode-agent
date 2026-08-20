import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Type } from 'typebox';
import { registerAskUserTool } from '../src/tools/ask-user-tool.js';
import type { PiContext, ToolDefinition } from '../src/types.js';

function loadTool(): ToolDefinition {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (d: ToolDefinition) => tools.set(d.name, d) };
  registerAskUserTool(pi, Type, new Set<string>(), (p, names, def) => {
    names.add(def.name);
    p.registerTool?.(def);
  });
  return tools.get('askUser')!;
}

function belowEditorCtx() {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const widgets: Array<{ name: string; content: unknown; opts?: { placement?: string } }> = [];
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      setWidget: (name: string, content: unknown, opts?: { placement?: string }) => {
        widgets.push({ name, content, opts });
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
        inputHandler = handler;
        return () => {
          inputHandler = undefined;
        };
      },
    },
  } as unknown as PiContext;
  return {
    ctx,
    widgets,
    send: (data: string) => inputHandler?.(data),
  };
}

test('askUser registration teaches option lists, concise labels, and inline fallback', () => {
  const tool = loadTool();

  assert.equal(tool.name, 'askUser');
  assert.match(tool.description, /keyboard-navigable list/);
  assert.match(tool.description, /custom free-text answer row is always included/);
  assert.match(tool.description, /non-interactive hosts/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /reply 1\/2\/3/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /safe default first/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /custom free-text answer row/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /fall back to asking the question directly/);
});

test('askUser validates that a non-empty question is required', async () => {
  const tool = loadTool();
  const result = await tool.execute('id', { question: '   ' });

  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /question is required/);
});

test('askUser returns an inline-question instruction when no interactive UI is available', async () => {
  const tool = loadTool();
  const result = await tool.execute(
    'id',
    {
      question: 'Choose a strategy?',
      options: [
        { value: 'safe', label: 'Safe', description: 'Recommended' },
        { value: 'fast', label: 'Fast' },
      ],
    },
    undefined,
    undefined,
    { mode: 'rpc', hasUI: false } as PiContext,
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content[0]!.text, /No interactive UI available \(mode=rpc\)/);
  assert.match(result.content[0]!.text, /Ask the user this question directly/);
  assert.match(result.content[0]!.text, /Safe, Fast/);
  assert.deepEqual(result.details, { status: 'unavailable', mode: 'rpc' });
});

test('askUser refuses editor-replacing native selector when below-editor input is unavailable', async () => {
  const tool = loadTool();
  const selectCalls: Array<{ title: string; items: string[] }> = [];
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      select: async (title: string, items: string[]) => {
        selectCalls.push({ title, items });
        return 'safe';
      },
      custom: async () => {
        throw new Error('custom overlay should not be used for askUser fallback');
      },
    },
  } as unknown as PiContext;

  const result = await tool.execute(
    'id',
    {
      question: 'Choose a strategy?',
      options: ['safe', 'fast'],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(selectCalls, [], 'askUser must not call Pi native select because it replaces the input area');
  assert.match(result.content[0]!.text, /No interactive UI available \(mode=tui\)/);
  assert.match(result.content[0]!.text, /safe, fast/);
  assert.deepEqual(result.details, { status: 'unavailable', mode: 'tui' });
});

test('askUser renders choices as a below-editor widget when terminal input capture is available', async () => {
  const tool = loadTool();
  const { ctx, widgets, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Choose a strategy?',
      options: ['safe', 'fast'],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(widgets.at(-1)?.name, 'octocode-ask-user');
  assert.equal(widgets.at(-1)?.opts?.placement, 'belowEditor');
  const rendererFactory = widgets.at(-1)?.content as (_tui: unknown, theme: undefined) => { render(width?: number): string[] };
  const lines = rendererFactory(undefined, undefined).render(100);
  assert.match(lines.join('\n'), /USER INPUT REQUIRED/);
  assert.match(lines.join('\n'), /Question: Choose a strategy\?/);
  assert.match(lines.join('\n'), /Type my own answer/);
  assert.equal(send('\r')?.consume, true);
  const result = await pending;

  assert.equal(widgets.at(-1)?.content, undefined, 'askUser widget is cleared after selection');
  assert.match(result.content[0]!.text, /User selected: safe/);
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
});

test('askUser option picker always allows a custom free-text answer without allowFreeText', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Choose a strategy?',
      options: ['safe', 'fast'],
    },
    undefined,
    undefined,
    ctx,
  );

  send('\x1b[B');
  send('\x1b[B');
  send('\r');
  send('custom plan');
  send('\r');
  const result = await pending;

  assert.match(result.content[0]!.text, /User answered: custom plan/);
  assert.deepEqual(result.details, { status: 'text', value: 'custom plan' });
});

test('askUser refuses custom overlay picker when below-editor input is unavailable', async () => {
  const tool = loadTool();
  let customCalled = false;
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      select: async () => {
        throw new Error('native selector should not be used for described choices');
      },
      custom: async () => {
        customCalled = true;
        return 'safe';
      },
    },
  } as unknown as PiContext;

  const result = await tool.execute(
    'id',
    {
      question: 'Choose a strategy?',
      options: [
        { value: 'safe', label: 'Safe', description: 'Recommended' },
        { value: 'fast', label: 'Fast' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(customCalled, false, 'askUser must not call Pi custom overlays because they can render above the input');
  assert.match(result.content[0]!.text, /No interactive UI available \(mode=tui\)/);
  assert.deepEqual(result.details, { status: 'unavailable', mode: 'tui' });
});

test('askUser refuses editor-replacing input hook when below-editor input is unavailable', async () => {
  const tool = loadTool();
  const prompts: string[] = [];
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      custom: () => undefined,
      input: async (question: string) => {
        prompts.push(question);
        return 'typed answer';
      },
    },
  } as unknown as PiContext;

  const result = await tool.execute('id', { question: 'What should we do?' }, undefined, undefined, ctx);

  assert.deepEqual(prompts, [], 'askUser must not call Pi input because it replaces the input area');
  assert.match(result.content[0]!.text, /No interactive UI available \(mode=tui\)/);
  assert.deepEqual(result.details, { status: 'unavailable', mode: 'tui' });
});

test('askUser echoes the question in the selected result (durable context after compaction)', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();
  const pending = tool.execute(
    'id',
    { question: 'Choose a strategy?', options: [{ value: 'safe', label: 'Safe' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\r');
  const result = await pending;
  assert.match(result.content[0]!.text, /Choose a strategy\?/);
  assert.match(result.content[0]!.text, /User selected: Safe/);
});

test('askUser echoes the question in free-text and cancelled results', async () => {
  const tool = loadTool();
  const answeredHarness = belowEditorCtx();
  const answeredPending = tool.execute(
    'id',
    { question: 'What should we do?' },
    undefined,
    undefined,
    answeredHarness.ctx,
  );
  answeredHarness.send('ship it');
  answeredHarness.send('\r');
  const answered = await answeredPending;
  assert.match(answered.content[0]!.text, /What should we do\?/);
  assert.match(answered.content[0]!.text, /User answered: ship it/);

  const cancelledHarness = belowEditorCtx();
  const cancelledPending = tool.execute(
    'id',
    { question: 'Pick one?', options: [{ value: 'a' }] },
    undefined,
    undefined,
    cancelledHarness.ctx,
  );
  cancelledHarness.send('\x1b');
  const cancelled = await cancelledPending;
  assert.match(cancelled.content[0]!.text, /Pick one\?/);
  assert.match(cancelled.content[0]!.text, /cancelled/i);
});

test('askUser schema gains preview, multiSelect, min/max, and fields additively', () => {
  const tool = loadTool();
  const params = tool.parameters as {
    properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
  };

  assert.ok(params.properties['multiSelect'], 'multiSelect input exists');
  assert.ok(params.properties['min'], 'min input exists');
  assert.ok(params.properties['max'], 'max input exists');
  assert.ok(params.properties['options']!.items?.properties?.['preview'], 'options gain preview');
  const fieldProps = params.properties['fields']!.items?.properties ?? {};
  assert.deepEqual(Object.keys(fieldProps).sort(), ['label', 'name', 'placeholder', 'required']);
});

test('askUser multiSelect returns multiSelected values through the below-editor widget', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Pick strategies?',
      multiSelect: true,
      min: 1,
      max: 2,
      options: [
        { value: 'safe', label: 'Safe', preview: 'diff --git a b' },
        { value: 'fast', label: 'Fast' },
        { value: 'risky' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  send(' ');
  send('\x1b[B');
  send(' ');
  send('\r');
  const result = await pending;

  assert.match(result.content[0]!.text, /Pick strategies\?/);
  assert.match(result.content[0]!.text, /User selected 2 options: Safe, Fast/);
  assert.deepEqual(result.details, { status: 'multiSelected', values: ['safe', 'fast'] });
});

test('askUser multiSelect custom answer row bypasses min/max option validation', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    { question: 'Pick some?', multiSelect: true, min: 1, options: [{ value: 'a' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\x1b[B');
  send('\r');
  send('something else');
  send('\r');
  const result = await pending;

  assert.match(result.content[0]!.text, /User answered: something else/);
  assert.deepEqual(result.details, { status: 'text', value: 'something else' });
});

test('askUser multiSelect reports cancellation when the below-editor widget is dismissed', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    { question: 'Pick some?', multiSelect: true, options: [{ value: 'a' }, { value: 'b' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\x1b');
  const result = await pending;

  assert.match(result.content[0]!.text, /Pick some\?/);
  assert.match(result.content[0]!.text, /cancelled/i);
  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser previewed options route through the below-editor widget, not the native selector', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    { question: 'Choose?', options: [{ value: 'safe', preview: 'preview body' }, { value: 'fast' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
});

test('askUser form collects fields in order via the below-editor widget', async () => {
  const tool = loadTool();
  const { ctx, widgets, send } = belowEditorCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'New profile',
      fields: [
        { name: 'name', label: 'Full name' },
        { name: 'email', label: 'Email', placeholder: 'you@host' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  send('Guy');
  send('\r');
  send('guy@example.com');
  send('\r');
  const result = await pending;

  assert.equal(widgets.at(0)?.opts?.placement, 'belowEditor');
  assert.match(result.content[0]!.text, /New profile/);
  assert.match(result.content[0]!.text, /name: Guy/);
  assert.match(result.content[0]!.text, /email: guy@example.com/);
  assert.deepEqual(result.details, { status: 'form', values: { name: 'Guy', email: 'guy@example.com' } });
});

test('askUser form re-prompts required fields once, then rejects when still empty', async () => {
  const tool = loadTool();

  // Re-prompt succeeds on the second try.
  const okHarness = belowEditorCtx();
  const okPending = loadTool().execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name', label: 'Name', required: true }] },
    undefined,
    undefined,
    okHarness.ctx,
  );
  okHarness.send('\r');
  okHarness.send('Guy');
  okHarness.send('\r');
  const okResult = await okPending;
  assert.deepEqual(okResult.details, { status: 'form', values: { name: 'Guy' } });

  // Still empty after the re-prompt → rejected as cancelled with the field named.
  const rejectedHarness = belowEditorCtx();
  const rejectedPending = tool.execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name', label: 'Name', required: true }] },
    undefined,
    undefined,
    rejectedHarness.ctx,
  );
  rejectedHarness.send('\r');
  rejectedHarness.send('   ');
  rejectedHarness.send('\r');
  const rejected = await rejectedPending;
  assert.match(rejected.content[0]!.text, /Required field "Name" was left empty/);
  assert.deepEqual(rejected.details, { status: 'cancelled', label: 'Name' });
});

test('askUser form cancels when the user escapes any prompt', async () => {
  const tool = loadTool();
  const { ctx, send } = belowEditorCtx();
  const pending = tool.execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name' }, { name: 'email' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\x1b');
  const result = await pending;
  assert.match(result.content[0]!.text, /cancelled/i);
  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser multiSelect and form degrade to inline hints without an interactive UI', async () => {
  const tool = loadTool();

  const multi = await tool.execute(
    'id',
    {
      question: 'Pick strategies?',
      multiSelect: true,
      options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }],
    },
    undefined,
    undefined,
    { mode: 'print', hasUI: false } as PiContext,
  );
  assert.match(multi.content[0]!.text, /No interactive UI available \(mode=print\)/);
  assert.match(multi.content[0]!.text, /Safe, Fast/);
  assert.match(multi.content[0]!.text, /may choose more than one/);
  assert.deepEqual(multi.details, { status: 'unavailable', mode: 'print' });

  const form = await tool.execute(
    'id',
    { question: 'New profile', fields: [{ name: 'name', label: 'Full name' }, { name: 'email' }] },
    undefined,
    undefined,
    { mode: 'rpc', hasUI: false } as PiContext,
  );
  assert.match(form.content[0]!.text, /Collect these fields inline: Full name, email/);
  assert.deepEqual(form.details, { status: 'unavailable', mode: 'rpc' });
});
