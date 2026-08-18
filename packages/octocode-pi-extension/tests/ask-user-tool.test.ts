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

test('askUser renders option choices through an overlay picker', async () => {
  const tool = loadTool();
  let customOptions: unknown;
  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
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
