import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  parseAwarenessStatus,
  parseTaskActivities,
  parseLastMessage,
  hasAwarenessSignal,
  renderAwarenessSignalAddendum,
  formatAwarenessPanel,
  refreshAwarenessPanel,
  getCachedAwarenessStatus,
  setAwarenessStatusRunnerForTests,
  setAwarenessTaskActivityRunnerForTests,
  resetAwarenessStatusStateForTests,
  forceAwarenessStatusRefreshForTests,
  type AwarenessStatus,
} from '../src/tools/awareness-status.js';
import type { PiContext } from '../src/types.js';

afterEach(() => resetAwarenessStatusStateForTests());

const FULL = JSON.stringify({
  plans: 3,
  activePlans: 1,
  tasks: 7,
  readyTasks: 2,
  inProgressTasks: 1,
  locks: 2,
  work: 1,
  pendingChecks: 4,
  verifyTasks: 4,
  agents: 2,
  messages: 5,
});

test('parseAwarenessStatus maps the Lite status JSON fields', () => {
  const s = parseAwarenessStatus(FULL)!;
  assert.equal(s.activePlans, 1);
  assert.equal(s.readyTasks, 2);
  assert.equal(s.inProgressTasks, 1);
  assert.equal(s.verifyTasks, 4);
  assert.equal(s.lockCount, 2);
  assert.equal(s.workCount, 1);
  assert.equal(s.agentCount, 2);
  assert.equal(s.messageCount, 5);
});

test('parseAwarenessStatus ignores retired status total keys', () => {
  const s = parseAwarenessStatus(JSON.stringify({ plans: 1, tasks: 3, pendingChecks: 2 }))!;
  assert.equal(s.activePlans, 0);
  assert.equal(s.readyTasks, 0);
  assert.equal(s.inProgressTasks, 0);
  assert.equal(s.verifyTasks, 0);
});

test('parseAwarenessStatus returns null on bad JSON', () => {
  assert.equal(parseAwarenessStatus('not json'), null);
});

test('parseTaskActivities returns doing before ready and de-duplicates task ids', () => {
  const doing = JSON.stringify([
    { taskId: 'task-doing-123', title: 'Implement review server', status: 'CLAIMED', agentId: 'octo-builder' },
  ]);
  const ready = JSON.stringify([
    { taskId: 'task-ready-456', title: 'Run browser checks', status: 'OPEN', agentId: null },
    { taskId: 'task-doing-123', title: 'duplicate', status: 'OPEN', agentId: null },
  ]);
  assert.deepEqual(parseTaskActivities(doing, ready), [
    { taskId: 'task-doing-123', title: 'Implement review server', state: 'doing', agentId: 'octo-builder' },
    { taskId: 'task-ready-456', title: 'Run browser checks', state: 'ready' },
  ]);
  assert.deepEqual(parseTaskActivities('bad', '[]'), []);
});

test('hasAwarenessSignal is false only when everything is zero', () => {
  const zero: AwarenessStatus = {
    activePlans: 0, readyTasks: 0, inProgressTasks: 0, verifyTasks: 0,
    lockCount: 0, workCount: 0, agentCount: 0, messageCount: 0,
  };
  assert.equal(hasAwarenessSignal(zero), false);
  assert.equal(hasAwarenessSignal({ ...zero, readyTasks: 1 }), true);
});

test('renderAwarenessSignalAddendum omits passive or unavailable state', () => {
  const passive: AwarenessStatus = {
    activePlans: 2, readyTasks: 0, inProgressTasks: 0, verifyTasks: 0,
    lockCount: 0, workCount: 3, agentCount: 2, messageCount: 4,
  };
  assert.equal(renderAwarenessSignalAddendum(null), '');
  assert.equal(renderAwarenessSignalAddendum(passive, 'octo-me'), '');
});

test('renderAwarenessSignalAddendum exposes only a bounded unread-direct-message signal', () => {
  const signal: AwarenessStatus = {
    activePlans: 1, readyTasks: 2, inProgressTasks: 2, verifyTasks: 3,
    lockCount: 1, workCount: 4, agentCount: 3, messageCount: 5,
    unreadInbox: 1,
    lastInbound: { from: 'peer', preview: 'untrusted message body must not enter the system prompt' },
    taskActivities: [
      { taskId: 'task-own', title: 'Private own title', state: 'doing', agentId: 'octo-me' },
      { taskId: 'task-peer', title: 'Untrusted peer title', state: 'doing', agentId: 'octo-peer' },
    ],
  };
  const text = renderAwarenessSignalAddendum(signal, 'octo-me');
  assert.match(text, /^<awareness_signal>/);
  assert.match(text, /Unread direct peer messages: 1/);
  assert.match(text, /\bmessage\b/);
  assert.doesNotMatch(text, /ready tasks|peer-owned tasks|verification debt|active locks|\bplan\b|\block\b/);
  assert.doesNotMatch(text, /untrusted message body|Private own title|Untrusted peer title/);
  assert.doesNotMatch(text, /\b(?:awarenessPlan|claim|task|work|verify|handoff|awarenessAgents)\b/);
  assert.ok(text.length < 700, 'signal addendum remains bounded');
});

