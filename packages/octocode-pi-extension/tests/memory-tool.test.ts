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
  const execute = captured.execute.bind(captured);
  captured.execute = (id, params, signal, onUpdate, ctx) => {
    const envelope = Array.isArray(params['queries'])
      ? params
      : { queries: [{ reasoning: 'exercise memory behavior', ...params }] };
    return execute(id, envelope, signal, onUpdate, ctx);
  };
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

test('memory exposes only a required queries envelope with per-query reasoning', () => {
  const tool = loadTool();
  const schema = tool.parameters as {
    properties?: { queries?: { items?: { properties?: Record<string, unknown>; required?: string[] } } };
    required?: string[];
  };
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['queries']);
  assert.ok(schema.required?.includes('queries'));
  assert.ok(schema.properties?.queries?.items?.properties?.['reasoning']);
  assert.ok(schema.properties?.queries?.items?.required?.includes('reasoning'));
});

test('memory executes multiple validated queries in source order', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify([{ memoryId: 'mem_a' }]), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('batch', {
    queries: [
      { reasoning: 'recall parser guidance', action: 'recall', query: 'parser' },
      { reasoning: 'review memory quality', action: 'review', query: 'parser' },
    ],
  }, undefined, undefined, ctx);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((args) => args[1]), ['recall', 'recall']);
  assert.match((res.content[0] as { text: string }).text, /2 queries succeeded/);
});

test('memory preflights the whole batch before an earlier mutation', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify({ memoryId: 'mem_new' }), stderr: '' });
  const tool = loadTool();
  await assert.rejects(tool.execute('batch-invalid', {
    queries: [
      {
        reasoning: 'record verified behavior',
        action: 'record',
        label: 'GOTCHA',
        observation: 'Tool runner self-heals after the first failed launch.',
        importance: 6,
      },
      { reasoning: 'invalid later recall', action: 'recall' },
    ],
  }, undefined, undefined, ctx), /queries\[1\] failed preflight/);
  assert.equal(calls.length, 0);
});

test('memory recall builds the CLI args and returns the recalled count', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify([{ memoryId: 'mem_a' }, { memoryId: 'mem_b' }]), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'recall', query: 'lock gate', smart: true }, undefined, undefined, ctx);
  const args = calls[0]!;
  assert.deepEqual([args[0], args[1]], ['memory', 'recall']);
  assert.ok(args.includes('--query') && args[args.indexOf('--query') + 1] === 'lock gate');
  assert.equal(args.includes('--smart'), false, 'Lite CLI does not support smart recall');
  assert.ok(args.includes('--workspace') && args[args.indexOf('--workspace') + 1] === '/tmp/mem-ws');
  assert.equal(args.includes('--compact'), false);
  assert.match((res.content[0] as { text: string }).text, /2/);
});

test('memory recall supports semantic, recent, tagged, label, and limit modes', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify([{ memoryId: 'mem_a', text: 'parser gotcha' }]), stderr: '' });
  const tool = loadTool();

  await tool.execute('id', { action: 'recall', query: 'parser', mode: 'semantic', label: 'GOTCHA', limit: 3 }, undefined, undefined, ctx);
  assert.deepEqual(calls[0], ['memory', 'recall', '--query', 'parser', '--limit', '3', '--label', 'GOTCHA', '--semantic', '--workspace', '/tmp/mem-ws']);

  await tool.execute('id', { action: 'recall', mode: 'recent', limit: 2 }, undefined, undefined, ctx);
  assert.deepEqual(calls[1], ['memory', 'list', '--limit', '2', '--workspace', '/tmp/mem-ws']);

  await tool.execute('id', { action: 'recall', mode: 'tagged', tags: ['pi-extension'] }, undefined, undefined, ctx);
  assert.deepEqual(calls[2], ['memory', 'recall', '--query', 'pi-extension', '--limit', '20', '--workspace', '/tmp/mem-ws']);
});

