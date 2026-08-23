import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Type } from 'typebox';
import { visibleWidth } from '@earendil-works/pi-tui';
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

// Inline harness: askUser renders via ctx.ui.custom(builder) with NO overlay
// options, so it appears inline in the message flow. The mock invokes the
// factory synchronously, captures the component + any opts (expected undefined),
// and resolves the custom() promise when the factory calls done().
function overlayCtx() {
  let component: { render(w: number): string[]; handleInput(d: string): void } | undefined;
  let overlayOpts: { overlay?: boolean } | undefined;
  const tui = { requestRender: () => {} };
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      custom: (
        factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => { render(w: number): string[]; handleInput(d: string): void },
        opts?: { overlay?: boolean },
      ) =>
        new Promise((resolve) => {
          overlayOpts = opts;
          component = factory(tui, undefined, undefined, (v) => resolve(v));
        }),
    },
  } as unknown as PiContext;
  return {
    ctx,
    send: (data: string) => component?.handleInput(data),
    render: (w = 100) => component?.render(w) ?? [],
    overlayOpts: () => overlayOpts,
    // Simulate the TUI granting focus (Focusable.focused = true).
    focus: () => { if (component) (component as { focused?: boolean }).focused = true; },
  };
}

test('askUser registration teaches option lists, concise labels, and inline fallback', () => {
  const tool = loadTool();

  assert.equal(tool.name, 'askUser');
  assert.match(tool.description, /keyboard-navigable list/);
  assert.match(tool.description, /Discuss or type your own answer/);
  assert.match(tool.description, /pros\[\] and cons\[\]/);
  assert.match(tool.description, /recommended:true/);
  assert.match(tool.description, /non-interactive hosts/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /reply 1\/2\/3/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /recommended:true/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /Discuss or type your own answer/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /fall back to asking the question directly/);
});

test('askUser falls back to inline in RPC mode even though hasUI is true and custom exists', async () => {
  const tool = loadTool();
  let customCalled = false;
  const ctx = {
    hasUI: true,
    mode: 'rpc',
    ui: {
      // In RPC pi exposes custom() but it returns undefined; askUser must NOT
      // treat this as interactive (would resolve as a bogus cancellation).
      custom: async () => { customCalled = true; return undefined; },
    },
  } as unknown as PiContext;

  const result = await tool.execute('id', { question: 'Ship it?', options: ['yes', 'no'] }, undefined, undefined, ctx);

  assert.equal(customCalled, false, 'custom() must not be called outside tui mode');
  assert.match((result.content[0] as { text: string }).text, /No interactive UI available \(mode=rpc\)/);
  assert.deepEqual(result.details, { status: 'unavailable', mode: 'rpc' });
});

test('askUser emits CURSOR_MARKER at the caret in text mode when focused (IME positioning)', async () => {
  const tool = loadTool();
  const { ctx, send, render, focus } = overlayCtx();
  const pending = tool.execute('id', { question: 'Name?' }, undefined, undefined, ctx);
  focus(); // TUI grants focus → Focusable.focused = true
  send('Gu');
  const lines = render(80);
  const caretLine = lines.find((l) => l.includes('\u203a'))!;
  // CURSOR_MARKER (APC escape) is appended after the typed text for the hardware cursor.
  assert.ok(caretLine.includes('\u001b_pi:c\u0007'), 'focused text input must emit CURSOR_MARKER');
  assert.ok(caretLine.trimEnd().endsWith('\u0007') || caretLine.includes('Gu'), 'marker sits at the caret after typed text');
  send('\r');
  const result = await pending;
  assert.deepEqual(result.details, { status: 'text', value: 'Gu' });
});

test('askUser accepts bracketed paste in free-text mode', async () => {
  const tool = loadTool();
  const { ctx, send, render, focus } = overlayCtx();
  const pending = tool.execute('id', { question: 'What should we do?' }, undefined, undefined, ctx);

  focus();
  send('\x1b[200~paste this answer\x1b[201~');
  assert.match(render(100).join('\n'), /paste this answer/);
  send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'text', value: 'paste this answer' });
});