test('renderAwarenessSignalAddendum omits non-message shared state', () => {
  const state: AwarenessStatus = {
    activePlans: 1, readyTasks: 2, inProgressTasks: 2, verifyTasks: 3,
    lockCount: 1, workCount: 4, agentCount: 3, messageCount: 5,
    unreadInbox: 0,
  };
  assert.equal(renderAwarenessSignalAddendum(state, 'octo-me'), '');
});

test('formatAwarenessPanel renders counts and surfaces verify-debt', () => {
  const s = parseAwarenessStatus(FULL)!;
  const lines = formatAwarenessPanel(s); // no theme → plain text
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Awareness/);
  assert.match(lines[0]!, /plans 1/);
  assert.match(lines[0]!, /ready 2/);
  assert.match(lines[0]!, /doing 1/);
  assert.doesNotMatch(lines[0]!, /tasks 7/); // total task count is not mislabeled as actionable ready work
  assert.match(lines[0]!, /locks 2/);
  assert.match(lines[0]!, /work 1/);
  assert.doesNotMatch(lines[0]!, /agents 2/); // shown in the lower toolbar, not the below-editor panel
  assert.match(lines[0]!, /peer-msgs 5/);
  assert.match(lines[0]!, /verify-debt 4/);
});

test('parseLastMessage summarizes the newest peer message', () => {
  const json = JSON.stringify([
    { fromAgentId: 'a1', toAgentId: 'b2', text: 'older note', createdAt: 100 },
    { fromAgentId: 'planner', toAgentId: 'worker', text: 'take the parser lane', createdAt: 200 },
  ]);
  const last = parseLastMessage(json)!;
  assert.equal(last.from, 'planner');
  assert.equal(last.to, 'worker');
  assert.match(last.preview, /take the parser lane/);
});

test('parseLastMessage returns undefined for empty or bad input', () => {
  assert.equal(parseLastMessage('[]'), undefined);
  assert.equal(parseLastMessage('not json'), undefined);
});

test('formatAwarenessPanel renders concrete doing and ready task rows', () => {
  const s: AwarenessStatus = {
    ...parseAwarenessStatus(FULL)!,
    taskActivities: [
      { taskId: 'task-doing-123', title: 'Implement review server', state: 'doing', agentId: 'octo-builder' },
      { taskId: 'task-ready-456', title: 'Run browser checks', state: 'ready' },
    ],
  };
  const lines = formatAwarenessPanel(s);
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /task.*DOING.*Implement review server.*octo-builder.*task-d/);
  assert.match(lines[2]!, /task.*READY.*Run browser checks.*task-r/);
});

test('formatAwarenessPanel renders the last peer message when present', () => {
  const s = { ...parseAwarenessStatus(FULL)!, lastMessage: { from: 'planner', to: 'worker', preview: 'take lane' } };
  const line = formatAwarenessPanel(s)[0]!;
  assert.match(line, /peer-msgs 5 \(last planner→worker: take lane\)/);
});

test('formatAwarenessPanel is empty when there is no signal', () => {
  const zero = parseAwarenessStatus(JSON.stringify({}))!;
  assert.deepEqual(formatAwarenessPanel(zero), []);
});

function uiCtx() {
  const widget: Array<{ cleared: boolean; isFn: boolean }> = [];
  const ctx = {
    cwd: '/tmp/aware-ws',
    hasUI: true,
    ui: {
      setWidget: (_name: string, content: unknown) =>
        widget.push({ cleared: content === undefined, isFn: typeof content === 'function' }),
      setStatus: () => {},
    },
  } as unknown as PiContext;
  return { ctx, widget };
}

test('refreshAwarenessPanel renders a widget from the async runner result', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx, widget } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'runner invoked once');
  assert.ok(widget.some((w) => w.isFn && !w.cleared), 'a below-editor widget was rendered');
});

