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

test('askUser registration teaches option lists, concise labels, and inline fallback', () => {
  const tool = loadTool();

  assert.equal(tool.name, 'askUser');
  assert.match(tool.description, /keyboard-navigable list/);
  assert.match(tool.description, /non-interactive hosts/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /reply 1\/2\/3/);
  assert.match(tool.promptGuidelines?.join('\n') ?? '', /safe default first/);
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

test('askUser uses Pi native selector for simple option choices', async () => {
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
        throw new Error('custom overlay should not be used for simple native choices');
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

  assert.deepEqual(selectCalls, [{ title: 'Choose a strategy?', items: ['safe', 'fast'] }]);
  assert.match(result.content[0]!.text, /User selected: safe/);
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
});

 test('askUser renders rich option choices through the Octocode overlay picker', async () => {
  const tool = loadTool();
  let customOptions: unknown;
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      select: async () => {
        throw new Error('native selector should not be used for described choices');
      },
      custom: async (_factory: unknown, opts: unknown) => {
        customOptions = opts;
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

  assert.deepEqual(customOptions, { overlay: true });
  assert.match(result.content[0]!.text, /User selected: Safe/);
  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'Safe' });
});

test('askUser can collect free text through the interactive input hook', async () => {
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

  assert.equal(prompts.at(-1), 'What should we do?');
  assert.match(result.content[0]!.text, /User answered: typed answer/);
  assert.deepEqual(result.details, { status: 'text', value: 'typed answer' });
});

test('askUser echoes the question in the selected result (durable context after compaction)', async () => {
  const tool = loadTool();
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: { custom: async () => 'safe' },
  } as unknown as PiContext;
  const result = await tool.execute(
    'id',
    { question: 'Choose a strategy?', options: [{ value: 'safe', label: 'Safe' }] },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0]!.text, /Choose a strategy\?/);
  assert.match(result.content[0]!.text, /User selected: Safe/);
});

test('askUser echoes the question in free-text and cancelled results', async () => {
  const tool = loadTool();
  const answered = await tool.execute(
    'id',
    { question: 'What should we do?' },
    undefined,
    undefined,
    {
      hasUI: true,
      mode: 'tui',
      ui: { custom: () => undefined, input: async () => 'ship it' },
    } as unknown as PiContext,
  );
  assert.match(answered.content[0]!.text, /What should we do\?/);
  assert.match(answered.content[0]!.text, /User answered: ship it/);

  const cancelled = await tool.execute(
    'id',
    { question: 'Pick one?', options: [{ value: 'a' }] },
    undefined,
    undefined,
    {
      hasUI: true,
      mode: 'tui',
      ui: { custom: async () => null },
    } as unknown as PiContext,
  );
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

test('askUser multiSelect returns multiSelected values through the overlay', async () => {
  const tool = loadTool();
  let customOptions: unknown;
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      select: async () => {
        throw new Error('native selector must not be used for multi-select');
      },
      custom: async (_factory: unknown, opts: unknown) => {
        customOptions = opts;
        return ['safe', 'fast'];
      },
    },
  } as unknown as PiContext;

  const result = await tool.execute(
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

  assert.deepEqual(customOptions, { overlay: true });
  assert.match(result.content[0]!.text, /Pick strategies\?/);
  assert.match(result.content[0]!.text, /User selected 2 options: Safe, Fast/);
  assert.deepEqual(result.details, { status: 'multiSelected', values: ['safe', 'fast'] });
});

test('askUser multiSelect reports cancellation when the overlay is dismissed', async () => {
  const tool = loadTool();
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: { custom: async () => null },
  } as unknown as PiContext;

  const result = await tool.execute(
    'id',
    { question: 'Pick some?', multiSelect: true, options: [{ value: 'a' }, { value: 'b' }] },
    undefined,
    undefined,
    ctx,
  );

  assert.match(result.content[0]!.text, /Pick some\?/);
  assert.match(result.content[0]!.text, /cancelled/i);
  assert.deepEqual(result.details, { status: 'cancelled' });
});

test('askUser previewed options route through the overlay picker, not the native selector', async () => {
  const tool = loadTool();
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      select: async () => {
        throw new Error('native selector must not be used for previewed options');
      },
      custom: async () => 'safe',
    },
  } as unknown as PiContext;

  const result = await tool.execute(
    'id',
    { question: 'Choose?', options: [{ value: 'safe', preview: 'preview body' }, { value: 'fast' }] },
    undefined,
    undefined,
    ctx,
  );

  assert.deepEqual(result.details, { status: 'selected', value: 'safe', label: 'safe' });
});

test('askUser form collects fields in order via sequential input prompts', async () => {
  const tool = loadTool();
  const prompts: Array<{ title: string; placeholder?: string }> = [];
  const answers = ['Guy', 'guy@example.com'];
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      input: async (title: string, placeholder?: string) => {
        prompts.push({ title, placeholder });
        return answers.shift();
      },
    },
  } as unknown as PiContext;

  const result = await tool.execute(
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

  assert.deepEqual(prompts, [
    { title: 'New profile — Full name', placeholder: undefined },
    { title: 'New profile — Email', placeholder: 'you@host' },
  ]);
  assert.match(result.content[0]!.text, /New profile/);
  assert.match(result.content[0]!.text, /name: Guy/);
  assert.match(result.content[0]!.text, /email: guy@example.com/);
  assert.deepEqual(result.details, { status: 'form', values: { name: 'Guy', email: 'guy@example.com' } });
});

test('askUser form re-prompts required fields once, then rejects when still empty', async () => {
  const tool = loadTool();

  // Re-prompt succeeds on the second try.
  const okPrompts: string[] = [];
  const okAnswers = ['', 'Guy'];
  const okResult = await loadTool().execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name', label: 'Name', required: true }] },
    undefined,
    undefined,
    {
      hasUI: true,
      mode: 'tui',
      ui: { input: async (title: string) => { okPrompts.push(title); return okAnswers.shift(); } },
    } as unknown as PiContext,
  );
  assert.deepEqual(okPrompts, ['Profile — Name', 'Profile — Name (required)']);
  assert.deepEqual(okResult.details, { status: 'form', values: { name: 'Guy' } });

  // Still empty after the re-prompt → rejected as cancelled with the field named.
  const emptyAnswers = ['', '   '];
  const rejected = await tool.execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name', label: 'Name', required: true }] },
    undefined,
    undefined,
    {
      hasUI: true,
      mode: 'tui',
      ui: { input: async () => emptyAnswers.shift() },
    } as unknown as PiContext,
  );
  assert.match(rejected.content[0]!.text, /Required field "Name" was left empty/);
  assert.deepEqual(rejected.details, { status: 'cancelled', label: 'Name' });
});

test('askUser form cancels when the user escapes any prompt', async () => {
  const tool = loadTool();
  const result = await tool.execute(
    'id',
    { question: 'Profile', fields: [{ name: 'name' }, { name: 'email' }] },
    undefined,
    undefined,
    {
      hasUI: true,
      mode: 'tui',
      ui: { input: async () => undefined },
    } as unknown as PiContext,
  );
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