test('askUser free-text mode supports cursor editing through Pi Input', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();
  const pending = tool.execute('id', { question: 'Name?' }, undefined, undefined, ctx);

  send('ac');
  send('\x1b[D');
  send('b');
  send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'text', value: 'abc' });
});

test('askUser uses a wider responsive card without exceeding the terminal', async () => {
  const tool = loadTool();
  const wide = overlayCtx();
  const pendingWide = tool.execute('id', { question: 'Choose?', options: ['safe', 'fast'] }, undefined, undefined, wide.ctx);
  const wideLines = wide.render(160);

  assert.ok(visibleWidth(wideLines[0]!) >= 100, 'wide terminals should receive a substantially wider card');
  assert.ok(wideLines.every((line) => visibleWidth(line) <= 160), 'wide rendering stays within the terminal');
  wide.send('\x1b');
  await pendingWide;

  const narrow = overlayCtx();
  const pendingNarrow = tool.execute('id', { question: 'Choose?', options: ['safe', 'fast'] }, undefined, undefined, narrow.ctx);
  assert.ok(narrow.render(36).every((line) => visibleWidth(line) <= 36), 'narrow rendering never overflows');
  narrow.send('\x1b');
  await pendingNarrow;
});

test('askUser validates that a non-empty question is required', async () => {
  const tool = loadTool();
  const result = await tool.execute('id', { question: '   ' });

  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /question is required/);
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
  assert.match((result.content[0] as { text: string }).text, /No interactive UI available \(mode=rpc\)/);
  assert.match((result.content[0] as { text: string }).text, /Ask the user this question directly/);
  assert.match((result.content[0] as { text: string }).text, /Safe, Fast/);
  assert.deepEqual(result.details, { status: 'unavailable', mode: 'rpc' });
});

test('askUser uses the custom overlay and never Pi native select', async () => {
  const tool = loadTool();
  const selectCalls: Array<{ title: string; items: string[] }> = [];
  const { ctx, send, overlayOpts } = overlayCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.select = async (title: string, items: string[]) => {
    selectCalls.push({ title, items });
    return 'safe';
  };

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
  send('\r');
  const result = await pending;

  assert.deepEqual(selectCalls, [], 'askUser must not call Pi native select (it uses the inline prompt)');
  assert.notEqual(overlayOpts()?.overlay, true, 'askUser renders inline in the message flow, not as an overlay');
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
});

test('askUser renders choices inline in the message flow, not as a floating overlay', async () => {
  const tool = loadTool();
  const { ctx, render, send, overlayOpts } = overlayCtx();

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

  const opts = overlayOpts() as { overlay?: boolean; overlayOptions?: { anchor?: string } } | undefined;
  assert.notEqual(opts?.overlay, true, 'askUser must render inline (non-overlay) in the message flow');
  assert.equal(opts?.overlayOptions, undefined, 'inline prompt passes no overlay positioning options');
  const lines = render(100);
  assert.match(lines.join('\n'), /Input needed/);
  assert.match(lines.join('\n'), /Choose a strategy\?/);
  // Discuss / free-text row appears AFTER the listed options.
  assert.match(lines.join('\n'), /Discuss or type your own answer/);
  // Smart separator: the header rule fills the full width with box chars.
  const headerPlain = lines[0]!.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(headerPlain.includes('Input needed'));
  assert.ok(headerPlain.endsWith('─'), 'header rule should fill to width');
  send('\r');
  const result = await pending;

  assert.match((result.content[0] as { text: string }).text, /User selected: safe/);
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
});

test('askUser option picker allows bracketed paste in the custom free-text answer', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();

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
  send('[200~custom plan[201~');
  send('\r');
  const result = await pending;

  assert.match((result.content[0] as { text: string }).text, /User answered: custom plan/);
  assert.deepEqual(result.details, { status: 'text', value: 'custom plan' });
});