test('refreshAwarenessPanel enriches the cache with concrete task activity', async () => {
  setAwarenessStatusRunnerForTests(async () => FULL);
  setAwarenessTaskActivityRunnerForTests(async () => ({
    claimed: JSON.stringify([{ taskId: 'task-doing', title: 'Implement lifecycle', status: 'CLAIMED', agentId: 'octo-worker' }]),
    ready: JSON.stringify([{ taskId: 'task-ready', title: 'Verify CLI', status: 'OPEN', agentId: null }]),
  }));
  const { ctx } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(getCachedAwarenessStatus(ctx.cwd!)?.taskActivities?.map((task) => task.state), ['doing', 'ready']);
});

test('refreshAwarenessPanel throttles repeated calls within the window', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  refreshAwarenessPanel(ctx); // within 8s window
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'subsequent calls within the window do not re-run the CLI');
});

test('refreshAwarenessPanel clears stale cached status when the async runner fails', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => (calls++ === 0 ? FULL : null));
  const { ctx, widget } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(widget.some((w) => w.isFn && !w.cleared), 'first successful refresh renders a widget');

  forceAwarenessStatusRefreshForTests(ctx.cwd!);
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(widget.some((w) => w.cleared), 'failed refresh clears the unified widget instead of keeping stale Awareness status');
});

test('refreshAwarenessPanel still runs without the CLI env var', async () => {
  delete process.env.OCTOCODE_AWARENESS_CLI;
  let calls = 0;
  setAwarenessStatusRunnerForTests(async () => { calls++; return FULL; });
  const { ctx } = uiCtx();
  refreshAwarenessPanel(ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1, 'local package runner is invoked without OCTOCODE_AWARENESS_CLI');
});

test('parseInbox counts unread messages and previews the newest inbound', async () => {
  const { parseInbox } = await import('../src/tools/awareness-status.js');
  const json = JSON.stringify([
    { messageId: 'm1', fromAgentId: 'clawde-squidJobs', toAgentId: 'pi:1', text: 'older ping', createdAt: '2026-08-21T10:00:00Z', readAt: null },
    { messageId: 'm2', fromAgentId: 'cursea-crabBohr', toAgentId: 'pi:1', text: 'please hold off on banner.ts', createdAt: '2026-08-21T11:00:00Z', readAt: null },
    { messageId: 'm3', fromAgentId: 'octo-inkstein', toAgentId: 'pi:1', text: 'already read', createdAt: '2026-08-21T12:00:00Z', readAt: '2026-08-21T12:01:00Z' },
  ], null, 2);
  const { unread, lastInbound } = parseInbox(json);
  assert.equal(unread, 2, 'read messages are excluded');
  assert.equal(lastInbound!.from, 'cursea-crabBohr', 'newest UNREAD wins');
  assert.match(lastInbound!.preview, /hold off on banner/);
  assert.deepEqual(parseInbox('[]'), { unread: 0 });
  assert.deepEqual(parseInbox('not json'), { unread: 0 });
});

test('formatAwarenessPanel leads with the unread-inbox indication', async () => {
  const { formatAwarenessPanel } = await import('../src/tools/awareness-status.js');
  const lines = formatAwarenessPanel({
    activePlans: 1, readyTasks: 0, inProgressTasks: 0, verifyTasks: 0,
    lockCount: 0, workCount: 0, agentCount: 2, messageCount: 3,
    unreadInbox: 2, lastInbound: { from: 'clawde-squidJobs', preview: 'need the lock on yarn.lock' },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /✉ 2 unread \(from clawde-squidJobs: need the lock on yarn\.lock\)/);
  // Unread comes BEFORE the plan counts (it is the actionable event).
  assert.ok(lines[0]!.indexOf('✉') < lines[0]!.indexOf('plans'), 'unread leads the panel');
  // Unread alone (no other signal) still shows a panel.
  const only = formatAwarenessPanel({
    activePlans: 0, readyTasks: 0, inProgressTasks: 0, verifyTasks: 0,
    lockCount: 0, workCount: 0, agentCount: 0, messageCount: 0, unreadInbox: 1,
  });
  assert.equal(only.length, 1);
  assert.match(only[0]!, /✉ 1 unread/);
});

test('formatAwarenessPanel clips at the source when a width is provided', () => {
  const long = formatAwarenessPanel({
    activePlans: 3, readyTasks: 9, inProgressTasks: 4, verifyTasks: 2,
    lockCount: 5, workCount: 7, agentCount: 2, messageCount: 6,
    lastMessage: { from: 'clawde-longNameAgent', to: 'octo-anotherLongName', preview: 'x'.repeat(120) },
    unreadInbox: 0,
  }, undefined, 40);
  assert.equal(long.length, 1);
  // Measure VISIBLE length — pi-tui's truncateToWidth injects SGR resets
  // around the ellipsis, so raw string length overcounts.
  const visible = long[0]!.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(visible.length <= 41, `line stays within width, got ${visible.length}`);
});
