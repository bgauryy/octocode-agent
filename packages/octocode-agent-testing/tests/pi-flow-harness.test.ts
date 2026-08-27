import fs from 'node:fs';
import http from 'node:http';
import { describe, expect, test } from 'vitest';
import { createIsolatedAwarenessStore, createPiFlowHarness } from '../src/index.js';

describe('PiFlowHarness', () => {
  test('runs registered tools through Pi lifecycle hooks and captures streamed updates', async () => {
    const flow = createPiFlowHarness();
    flow.pi.on('tool_call', async () => ({ block: false }));
    flow.pi.registerTool({
      name: 'plan',
      execute: async (_id, params, _signal, onUpdate) => {
        onUpdate?.({ phase: 'planning' });
        return { content: [{ type: 'text', text: String(params['goal']) }] };
      },
    });

    const result = await flow.runTool('plan', { goal: 'mock every flow' }, { id: 'plan-1' });

    expect(result).toMatchObject({ content: [{ text: 'mock every flow' }] });
    expect(flow.eventsOf('tool.updated')).toHaveLength(1);
    flow.assertSequence([
      'tool.registered', 'event.emitted', 'event.handled', 'tool.started',
      'tool.updated', 'tool.finished', 'event.emitted',
    ]);
  });

  test('scripts dialogs, agent turns, and browser callbacks in one deterministic transcript', async () => {
    const flow = createPiFlowHarness({
      scripted: {
        selects: ['Strict migration'],
        agents: [{ tool: 'plan', action: 'review' }],
        browsers: [{ action: 'accept', payload: { revision: 'rfc-sha' } }],
      },
    });

    flow.ui.setWorkingMessage('Planning…');
    flow.ui.setWorkingVisible(true);
    expect(await flow.ui.select('Choose migration policy', ['Strict migration', 'Compatible'])).toBe('Strict migration');
    expect(flow.nextAgentResponse()).toEqual({ tool: 'plan', action: 'review' });
    expect(await flow.openBrowser('http://127.0.0.1/plan')).toEqual({ action: 'accept', payload: { revision: 'rfc-sha' } });

    expect(flow.eventsOf('ui.dialog')[0]?.data).toMatchObject({ response: 'Strict migration' });
    flow.assertSequence([
      'ui.working-message', 'ui.working-visible', 'ui.dialog',
      'agent.response', 'browser.opened', 'browser.response',
    ]);
  });

  test('captures every terminal widget and editor surface without rendering a real TUI', () => {
    const flow = createPiFlowHarness();
    const component = () => undefined;

    flow.ui.setHiddenThinkingLabel('Planning');
    flow.ui.setStatus('octocode-activity', 'Planning…');
    flow.ui.setWidget('plan', ['1. [doing] Implement'], { placement: 'aboveEditor' });
    flow.ui.setFooter(component);
    flow.ui.setHeader(component);
    flow.ui.setTitle('Octocode · Planning');
    flow.ui.setWorkingMessage('Working…');
    flow.ui.setWorkingVisible(true);
    flow.ui.setWorkingIndicator({ frame: 1 });
    flow.ui.notify('RFC ready', 'info');
    flow.ui.setEditorText('start');
    flow.ui.pasteToEditor(' plan');

    expect(flow.ui.getEditorText()).toBe('start plan');
    expect(flow.events.map((event) => event.kind)).toEqual([
      'session.started', 'ui.status', 'ui.status', 'ui.widget', 'ui.footer', 'ui.header',
      'ui.title', 'ui.working-message', 'ui.working-visible', 'ui.working-indicator',
      'ui.notification', 'ui.editor', 'ui.editor',
    ]);
  });

  test('preserves durable state across restart and fork while rotating session context', async () => {
    const flow = createPiFlowHarness({ sessionId: 'planning-session' });
    flow.durable.set('acceptedRevision', 'sha-1');
    const initialContext = flow.context;
    await flow.restart();

    expect(flow.session.id).toBe('planning-session');
    expect(flow.session.generation).toBe(1);
    expect(flow.context).not.toBe(initialContext);
    expect(flow.durable.get('acceptedRevision')).toBe('sha-1');

    await flow.fork('accepted-entry');
    expect(flow.session.parentId).toBe('planning-session');
    expect(flow.session.id).toBe('planning-session-fork-2');
    expect(flow.durable.get('acceptedRevision')).toBe('sha-1');
    flow.assertSequence(['session.restarted', 'session.forked']);
  });

  test('covers command, message, context, and remaining scripted UI APIs', async () => {
    let now = 100;
    const flow = createPiFlowHarness({
      hasUI: false,
      mode: 'rpc',
      trusted: false,
      contextTokens: 42,
      contextWindow: 1_000,
      now: () => ++now,
      scripted: { inputs: ['typed'], editors: ['edited'], customs: [{ answer: 1 }] },
    });
    flow.script('confirms', true);
    flow.script('selects', undefined);
    flow.pi.registerCommand('exercise', {
      handler: async (args, context) => {
        context.sendUserMessage(`command:${args}`, { deliverAs: 'followUp' });
        flow.pi.sendMessage({ customType: 'test', content: 'event' }, { triggerTurn: false });
      },
    });

    await flow.runCommand('exercise', 'all');
    expect(await flow.ui.confirm('Confirm', 'Continue?')).toBe(true);
    expect(await flow.ui.select('Optional', ['one'])).toBeUndefined();
    expect(await flow.ui.input('Input')).toBe('typed');
    expect(await flow.ui.editor('Editor', 'before')).toBe('edited');
    expect(await flow.ui.custom(() => undefined)).toEqual({ answer: 1 });

    flow.pi.setActiveTools(['plan', 'askUser']);
    expect(flow.pi.getActiveTools()).toEqual(['plan', 'askUser']);
    flow.pi.appendEntry('receipt', { id: 'r1' });
    expect(flow.context.sessionManager.getEntries()).toEqual([{ type: 'custom', customType: 'receipt', data: { id: 'r1' } }]);
    expect(flow.context.sessionManager.getBranch()).toHaveLength(1);
    expect(flow.context.sessionManager.getCwd()).toBe('/workspace');
    expect(flow.context.sessionManager.getSessionDir()).toContain('/.pi/sessions');
    expect(flow.context.sessionManager.getSessionFile()).toContain('session-1.jsonl');
    expect(flow.context.sessionManager.getLeafId()).toBe('session-1:leaf');
    flow.pi.setSessionName('RFC session');
    expect(flow.pi.getSessionName()).toBe('RFC session');
    expect(flow.context.sessionManager.getSessionName()).toBe('RFC session');
    expect(flow.context.isProjectTrusted()).toBe(false);
    expect(flow.context.getContextUsage()).toEqual({ tokens: 42, contextWindow: 1_000 });

    let compacted: unknown;
    flow.context.compact({ customInstructions: 'retain plan', onComplete: (result) => { compacted = result; } });
    expect(compacted).toEqual({ compacted: true });
    flow.recordState('activity', 'planning');
    expect(flow.last<{ name: string; value: string }>('state.changed')?.data).toEqual({ name: 'activity', value: 'planning' });
    expect(flow.events[0]?.timestamp).toBe(101);

    let replacementId = '';
    await flow.context.newSession({ withSession: async (context) => { replacementId = context.sessionManager.getSessionId(); } });
    expect(replacementId).toBe('session-2');
    let forkId = '';
    await flow.context.fork('entry-1', { withSession: async (context) => { forkId = context.sessionManager.getSessionId(); } });
    expect(forkId).toContain('-fork-');
    await flow.context.waitForIdle();
    await flow.context.reload();

    flow.assertSequence([
      'command.started', 'message.user', 'message.custom', 'command.finished',
      'context.compacted', 'state.changed', 'session.new', 'session.forked', 'session.restarted',
    ]);
  });

  test('expands registered slash commands and leaves ordinary prompts on the user-message path', async () => {
    const flow = createPiFlowHarness();
    const calls: string[] = [];
    flow.pi.registerCommand('octocode-plan', { handler: (args) => { calls.push(args); } });

    await expect(flow.expandPrompt('/octocode-plan accept sha-1')).resolves.toBe('command');
    await expect(flow.expandPrompt('continue reviewing')).resolves.toBe('message');

    expect(calls).toEqual(['accept sha-1']);
    expect(flow.eventsOf('message.user')).toHaveLength(1);
    flow.assertSequence(['command.expanded', 'command.started', 'command.finished', 'message.user']);

    flow.pi.sendUserMessage('/octocode-plan start sha-1', { expandPromptTemplates: true });
    await flow.waitForIdle();
    expect(calls).toEqual(['accept sha-1', 'start sha-1']);
  });

  test('drives a custom component with scripted keyboard input and optional focus suppression', async () => {
    const flow = createPiFlowHarness({ scripted: { customs: [{ inputs: ['typed'], focus: false }] } });
    const result = await flow.ui.custom<string>((
      _tui: unknown,
      _theme: unknown,
      _keys: unknown,
      done: (value: string) => void,
    ) => ({ focused: true, handleInput: (input: string) => done(input) }));
    expect(result).toBe('typed');
    expect(flow.last<{ response: string }>('ui.dialog')?.data.response).toBe('typed');
  });

  test('posts browser feedback over loopback HTTP and records a normalized response', async () => {
    const received: Array<{ method?: string; origin?: string; body: string }> = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        received.push({ method: request.method, origin: request.headers.origin, body });
        response.writeHead(202, { 'content-type': 'text/plain' });
        response.end('accepted');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing loopback address');
      const flow = createPiFlowHarness();
      const result = await flow.postBrowserMessage({
        url: `http://127.0.0.1:${address.port}/plan/`,
        message: '/octocode-plan accept sha-1',
      });
      expect(result).toEqual({ status: 202, body: 'accepted' });
      expect(received).toEqual([{
        method: 'POST',
        origin: `http://127.0.0.1:${address.port}`,
        body: JSON.stringify({ message: '/octocode-plan accept sha-1' }),
      }]);
      flow.assertSequence(['browser.request', 'browser.response']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('isolates a caller-supplied production store and cleans it exactly once', async () => {
    let closed = 0;
    const isolated = await createIsolatedAwarenessStore(
      ({ workspace, dbPath }) => {
        fs.writeFileSync(dbPath, 'sqlite');
        return { workspace, dbPath };
      },
      { close: () => { closed += 1; } },
    );
    expect(fs.existsSync(isolated.dbPath)).toBe(true);
    expect(isolated.store).toEqual({ workspace: isolated.workspace, dbPath: isolated.dbPath });
    await isolated.cleanup();
    await isolated.cleanup();
    expect(closed).toBe(1);
    expect(fs.existsSync(isolated.root)).toBe(false);

    let failedRoot = '';
    await expect(createIsolatedAwarenessStore(({ dbPath }) => {
      failedRoot = dbPath.slice(0, dbPath.lastIndexOf('/'));
      throw new Error('store open failed');
    })).rejects.toThrow('store open failed');
    expect(fs.existsSync(failedRoot)).toBe(false);
  });

  test('orders new, restart, fork, and tree events and normalizes volatile workspace paths', async () => {
    const flow = createPiFlowHarness({ cwd: '/tmp/volatile-workspace', sessionId: 'lifecycle' });
    await flow.newSession();
    await flow.restart();
    await flow.fork();
    await flow.tree();
    flow.pi.sendUserMessage('/tmp/volatile-workspace/RFC.md');

    flow.assertSequence(['session.new', 'session.restarted', 'session.forked', 'session.tree']);
    expect(JSON.stringify(flow.normalizedTranscript())).toContain('<workspace>/RFC.md');
    expect(JSON.stringify(flow.normalizedTranscript())).not.toContain('/tmp/volatile-workspace');
  });

  test('records thrown tool results and cancelled forks as explicit fail-closed branches', async () => {
    const flow = createPiFlowHarness();
    flow.pi.registerTool({ name: 'explode', execute: async () => { throw new Error('boom'); } });
    flow.pi.on('tool_execution_end', async () => undefined);
    await expect(flow.runTool('explode', {})).rejects.toThrow('boom');
    expect(flow.last<{ isError: boolean }>('tool.finished')?.data.isError).toBe(true);
    expect(JSON.stringify(flow.normalizedTranscript())).toContain('boom');

    const sessionId = flow.session.id;
    flow.pi.on('session_before_fork', async () => ({ cancel: true }));
    await flow.fork('blocked-entry');
    expect(flow.session.id).toBe(sessionId);
    await expect(flow.runTool('missing', {})).rejects.toThrow(/Unknown mocked Pi tool/);
    await expect(flow.runCommand('missing')).rejects.toThrow(/Unknown mocked Pi command/);
  });

  test('fails loudly for exhausted scripts, duplicate registration, blocked tools, and pre-aborted calls', async () => {
    const flow = createPiFlowHarness();
    expect(() => flow.nextAgentResponse()).toThrow(/No scripted agent response/);

    const definition = { name: 'write', execute: async () => ({ content: [] }) };
    flow.pi.registerTool(definition);
    expect(() => flow.pi.registerTool(definition)).toThrow(/Duplicate mocked Pi tool/);

    const blocked = createPiFlowHarness();
    blocked.pi.registerTool(definition);
    blocked.pi.on('tool_call', async () => ({ block: true, reason: 'policy denied' }));
    await expect(blocked.runTool('write', {})).rejects.toThrow('policy denied');

    const controller = new AbortController();
    controller.abort(new Error('operator cancelled'));
    await expect(flow.runTool('write', {}, { signal: controller.signal })).rejects.toThrow('operator cancelled');
  });
});