test('askUser routes described choices through the custom overlay', async () => {
  const tool = loadTool();
  const { ctx, send, overlayOpts } = overlayCtx();

  const pending = tool.execute(
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

  assert.notEqual(overlayOpts()?.overlay, true, 'described choices render inline in the message flow');
  send('\r');
  const result = await pending;
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'Safe' });
});

test('askUser never calls Pi ui.input (it uses the overlay)', async () => {
  const tool = loadTool();
  const prompts: string[] = [];
  const { ctx, send } = overlayCtx();
  (ctx as unknown as { ui: Record<string, unknown> }).ui.input = async (question: string) => {
    prompts.push(question);
    return 'typed answer';
  };

  const pending = tool.execute('id', { question: 'What should we do?' }, undefined, undefined, ctx);
  send('ship it');
  send('\r');
  const result = await pending;

  assert.deepEqual(prompts, [], 'askUser must not call Pi input (it uses the overlay)');
  assert.match((result.content[0] as { text: string }).text, /User answered: ship it/);
  assert.deepEqual(result.details, { status: 'text', value: 'ship it' });
});

test('askUser echoes the question in the selected result (durable context after compaction)', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();
  const pending = tool.execute(
    'id',
    { question: 'Choose a strategy?', options: [{ value: 'safe', label: 'Safe' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\r');
  const result = await pending;
  assert.match((result.content[0] as { text: string }).text, /Choose a strategy\?/);
  assert.match((result.content[0] as { text: string }).text, /User selected: Safe/);
});

test('askUser echoes the question in free-text and cancelled results', async () => {
  const tool = loadTool();
  const answeredHarness = overlayCtx();
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
  assert.match((answered.content[0] as { text: string }).text, /What should we do\?/);
  assert.match((answered.content[0] as { text: string }).text, /User answered: ship it/);

  const cancelledHarness = overlayCtx();
  const cancelledPending = tool.execute(
    'id',
    { question: 'Pick one?', options: [{ value: 'a' }] },
    undefined,
    undefined,
    cancelledHarness.ctx,
  );
  cancelledHarness.send('\x1b');
  const cancelled = await cancelledPending;
  assert.match((cancelled.content[0] as { text: string }).text, /Pick one\?/);
  assert.match((cancelled.content[0] as { text: string }).text, /cancelled/i);
});

test('askUser schema gains preview, disabled options, multiSelect, min/max, and field validation additively', () => {
  const tool = loadTool();
  const params = tool.parameters as {
    properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
  };

  assert.ok(params.properties['multiSelect'], 'multiSelect input exists');
  assert.ok(params.properties['min'], 'min input exists');
  assert.ok(params.properties['max'], 'max input exists');
  assert.ok(params.properties['options']!.items?.properties?.['preview'], 'options gain preview');
  assert.ok(params.properties['options']!.items?.properties?.['disabled'], 'options gain disabled');
  const fieldProps = params.properties['fields']!.items?.properties ?? {};
  assert.deepEqual(Object.keys(fieldProps).sort(), ['label', 'maxLength', 'minLength', 'name', 'pattern', 'placeholder', 'required']);
});

test('askUser renders recommended badge, pros/cons under the focused row, and lands the cursor on the recommended option', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Which approach?',
      options: [
        { value: 'risky', label: 'Aggressive cut', cons: ['thins the safety net'] },
        { value: 'safe', label: 'Leave it', recommended: true, pros: ['no risk', 'load-bearing'], cons: ['no line-count win'] },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  const plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  // Recommended badge shows on its row even when collapsed.
  assert.match(plain, /Leave it ★ recommended/);
  // Cursor defaults to the recommended option, so its pros/cons are expanded.
  assert.match(plain, /✓ no risk/);
  assert.match(plain, /✓ load-bearing/);
  assert.match(plain, /✗ no line-count win/);
  // The non-focused option's cons stay collapsed.
  assert.doesNotMatch(plain, /✗ thins the safety net/);

  // One Enter accepts the preselected recommended option.
  send('\r');
  const result = await pending;
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'Leave it' });
});

test('askUser schema exposes pros, cons, and recommended on options', () => {
  const tool = loadTool();
  const params = tool.parameters as {
    properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
  };
  const optProps = params.properties['options']!.items?.properties ?? {};
  assert.ok(optProps['pros'], 'options gain pros');
  assert.ok(optProps['cons'], 'options gain cons');
  assert.ok(optProps['recommended'], 'options gain recommended');
  assert.ok(optProps['disabled'], 'options gain disabled');
  assert.ok(optProps['group'], 'options gain group');
});

test('askUser multiSelect returns multiSelected values through the overlay', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();

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

  assert.match((result.content[0] as { text: string }).text, /Pick strategies\?/);
  assert.match((result.content[0] as { text: string }).text, /User selected 2 options: Safe, Fast/);
  assert.deepEqual(result.details, { status: 'multiSelected', values: ['safe', 'fast'] });
});

