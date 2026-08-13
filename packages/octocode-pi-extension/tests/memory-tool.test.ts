import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { Type } from 'typebox';
import type { ToolDefinition, PiContext, PiTheme } from '../src/types.js';
import { registerMemoryTool, setMemoryCliRunnerForTests, type MemoryCliResult } from '../src/tools/memory-tool.js';

function loadTool(): ToolDefinition {
  let captured: ToolDefinition | undefined;
  const pi = { registerTool: (def: ToolDefinition) => { captured = def; } };
  registerMemoryTool(pi, Type, new Set<string>(), (_pi, _names, def) => { captured = def; });
  if (!captured) throw new Error('memory tool not registered');
  return captured;
}

const ctx = { cwd: '/tmp/mem-ws' } as unknown as PiContext;
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as PiTheme;

afterEach(() => setMemoryCliRunnerForTests(null));

function stubRunner(result: MemoryCliResult) {
  const calls: string[][] = [];
  setMemoryCliRunnerForTests((args) => { calls.push(args); return result; });
  return calls;
}

test('memory recall builds the CLI args and returns the recalled count', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify({ count: 2, memories: [{ memory_id: 'mem_a' }, { memory_id: 'mem_b' }] }), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'recall', query: 'lock gate', smart: true }, undefined, undefined, ctx);
  const args = calls[0]!;
  assert.deepEqual([args[0], args[1]], ['memory', 'recall']);
  assert.ok(args.includes('--query') && args[args.indexOf('--query') + 1] === 'lock gate');
  assert.ok(args.includes('--smart'), 'smart flag forwarded');
  assert.ok(args.includes('--workspace') && args[args.indexOf('--workspace') + 1] === '/tmp/mem-ws');
  assert.ok(args.includes('--compact'));
  assert.match(res.content[0]!.text, /2/);
});

test('memory record forwards label/observation/importance and returns the new id', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify({ memory: { memory_id: 'mem_new' } }), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', {
    action: 'record', label: 'GOTCHA', observation: 'x self-heals', importance: 6, taskContext: 'build',
  }, undefined, undefined, ctx);
  const args = calls[0]!;
  assert.deepEqual([args[0], args[1]], ['memory', 'record']);
  assert.equal(args[args.indexOf('--label') + 1], 'GOTCHA');
  assert.equal(args[args.indexOf('--observation') + 1], 'x self-heals');
  assert.equal(args[args.indexOf('--importance') + 1], '6');
  assert.equal(args[args.indexOf('--task-context') + 1], 'build');
  assert.ok(args.includes('--agent-id'));
  assert.match(res.content[0]!.text, /mem_new/);
});

test('memory forget forwards the memory id', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify({ deleted: 1, memory_ids: ['mem_x'] }), stderr: '' });
  const tool = loadTool();
  await tool.execute('id', { action: 'forget', memoryId: 'mem_x' }, undefined, undefined, ctx);
  const args = calls[0]!;
  assert.deepEqual([args[0], args[1]], ['memory', 'forget']);
  assert.equal(args[args.indexOf('--memory-id') + 1], 'mem_x');
});

test('memory recall without a query errors before invoking the CLI', async () => {
  const calls = stubRunner({ code: 0, stdout: '{}', stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'recall' }, undefined, undefined, ctx);
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0, 'CLI must not run on invalid input');
});

test('memory record with out-of-range importance errors before invoking the CLI', async () => {
  const calls = stubRunner({ code: 0, stdout: '{}', stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'record', label: 'BUG', observation: 'y', importance: 99 }, undefined, undefined, ctx);
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test('memory surfaces a CLI failure as an error result', async () => {
  stubRunner({ code: 1, stdout: JSON.stringify({ ok: false, error: 'boom' }), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'forget', memoryId: 'mem_x' }, undefined, undefined, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /boom/);
});

test('renderCall and renderResult produce concise themed lines', async () => {
  stubRunner({ code: 0, stdout: JSON.stringify({ count: 3, memories: [] }), stderr: '' });
  const tool = loadTool();
  const callLine = tool.renderCall!({ action: 'recall', query: 'abc' }, theme).render(80)[0]!;
  assert.match(callLine, /memory/);
  assert.match(callLine, /recall/);
  const res = await tool.execute('id', { action: 'recall', query: 'abc' }, undefined, undefined, ctx);
  const resultLine = tool.renderResult!(res, { expanded: false }, theme).render(80)[0]!;
  assert.match(resultLine, /3/);
});