test('memory review lists memories and returns cleanup candidates without mutating', async () => {
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  const calls = stubRunner({
    code: 0,
    stdout: JSON.stringify([
      { memoryId: 'mem_bad', label: 'GOTCHA', text: 'tests passed', tags: '', createdAt: old },
      { memoryId: 'mem_ok', label: 'DECISION', text: 'Use source-backed memory.\nSource: src/x.ts:1', tags: 'memory', createdAt: new Date().toISOString() },
    ]),
    stderr: '',
  });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'review', limit: 5 }, undefined, undefined, ctx);
  assert.deepEqual(calls[0], ['memory', 'list', '--limit', '5', '--workspace', '/tmp/mem-ws']);
  const text = (res.content[0] as { text: string }).text;
  assert.match(text, /Reviewed 2 memories; found 1 candidate/);
  assert.match(text, /mem_bad/);
  assert.match(text, /missing-source/);
  assert.match(text, /routine-status/);
  assert.match(text, /older-than-90d/);
});

test('memory suggest returns a candidate and does not invoke the CLI', async () => {
  const calls = stubRunner({ code: 0, stdout: '{}', stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', {
    action: 'suggest',
    label: 'DECISION',
    observation: 'Memory records should include source evidence and package tags.',
    importance: 12,
    taskContext: 'memory tooling',
    source: 'src/tools/memory-tool.ts:229; yarn test:unit passed',
    tags: ['memory'],
    changedFiles: ['packages/octocode-pi-extension/src/tools/memory-tool.ts'],
  }, undefined, undefined, ctx);
  assert.equal(calls.length, 0);
  assert.match((res.content[0] as { text: string }).text, /Suggested memory candidate \(not recorded\)/);
  const candidate = (res.details as { candidate: { importance: number; tags: string[] } }).candidate;
  assert.equal(candidate.importance, 10);
  assert.deepEqual(candidate.tags, ['memory', 'octocode-pi-extension', 'memory-tool']);
});

test('memory suggest rejects bad observations before returning a candidate', async () => {
  const calls = stubRunner({ code: 0, stdout: '{}', stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'suggest', observation: 'tests passed', importance: 5 }, undefined, undefined, ctx);
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /suggestion rejected/);
  assert.equal(calls.length, 0);
});

test('memory record maps to Lite store text/tags/source and returns the new id', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify({ memoryId: 'mem_new' }), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', {
    action: 'record',
    label: 'GOTCHA',
    observation: 'Tool runner self-heals after the first failed launch.',
    importance: 6,
    taskContext: 'build',
    source: 'tests/memory-tool.test.ts:39; yarn test:unit passed',
    tags: ['pi-extension', 'memory', 'memory', 'bad,tag', ''],
  }, undefined, undefined, ctx);
  const args = calls[0]!;
  assert.deepEqual([args[0], args[1]], ['memory', 'store']);
  assert.equal(args[args.indexOf('--label') + 1], 'GOTCHA');
  assert.equal(
    args[args.indexOf('--text') + 1],
    'build: Tool runner self-heals after the first failed launch.\nSource: tests/memory-tool.test.ts:39; yarn test:unit passed',
  );
  // Lite has no importance column; the validated value is persisted as a tag.
  assert.equal(args.includes('--importance'), false);
  assert.equal(args[args.indexOf('--tags') + 1], 'importance:6,pi-extension,memory');
  assert.equal(args.includes('--task-context'), false);
  assert.equal(args.includes('--agent-id'), false);
  assert.match((res.content[0] as { text: string }).text, /mem_new/);
});

test('memory forget forwards the memory id', async () => {
  const calls = stubRunner({ code: 0, stdout: JSON.stringify({ forgotten: true }), stderr: '' });
  const tool = loadTool();
  await tool.execute('id', { action: 'forget', memoryId: 'mem_x' }, undefined, undefined, ctx);
  const args = calls[0]!;
  assert.deepEqual([args[0], args[1]], ['memory', 'forget']);
  assert.equal(args[args.indexOf('--memory-id') + 1], 'mem_x');
  assert.ok(args.includes('--workspace') && args[args.indexOf('--workspace') + 1] === '/tmp/mem-ws');
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
  const res = await tool.execute('id', { action: 'record', label: 'BUG', observation: 'Durable parser gotcha.', importance: 99 }, undefined, undefined, ctx);
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});