test('askUser multiSelect custom answer row bypasses min/max option validation', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();

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

  assert.match((result.content[0] as { text: string }).text, /User answered: something else/);
  assert.deepEqual(result.details, { status: 'text', value: 'something else' });
});

test('askUser multiSelect reports cancellation when the overlay is dismissed', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();

  const pending = tool.execute(
    'id',
    { question: 'Pick some?', multiSelect: true, options: [{ value: 'a' }, { value: 'b' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\x1b');
  const result = await pending;

  assert.match((result.content[0] as { text: string }).text, /Pick some\?/);
  assert.match((result.content[0] as { text: string }).text, /cancelled/i);
  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser previewed options route through the overlay, not the native selector', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();

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

test('askUser form collects fields in order via the overlay modal', async () => {
  const tool = loadTool();
  const { ctx, send, overlayOpts } = overlayCtx();

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

  assert.notEqual(overlayOpts()?.overlay, true, 'form renders inline in the message flow');
  assert.match((result.content[0] as { text: string }).text, /New profile/);
  assert.match((result.content[0] as { text: string }).text, /name: Guy/);
  assert.match((result.content[0] as { text: string }).text, /email: guy@example.com/);
  assert.deepEqual(result.details, { status: 'form', values: { name: 'Guy', email: 'guy@example.com' } });
});

test('askUser form keeps focus on invalid fields until valid or escaped', async () => {
  const tool = loadTool();
  const harness = overlayCtx();
  const pending = tool.execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name', label: 'Name', required: true, minLength: 3 }] },
    undefined,
    undefined,
    harness.ctx,
  );

  harness.send('\r');
  assert.match(harness.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /Name is required/);
  harness.send('Al');
  harness.send('\r');
  assert.match(harness.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /Name must be at least 3 characters/);
  harness.send('i');
  harness.send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'form', values: { name: 'Ali' } });
});

test('askUser form cancels when the user escapes any prompt', async () => {
  const tool = loadTool();
  const { ctx, send } = overlayCtx();
  const pending = tool.execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name' }, { name: 'email' }] },
    undefined,
    undefined,
    ctx,
  );
  send('\x1b');
  const result = await pending;
  assert.match((result.content[0] as { text: string }).text, /cancelled/i);
  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser single-select digit keys pick the numbered option outright', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    { question: 'Choose?', options: ['alpha', 'beta', 'gamma'] },
    undefined,
    undefined,
    ctx,
  );
  const plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /1\. alpha/, 'options are numbered for quick-select');
  assert.match(plain, /2\. beta/);
  send('2');
  const result = await pending;
  assert.deepEqual(result.details, { status: 'selected', value: 'beta', label: 'beta' });
});

