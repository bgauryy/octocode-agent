/**
 * Tests for the plan(clarify) interview phase. runAskPrompt is mocked so we can
 * script the user's answers and assert they land in the durable decision log.
 */
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition, PiContext } from '../src/types.js';

// A scripted outcome queue + a record of the questions actually shown, hoisted so
// the vi.mock factory can close over them.
const { outcomes, asked } = vi.hoisted(() => ({ outcomes: [] as unknown[], asked: [] as string[] }));
vi.mock('../src/tools/ask-user-tool.js', () => ({
  runAskPrompt: async (_ctx: unknown, params: { question: string }) => { asked.push(params.question); return outcomes.shift(); },
}));

import { registerPlanTool } from '../src/tools/plan-tool.js';
import { getPlanDecisions, clearPlan } from '../src/tools/active-plan.js';

function loadTool(): ToolDefinition {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (d: ToolDefinition) => tools.set(d.name, d) };
  registerPlanTool(pi, Type, new Set<string>(), (p, n, d) => { n.add(d.name); p.registerTool?.(d); });
  return tools.get('plan')!;
}

const CWD = '/tmp/plan-interview-ws';
afterEach(() => { outcomes.length = 0; asked.length = 0; clearPlan(CWD); });

async function clarify(questions: unknown): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const tool = loadTool();
  const ctx = { cwd: CWD } as unknown as PiContext; // hasUI falsy → skip panel; runAskPrompt is mocked
  return (await tool.execute('id', { action: 'clarify', questions }, undefined, undefined, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
}

test('plan(clarify) records selected (label) and free-text answers into the decision log', async () => {
  outcomes.push({ status: 'selected', value: 'sqlite', label: 'SQLite' });
  outcomes.push({ status: 'text', value: 'reuse existing auth' });
  const res = await clarify([
    { prompt: 'Storage backend?', options: [{ label: 'SQLite', value: 'sqlite', recommended: true }] },
    { prompt: 'Auth approach?' },
  ]);
  assert.notEqual(res.isError, true);
  assert.deepEqual(getPlanDecisions(CWD), [
    { q: 'Storage backend?', a: 'SQLite' },
    { q: 'Auth approach?', a: 'reuse existing auth' },
  ]);
  assert.match(res.content[0]!.text, /recorded 2 decision/);
  assert.match(res.content[0]!.text, /decision-complete/);
});

test('plan(clarify) numbers multi-question interviews (n/total) but keeps the clean prompt in the log', async () => {
  outcomes.push({ status: 'selected', label: 'X', value: 'x' });
  outcomes.push({ status: 'selected', label: 'Y', value: 'y' });
  await clarify([{ prompt: 'First?' }, { prompt: 'Second?' }]);
  assert.deepEqual(asked, ['(1/2) First?', '(2/2) Second?'], 'shown questions are numbered');
  assert.deepEqual(getPlanDecisions(CWD).map((d) => d.q), ['First?', 'Second?'], 'the decision log keeps the clean prompt');
});

test('plan(clarify) does not number a single-question interview', async () => {
  outcomes.push({ status: 'selected', label: 'X', value: 'x' });
  await clarify([{ prompt: 'Only one?' }]);
  assert.deepEqual(asked, ['Only one?']);
});

test('plan(clarify) caps the interview at 3 questions', async () => {
  for (let i = 0; i < 5; i++) outcomes.push({ status: 'selected', label: `A${i}`, value: `a${i}` });
  await clarify(Array.from({ length: 5 }, (_v, i) => ({ prompt: `Q${i}?` })));
  assert.equal(getPlanDecisions(CWD).length, 3, 'only the first 3 questions are asked');
});

test('plan(clarify) with no questions is an actionable error', async () => {
  const res = await clarify([]);
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /questions\[\] list/);
  assert.equal(getPlanDecisions(CWD).length, 0);
});

test('plan(clarify) halts on cancel and keeps only prior answers', async () => {
  outcomes.push({ status: 'selected', label: 'Yes', value: 'yes' });
  outcomes.push({ status: 'cancelled' });
  const res = await clarify([{ prompt: 'First?' }, { prompt: 'Second?' }, { prompt: 'Third?' }]);
  assert.deepEqual(getPlanDecisions(CWD), [{ q: 'First?', a: 'Yes' }], 'only the answered question is recorded');
  assert.match(res.content[0]!.text, /cancelled/i);
});

test('plan(clarify) with no interactive host lists the questions to ask inline', async () => {
  // The handler branches on `!ctx`; simulate a host with no ctx.
  const tool = loadTool();
  const res = (await tool.execute('id', { action: 'clarify', questions: [{ prompt: 'Which DB?' }] }, undefined, undefined, undefined)) as { content: Array<{ text: string }> };
  assert.match(res.content[0]!.text, /cannot prompt/);
  assert.match(res.content[0]!.text, /Which DB\?/);
});