test('memory record rejects low-quality or sensitive observations before invoking the CLI', async () => {
  const cases = [
    { observation: 'short', expected: /too short/ },
    { observation: 'API key was sk-abcdefghijklmnopqrstuvwxyz123456', expected: /secret\/token/ },
    { observation: 'tests passed after the change', expected: /routine status/ },
    { observation: 'AGENTS.md says to run this command', expected: /instruction files/ },
    { observation: Array.from({ length: 9 }, (_, i) => `log line ${i}`).join('\n'), expected: /raw log\/dump/ },
  ];
  for (const c of cases) {
    const calls = stubRunner({ code: 0, stdout: '{}', stderr: '' });
    const tool = loadTool();
    const res = await tool.execute('id', { action: 'record', label: 'GOTCHA', observation: c.observation, importance: 5 }, undefined, undefined, ctx);
    assert.equal(res.isError, true);
    assert.match((res.content[0] as { text: string }).text, c.expected);
    assert.equal(calls.length, 0, `CLI must not run for ${c.observation}`);
  }
});

test('memory surfaces a CLI failure as an error result', async () => {
  stubRunner({ code: 1, stdout: JSON.stringify({ ok: false, error: 'boom' }), stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'forget', memoryId: 'mem_x' }, undefined, undefined, ctx);
  assert.equal(res.isError, true);
  assert.match((res.content[0] as { text: string }).text, /boom/);
});

test('renderCall and renderResult produce concise themed lines', async () => {
  stubRunner({ code: 0, stdout: JSON.stringify([{ memoryId: 'a' }, { memoryId: 'b' }, { memoryId: 'c' }]), stderr: '' });
  const tool = loadTool();
  const callLine = tool.renderCall!({ queries: [{ reasoning: 'recall test memory', action: 'recall', query: 'abc' }] }, theme).render(80)[0]!;
  assert.match(callLine, /memory/);
  assert.match(callLine, /recall/);
  const res = await tool.execute('id', { action: 'recall', query: 'abc' }, undefined, undefined, ctx);
  const resultLine = tool.renderResult!(res, { expanded: false }, theme).render(80)[0]!;
  assert.match(resultLine, /3/);
});

test('memory recall parses the CLI\'s PRETTY-PRINTED (multi-line) JSON output', async () => {
  // The real CLI emits JSON.stringify(value, null, 2); a per-line scanner sees
  // no parseable line and silently reported "0 memories" for every call.
  const pretty = JSON.stringify([{ memoryId: 'mem_a', text: 'lock gate gotcha' }, { memoryId: 'mem_b', text: 'other' }], null, 2);
  stubRunner({ code: 0, stdout: pretty, stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'recall', query: 'lock' }, undefined, undefined, ctx);
  assert.match((res.content[0] as { text: string }).text, /Recalled 2 memories/);
  assert.match((res.content[0] as { text: string }).text, /lock gate gotcha/, 'memory content reaches the model');
  assert.equal((res.details as { count?: number }).count, 2);
});

test('memory record and forget parse pretty-printed CLI output (real id, real delete count)', async () => {
  stubRunner({ code: 0, stdout: JSON.stringify({ memoryId: 'mem_xyz', label: 'GOTCHA' }, null, 2), stderr: '' });
  const tool = loadTool();
  const rec = await tool.execute('id', { action: 'record', label: 'GOTCHA', observation: 'Parser accepts pretty JSON output.', importance: 5 }, undefined, undefined, ctx);
  assert.equal((rec.details as { memoryId?: string }).memoryId, 'mem_xyz');

  stubRunner({ code: 0, stdout: JSON.stringify({ forgotten: true }, null, 2), stderr: '' });
  const del = await tool.execute('id', { action: 'forget', memoryId: 'mem_xyz' }, undefined, undefined, ctx);
  assert.match((del.content[0] as { text: string }).text, /Forgot 1 memory/);
});

test('memory recall parses pretty JSON preceded by a stray log line', async () => {
  const pretty = 'warming db…\n' + JSON.stringify([{ memoryId: 'mem_a' }], null, 2);
  stubRunner({ code: 0, stdout: pretty, stderr: '' });
  const tool = loadTool();
  const res = await tool.execute('id', { action: 'recall', query: 'x' }, undefined, undefined, ctx);
  assert.equal((res.details as { count?: number }).count, 1);
});