test('askUser multiSelect digit keys toggle and footer shows a live count', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    { question: 'Pick?', multiSelect: true, min: 1, options: ['a', 'b', 'c'] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /0 selected · min 1/);
  send('1');
  send('3');
  assert.match(render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /2 selected · min 1/);
  send('\r');
  const result = await pending;
  assert.deepEqual(result.details, { status: 'multiSelected', values: ['a', 'c'] });
});

test('askUser windows long option lists around the cursor with more-markers', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const options = Array.from({ length: 20 }, (_, i) => `opt-${String(i + 1).padStart(2, '0')}`);
  const pending = tool.execute('id', { question: 'Long?', options }, undefined, undefined, ctx);

  const first = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(first, /opt-01/);
  assert.match(first, /↓ \d+ more/, 'hidden tail advertised');
  assert.doesNotMatch(first, /opt-20/, 'rows beyond the window are not painted');

  for (let i = 0; i < 15; i++) send('\x1b[B');
  const scrolled = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(scrolled, /↑ \d+ more/, 'hidden head advertised after scrolling');
  assert.match(scrolled, /opt-16/);

  send('\x1b');
  const result = await pending;
  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser disabled options stay visible but cannot be selected', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Choose?',
      options: [
        { value: 'blocked', label: 'Blocked', disabled: 'needs auth' },
        { value: 'safe', label: 'Safe' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  let plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /Blocked \(needs auth\)/);
  send('\r');
  plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /"Blocked" is needs auth/);
  send('\x1b[B');
  send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'Safe' });
});

test('askUser renders grouped choices as non-selectable headings', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Choose?',
      options: [
        { value: 'safe', label: 'Safe', group: 'Recommended' },
        { value: 'fast', label: 'Fast', group: 'Risky' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  const plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /┌ Recommended/);
  assert.match(plain, /┌ Risky/);
  send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'Safe' });
});

test('askUser filters options with slash search and clears search with escape before cancellation', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    { question: 'Choose?', options: ['alpha', 'beta', 'gamma'] },
    undefined,
    undefined,
    ctx,
  );

  send('/');
  send('ga');
  let plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /\/ ga/);
  assert.match(plain, /gamma/);
  assert.doesNotMatch(plain, /alpha/);
  send('\x1b');
  plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /alpha/);
  send('/');
  send('zz');
  plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /No matches/);
  send('\x1b');
  send('\x1b');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser multiSelect supports all and invert shortcuts while skipping disabled options', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute(
    'id',
    {
      question: 'Pick?',
      multiSelect: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', disabled: true },
        { value: 'c', label: 'C' },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  send('a');
  assert.match(render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /2 selected/);
  send('i');
  assert.match(render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /0 selected/);
  send('i');
  send('\r');
  const result = await pending;

  assert.deepEqual(result.details, { status: 'multiSelected', values: ['a', 'c'] });
});

test('askUser renders a final submitted state after completion', async () => {
  const tool = loadTool();
  const { ctx, send, render } = overlayCtx();

  const pending = tool.execute('id', { question: 'Choose?', options: ['safe'] }, undefined, undefined, ctx);
  send('\r');
  const result = await pending;
  const plain = render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

  assert.match(plain, /safe/);
  assert.match(plain, /submitted/);
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
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
  assert.match((multi.content[0] as { text: string }).text, /No interactive UI available \(mode=print\)/);
  assert.match((multi.content[0] as { text: string }).text, /Safe, Fast/);
  assert.match((multi.content[0] as { text: string }).text, /may choose more than one/);
  assert.deepEqual(multi.details, { status: 'unavailable', mode: 'print' });

  const form = await tool.execute(
    'id',
    { question: 'New profile', fields: [{ name: 'name', label: 'Full name' }, { name: 'email' }] },
    undefined,
    undefined,
    { mode: 'rpc', hasUI: false } as PiContext,
  );
  assert.match((form.content[0] as { text: string }).text, /Collect these fields inline: Full name, email/);
  assert.deepEqual(form.details, { status: 'unavailable', mode: 'rpc' });
});
