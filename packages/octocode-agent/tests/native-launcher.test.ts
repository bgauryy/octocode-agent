import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySessionStore,
  LifecycleBus,
  ToolRegistry,
  TransactionalSessionStore,
  createEffectSet,
  revision,
  sessionEventId,
  sessionId,
  type AgentRuntime,
  type ModelPort,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimeSnapshot,
} from '@octocodeai/agent-core';

import {
  createNativeSessionStore,
  createDefaultNativeRuntime,
  createNativeSessionEffectLedger,
  createRuntimeEventPersister,
  launchNativeAgent,
  nativeToolApprovalMessage,
  nativeEffectAllowed,
  parseNativeArgs,
  retainedCompactionEventIds,
  resolveNativeSessionId,
  resolveNativeWorkerCapabilities,
  resolveNativeWorkspaceTrust,
} from '../src/native-launcher.js';
import { FileSessionRecordPort } from '../src/native-session-store.js';
import { FileSettingsStorage } from '../src/native-settings.js';
import { createNativeInteractionBroker } from '../src/native-interactions.js';
import type { RuntimePlanSnapshot } from '../src/native-plan.js';
import { nativeSessionsDir } from '../src/sessions.js';
import { readBreadcrumb, writeBreadcrumb } from '../src/state.js';
import { createOpenTuiTerminal } from '../src/terminal/opentui/create-terminal.js';

function fakeRuntime(): AgentRuntime {
  return {
    start: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ ok: true, data: {} })),
    snapshot: () => ({ state: 'ready' }) as RuntimeSnapshot,
    subscribe: () => () => undefined,
    stop: vi.fn(async () => undefined),
  };
}

describe('native launcher', () => {
  it('allows only explicitly composed native mutation adapters', () => {
    expect(nativeEffectAllowed({ effects: createEffectSet('write'), operation: 'tool:awareness' })).toBe(true);
    expect(nativeEffectAllowed({ effects: createEffectSet('network', 'write'), operation: 'tool:plan' })).toBe(true);
    expect(nativeEffectAllowed({ effects: createEffectSet('network', 'process'), operation: 'tool:worker' })).toBe(true);
    expect(nativeEffectAllowed({ effects: createEffectSet('write'), operation: 'tool:unknown' })).toBe(false);
    expect(nativeEffectAllowed({ effects: createEffectSet('read', 'destructive'), operation: 'tool:awareness' })).toBe(false);
  });

  it('parses interactive, print/json, and rpc modes without host-specific flags', () => {
    expect(parseNativeArgs([]).mode).toBe('interactive');
    expect(parseNativeArgs(['-p', 'hello'])).toMatchObject({ mode: 'print', outputFormat: 'text' });
    expect(parseNativeArgs(['--mode', 'text', 'hello'])).toMatchObject({ mode: 'print', outputFormat: 'text' });
    expect(parseNativeArgs(['--mode', 'json', 'hello'])).toMatchObject({ mode: 'print', outputFormat: 'json' });
    expect(parseNativeArgs(['--mode', 'rpc'])).toMatchObject({ mode: 'rpc' });
    expect(parseNativeArgs(['--mode', 'rpc', '--allow-workers'])).toMatchObject({ mode: 'rpc', allowWorkers: true });
    expect(parseNativeArgs(['--accessible'])).toMatchObject({ mode: 'interactive', accessible: true });
  });

  it('rejects unknown options and missing or invalid option values', () => {
    expect(() => parseNativeArgs(['--unknown'])).toThrow('Unknown native option: --unknown');
    expect(() => parseNativeArgs(['--mode'])).toThrow('Missing value for --mode');
    expect(() => parseNativeArgs(['--mode', '--print'])).toThrow('Missing value for --mode');
    expect(() => parseNativeArgs(['--mode', 'yaml'])).toThrow('Invalid value for --mode: yaml');
    expect(() => parseNativeArgs(['--session'])).toThrow('Missing value for --session');
    expect(() => parseNativeArgs(['--name', '   '])).toThrow('Invalid value for --name');
    expect(() => parseNativeArgs(['-n', '--print'])).toThrow('Missing value for -n');
  });

  it('treats every token after -- as prompt text, including option-shaped tokens', async () => {
    expect(parseNativeArgs(['--print', '--', '-leading', '--literal'])).toMatchObject({
      mode: 'print',
      initialMessage: '-leading',
      rest: ['--literal'],
    });

    const runtime = fakeRuntime();
    await expect(launchNativeAgent(['--print', '--', '-leading', '--literal'], {
      createRuntime: async () => runtime,
      stdout: new PassThrough(),
    })).resolves.toBe(0);
    expect(runtime.submit).toHaveBeenCalledWith('-leading --literal');
  });

  it('resolves explicit per-workspace trust from native settings and otherwise fails closed', () => {
    expect(resolveNativeWorkspaceTrust('/workspace', { workspaceTrust: { '/workspace': 'trusted' } })).toBe('trusted');
    expect(resolveNativeWorkspaceTrust('/workspace', { workspaceTrust: { '/workspace': 'untrusted' } })).toBe('untrusted');
    expect(resolveNativeWorkspaceTrust('/workspace', { workspaceTrust: { '/workspace': true } })).toBe('unknown');
    expect(resolveNativeWorkspaceTrust('/workspace', {})).toBe('unknown');
  });

  it('scopes MCP approval copy to the requested server and operation without arguments', () => {
    const message = nativeToolApprovalMessage({
      name: 'MCPTool',
      input: { action: 'call', server: 'workspace-tools', tool: 'write_file', arguments: { token: 'secret-value' } },
      policy: { effects: createEffectSet('network', 'process') },
    });
    expect(message).toContain('workspace-tools');
    expect(message).toContain('call');
    expect(message).toContain('write_file');
    expect(message).not.toContain('secret-value');
  });

  it('does not construct OpenTUI for print mode', async () => {
    const runtime = fakeRuntime();
    const createTerminal = vi.fn();
    const createSettingsPage = vi.fn();
    const output: string[] = [];
    await expect(launchNativeAgent(['-p', 'hello'], {
      createRuntime: async () => runtime,
      createTerminal,
      createSettingsPage,
      stdout: { write: (value: string) => { output.push(value); return true; } } as never,
    })).resolves.toBe(0);
    expect(createTerminal).not.toHaveBeenCalled();
    expect(createSettingsPage).not.toHaveBeenCalled();
    expect(runtime.submit).toHaveBeenCalledWith('hello');
  });

  it('routes /settings through one interactive controller and closes it during teardown', async () => {
    const runtime = fakeRuntime();
    const open = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:43123/#models' }));
    const close = vi.fn(async () => undefined);
    const createSettingsPage = vi.fn(() => ({ open, close, diagnostics: () => ({ actionToken: 'test' }) }));
    let runtimeSettings: unknown;
    const terminal = {
      start: vi.fn(async () => undefined), accept: vi.fn(), stop: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ ready: true })), acceptInput: vi.fn(() => false),
    };
    await expect(launchNativeAgent([], {
      createRuntime: async (options) => { runtimeSettings = options.settings; return runtime; },
      createTerminal: () => terminal,
      createSettingsPage,
      createLineReader: async function* () { yield '/settings models'; yield '/exit'; },
      stdin: new PassThrough(),
    })).resolves.toBe(0);
    expect(createSettingsPage).toHaveBeenCalledOnce();
    expect(createSettingsPage.mock.calls[0]![0].settings).toBe(runtimeSettings);
    expect(createSettingsPage.mock.calls[0]![0].extensions.snapshot().discovered).toBe(true);
    expect(open).toHaveBeenCalledWith('models');
    expect(close).toHaveBeenCalledOnce();
    expect(runtime.submit).not.toHaveBeenCalled();
  });

  it('cleans up constructed interactive resources when terminal startup fails without masking that failure', async () => {
    const runtime = fakeRuntime();
    runtime.stop = vi.fn(async () => { throw new Error('runtime cleanup failed'); });
    const close = vi.fn(async () => { throw new Error('page cleanup failed'); });
    const terminal = {
      start: vi.fn(async () => { throw new Error('terminal startup failed'); }),
      accept: vi.fn(),
      stop: vi.fn(async () => { throw new Error('terminal cleanup failed'); }),
      snapshot: vi.fn(),
    };

    await expect(launchNativeAgent([], {
      createRuntime: async () => runtime,
      createTerminal: () => terminal,
      createSettingsPage: () => ({ open: vi.fn(), close, diagnostics: () => ({ actionToken: 'test' }) }),
      stdin: new PassThrough(),
    })).rejects.toThrow('terminal startup failed');

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(terminal.stop).toHaveBeenCalledOnce();
  });

  it('reads a missing print prompt from piped stdin and rejects an empty TTY before runtime creation', async () => {
    const runtime = fakeRuntime();
    const piped = new PassThrough();
    piped.end('piped prompt\n');
    await expect(launchNativeAgent(['--print'], {
      createRuntime: async () => runtime,
      stdin: piped,
      stdout: new PassThrough(),
    })).resolves.toBe(0);
    expect(runtime.submit).toHaveBeenCalledWith('piped prompt');

    const createRuntime = vi.fn(async () => fakeRuntime());
    const errors: string[] = [];
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    await expect(launchNativeAgent(['--print'], {
      createRuntime,
      stdin: tty,
      stderr: { write: (value: string) => { errors.push(value); return true; } } as never,
    })).resolves.toBe(2);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(errors.join('')).toMatch(/requires a prompt/i);
  });

  it('does not construct OpenTUI for RPC mode', async () => {
    const runtime = fakeRuntime();
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();
    const createTerminal = vi.fn();
    const createSettingsPage = vi.fn();
    await expect(launchNativeAgent(['--mode', 'rpc'], {
      createRuntime: async () => runtime,
      createTerminal,
      createSettingsPage,
      stdin: input,
      stdout: output,
    })).resolves.toBe(0);
    expect(createTerminal).not.toHaveBeenCalled();
    expect(createSettingsPage).not.toHaveBeenCalled();
  });

  it('forwards authoritative native plan snapshots into the interactive terminal', async () => {
    const input = new PassThrough();
    input.end('/exit\n');
    const runtime = fakeRuntime();
    const plan: RuntimePlanSnapshot = {
      authority: 'runtime',
      planId: 'plan:stable',
      scope: { sessionId: 'session-1', workspace: '/workspace' },
      revision: 2,
      phase: 'active',
      steps: [{ id: 'step-1', text: 'Implement', status: 'doing' }],
    };
    const terminal = {
      start: vi.fn(async () => undefined),
      accept: vi.fn(),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(),
    };

    await expect(launchNativeAgent([], {
      createRuntime: async ({ onPlanSnapshot }) => {
        runtime.start = vi.fn(async () => { onPlanSnapshot?.(plan); });
        return runtime;
      },
      createTerminal: () => terminal,
      stdin: input,
    })).resolves.toBe(0);

    expect(terminal.accept).toHaveBeenCalledWith({
      type: 'runtime-widgets-changed',
      snapshots: { plan },
    });
  });

  it('keeps the terminal owned and subscribed through runtime shutdown failures', async () => {
    const input = new PassThrough();
    input.end();
    let subscribed = false;
    const runtime = fakeRuntime();
    runtime.subscribe = vi.fn(() => {
      subscribed = true;
      return () => { subscribed = false; };
    });
    runtime.stop = vi.fn(async () => {
      expect(subscribed).toBe(true);
      throw new Error('runtime stop failed');
    });
    const terminal = {
      start: vi.fn(async () => undefined),
      accept: vi.fn(),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(),
    };

    await expect(launchNativeAgent([], {
      createRuntime: async () => runtime,
      createTerminal: () => terminal,
      stdin: input,
    })).rejects.toThrow('runtime stop failed');

    expect(terminal.stop).toHaveBeenCalledOnce();
    expect(subscribed).toBe(false);
  });

  it('attaches askUser before submit and routes interaction answers through the sole line reader', async () => {
    const input = new PassThrough();
    input.end('ask\nblue\n/exit\n');
    const runtime = fakeRuntime();
    const submitted: string[] = [];
    let interactionResult: unknown;
    let resolveInteraction: ((value: { status: 'accepted'; value: string }) => void) | undefined;
    const terminal = {
      start: vi.fn(async () => undefined),
      accept: vi.fn(),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(),
      interact: vi.fn(async () => new Promise<{ status: 'accepted'; value: string }>((resolve) => { resolveInteraction = resolve; })),
      acceptInput: vi.fn((line: string) => {
        if (!resolveInteraction) return false;
        resolveInteraction({ status: 'accepted', value: line });
        resolveInteraction = undefined;
        return true;
      }),
    };

    await expect(launchNativeAgent([], {
      createRuntime: async ({ interactions }) => {
        runtime.submit = vi.fn(async (text: string) => {
          submitted.push(text);
          interactionResult = await interactions.interact({ type: 'input', message: 'Favourite colour?' }, new AbortController().signal);
        });
        return runtime;
      },
      createTerminal: () => terminal,
      stdin: input,
    })).resolves.toBe(0);

    expect(submitted).toEqual(['ask']);
    expect(terminal.acceptInput).toHaveBeenCalledWith('blue');
    expect(interactionResult).toEqual({ status: 'accepted', value: 'blue' });
  });

  it('queues non-interaction lines as FIFO follow-ups while a turn is active', async () => {
    const input = new PassThrough();
    input.end('first\nsecond\nthird\n/exit\n');
    const runtime = fakeRuntime();
    const finishSubmissions: Array<() => void> = [];
    runtime.submit = vi.fn(async () => new Promise<void>((resolve) => { finishSubmissions.push(resolve); }));
    runtime.stop = vi.fn(async () => { for (const finish of finishSubmissions) finish(); });
    const commands: unknown[] = [];
    runtime.execute = vi.fn(async (command) => { commands.push(command); return { ok: true, data: {} }; });
    const terminal = { start: vi.fn(async () => undefined), accept: vi.fn(), stop: vi.fn(async () => undefined), snapshot: vi.fn(), acceptInput: vi.fn(() => false) };

    await launchNativeAgent([], { createRuntime: async () => runtime, createTerminal: () => terminal, stdin: input });

    expect(runtime.submit).toHaveBeenCalledTimes(1);
    expect(commands).toEqual([
      { type: 'input.follow-up', text: 'second' },
      { type: 'input.follow-up', text: 'third' },
    ]);
  });

  it('does not create readline when the native OpenTUI renderer owns stdin', async () => {
    const runtime = fakeRuntime();
    runtime.snapshot = () => ({
      state: 'ready',
      sessionId: sessionId('native:renderer-input'),
      model: { providerId: 'openai', modelId: 'test-model' },
    }) as RuntimeSnapshot;
    const accepted: unknown[] = [];
    const createLineReader = vi.fn(() => { throw new Error('readline must not be created'); });
    const terminal = {
      inputOwnership: 'renderer' as const,
      start: vi.fn(async () => undefined),
      accept: vi.fn((event: unknown) => { accepted.push(event); }),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ ready: true })),
      acceptInput: vi.fn(() => false),
      subscribeInput: vi.fn((listener: (event: { type: 'line'; line: string } | { type: 'interrupt' }) => void | Promise<void>) => {
        queueMicrotask(async () => {
          await listener({ type: 'line', line: 'native message' });
          await listener({ type: 'line', line: '/exit' });
        });
        return vi.fn();
      }),
      cancelInteraction: vi.fn(() => false),
    };

    await expect(launchNativeAgent([], {
      createRuntime: async () => runtime,
      createTerminal: () => terminal,
      createLineReader,
      stdin: new PassThrough(),
      env: { OCTOCODE_MODEL: 'test-model' },
    })).resolves.toBe(0);

    expect(createLineReader).not.toHaveBeenCalled();
    expect(runtime.submit).toHaveBeenCalledWith('native message');
    expect(accepted).toContainEqual(expect.objectContaining({
      type: 'runtime-widgets-changed',
      snapshots: expect.objectContaining({
        header: expect.objectContaining({ authority: 'runtime', modelId: 'test-model' }),
        footer: expect.objectContaining({ authority: 'runtime', activeMode: 'interactive' }),
      }),
    }));
  });

  it('terminates renderer-owned interactive mode when the terminal reports a fatal callback failure', async () => {
    const runtime = fakeRuntime();
    let reportFailure: ((error: unknown) => void) | undefined;
    const terminal = {
      inputOwnership: 'renderer' as const,
      start: vi.fn(async () => undefined),
      accept: vi.fn(),
      stop: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ ready: true })),
      subscribeInput: vi.fn(() => vi.fn()),
      subscribeFailure: vi.fn((listener: (error: unknown) => void) => {
        reportFailure = listener;
        queueMicrotask(() => reportFailure?.(new Error('terminal callback failed')));
        return vi.fn();
      }),
    };

    await expect(launchNativeAgent([], {
      createRuntime: async () => runtime,
      createTerminal: () => terminal,
      stdin: new PassThrough(),
    })).rejects.toThrow('terminal callback failed');
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(terminal.stop).toHaveBeenCalledOnce();
  });

  it('cancels active work and restores teardown on SIGTERM', async () => {
    const runtime = fakeRuntime();
    runtime.snapshot = () => ({ state: 'running' }) as RuntimeSnapshot;
    const listeners = new Map<string, () => void>();
    const signalSource = {
      on: vi.fn((signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
        listeners.set(signal, listener);
        if (signal === 'SIGTERM') queueMicrotask(listener);
      }),
      off: vi.fn((signal: 'SIGINT' | 'SIGTERM') => { listeners.delete(signal); }),
    };
    const terminal = {
      inputOwnership: 'renderer' as const,
      start: vi.fn(async () => undefined), accept: vi.fn(), stop: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({ ready: true })), subscribeInput: vi.fn(() => vi.fn()),
    };
    await expect(launchNativeAgent([], {
      createRuntime: async () => runtime,
      createTerminal: () => terminal,
      signalSource,
      stdin: new PassThrough(),
    })).resolves.toBe(0);

    expect(runtime.cancel).toHaveBeenCalledWith('process terminated');
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(signalSource.off).toHaveBeenCalledTimes(2);
  });

  it('publishes the configured production model through requests, snapshots, and events', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-model-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-model-workspace-'));
    const env = { OCTOCODE_HOME: home, OCTOCODE_MODEL: 'gpt-configured' };
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      run: async (request) => {
        requests.push(structuredClone(request));
        return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const runtime = await createDefaultNativeRuntime({
      env,
      cwd,
      args: parseNativeArgs(['--no-session']),
      model,
      tools: new ToolRegistry(),
    });
    const events: RuntimeEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => { events.push(event); });

    await runtime.submit('identify');

    expect(requests[0]?.model).toEqual({ providerId: 'openai', modelId: 'gpt-configured' });
    expect(runtime.snapshot().model).toEqual({ providerId: 'openai', modelId: 'gpt-configured' });
    expect(events.find((event) => event.type === 'provider.request-started')?.model).toEqual({
      providerId: 'openai',
      modelId: 'gpt-configured',
    });
    unsubscribe();
    await runtime.stop();
  });

  it('composes production session commands through fresh fixed-session runtimes', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-session-router-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-session-router-workspace-'));
    const env = { ...process.env, OCTOCODE_HOME: home };
    const workerProjections: unknown[] = [];
    const runtime = await createDefaultNativeRuntime({
      env,
      cwd,
      args: parseNativeArgs([]),
      model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } }) },
      onWorkerProjection: (projection) => { workerProjections.push(projection); },
    });
    const initial = runtime.snapshot().sessionId;
    const created = sessionId('native:created-through-router');
    expect(workerProjections).toHaveLength(1);

    await expect(runtime.execute({ type: 'session.create', id: created, name: 'Created' })).resolves.toMatchObject({
      ok: true,
      data: { sessionId: created, projection: { name: 'Created' } },
    });
    expect(runtime.snapshot().sessionId).toBe(created);
    expect(workerProjections).toHaveLength(2);
    expect(workerProjections[1]).not.toBe(workerProjections[0]);
    await runtime.submit('new session turn');
    expect((await createNativeSessionStore(false, nativeSessionsDir(env)).load(created)).projection.customEntries).toContainEqual(
      expect.objectContaining({ kind: 'session.cwd', value: cwd }),
    );

    await expect(runtime.execute({ type: 'session.switch', id: initial })).resolves.toMatchObject({ ok: true, data: { sessionId: initial } });
    expect(runtime.snapshot().sessionId).toBe(initial);
    expect(workerProjections).toHaveLength(3);
    expect(new Set(workerProjections).size).toBe(3);
    await runtime.stop();
  });

  it('composes Anthropic Messages as a first-class configured provider', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-anthropic-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-anthropic-workspace-'));
    const requests: ModelRequest[] = [];
    const runtime = await createDefaultNativeRuntime({
      env: {
        OCTOCODE_HOME: home,
        OCTOCODE_MODEL_PROTOCOL: 'anthropic-messages',
        OCTOCODE_MODEL: 'claude-test',
        ANTHROPIC_API_KEY: 'not-used-by-injected-port',
      },
      cwd,
      args: parseNativeArgs(['--no-session']),
      model: {
        run: async (request) => {
          requests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      tools: new ToolRegistry(),
    });

    await runtime.execute({ type: 'model.thinking', level: 'high' });
    await runtime.submit('identify');

    expect(requests[0]).toMatchObject({
      model: { providerId: 'anthropic', modelId: 'claude-test' },
      thinkingLevel: 'high',
    });
    expect(runtime.snapshot()).toMatchObject({
      model: { providerId: 'anthropic', modelId: 'claude-test' },
      thinkingLevel: 'high',
    });
    await runtime.stop();
  });

  it('rejects model capabilities that the composed native adapter cannot honor', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-capability-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-capability-workspace-'));
    const runtime = await createDefaultNativeRuntime({
      env: { OCTOCODE_HOME: home, OCTOCODE_MODEL: 'gpt-configured' },
      cwd,
      args: parseNativeArgs(['--no-session']),
      model: { run: vi.fn(async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } })) },
      tools: new ToolRegistry(),
    });

    await expect(runtime.execute({ type: 'model.select', providerId: 'anthropic', modelId: 'claude-test' })).resolves.toMatchObject({
      ok: false,
      error: { category: 'unsupported-capability' },
    });
    await expect(runtime.execute({ type: 'model.thinking', level: 'high' })).resolves.toMatchObject({
      ok: false,
      error: { category: 'unsupported-capability' },
    });
    expect(runtime.snapshot()).toMatchObject({
      model: { providerId: 'openai', modelId: 'gpt-configured' },
      thinkingLevel: null,
    });
    await runtime.stop();
  });

  it('cancels a pending approval interaction with the turn signal so the next line is not consumed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-approval-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-workspace-'));
    const env = { OCTOCODE_HOME: home };
    const settings = new FileSettingsStorage(path.join(home, 'agent', 'settings.json'));
    settings.commit('0', { workspaceTrust: { [cwd]: 'trusted' } });
    const tools = new ToolRegistry();
    tools.register({
      name: 'plan', label: 'Plan', description: 'approval probe', schemaVersion: 1,
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputVersion: 1,
      policy: { effects: createEffectSet('write'), trust: 'workspace', approval: 'on-request', plan: 'allowed' },
      execute: async () => ({ ok: true, content: {}, detailsVersion: 1 }),
    }, 'test');
    const model: ModelPort = {
      run: async (_request, context) => {
        await context.emit?.({ type: 'tool-call', id: 'approval-call', name: 'plan', input: { action: 'show' } });
        return { stop: 'tool', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const broker = createNativeInteractionBroker({ timeoutMs: 1_000 });
    const terminal = createOpenTuiTerminal({ createRenderer: async () => ({ destroy: () => undefined, render: () => undefined }) });
    await terminal.start();
    const detach = broker.attach(terminal.interact!.bind(terminal));
    const runtime = await createDefaultNativeRuntime({ env, cwd, args: parseNativeArgs([]), model, tools, interactions: broker });
    const pending = runtime.submit('go');
    await vi.waitFor(() => expect(terminal.snapshot().interaction?.status).toBe('pending'));

    await runtime.cancel('cancel approval');
    await pending;

    expect(terminal.snapshot().interaction?.status).toBe('cancelled');
    expect(terminal.acceptInput!('next prompt')).toBe(false);
    detach();
    await terminal.stop();
    await runtime.stop();
  });

  it('resolves specified and continue sessions from the canonical native store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-resume-'));
    const write = (id: string, cwd: string, mtime: number) => {
      const file = path.join(root, `${encodeURIComponent(id)}.json`);
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        sessionId: id,
        revision: '1',
        events: [{ schemaVersion: 1, sessionId: id, eventId: `${id}:1`, revision: '1', sequence: 1, timestamp: mtime, visibility: 'internal', event: { type: 'custom.appended', kind: 'session.cwd', value: cwd } }],
      }));
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    };
    write('native:old', '/workspace', 1_000);
    write('native:new', '/workspace', 2_000);

    expect(resolveNativeSessionId(parseNativeArgs(['--session', 'native:old']), '/workspace', root, () => 3_000)).toBe('native:old');
    expect(resolveNativeSessionId(parseNativeArgs(['--continue']), '/workspace', root, () => 3_000)).toBe('native:new');
    const preferred = path.join(root, `${encodeURIComponent('native:old')}.json`);
    expect(resolveNativeSessionId(parseNativeArgs(['--continue']), '/workspace', root, () => 3_000, preferred)).toBe('native:old');
    expect(resolveNativeSessionId(parseNativeArgs([]), '/workspace', root, () => 3_000, undefined, () => 'nonce')).toBe('native:3000:nonce');
    expect(() => resolveNativeSessionId(parseNativeArgs(['--session', 'missing']), '/workspace', root, () => 3_000)).toThrow(/not found/i);
  });

  it('lets the transactional store recover explicit and continued sessions from backup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-resume-backup-'));
    const port = new FileSessionRecordPort(root);
    const id = sessionId('native:recover');
    const record = JSON.stringify({
      schemaVersion: 1, sessionId: id, revision: '1',
      events: [{ schemaVersion: 1, sessionId: id, eventId: `${id}:1`, revision: '1', sequence: 1, timestamp: 1, visibility: 'internal', event: { type: 'custom.appended', kind: 'session.cwd', value: '/workspace' } }],
    });
    fs.writeFileSync(port.backupPathFor(id), record);

    expect(resolveNativeSessionId(parseNativeArgs(['--session', id]), '/workspace', root)).toBe(id);
    expect(resolveNativeSessionId(parseNativeArgs(['--continue']), '/workspace', root)).toBe(id);
    expect(fs.existsSync(port.pathFor(id))).toBe(false);
    await expect(port.read(id)).resolves.toEqual({ content: record, recovered: true });
    fs.writeFileSync(port.pathFor(id), '{corrupt');
    expect(resolveNativeSessionId(parseNativeArgs(['--continue']), '/workspace', root)).toBe(id);
    await expect(port.read(id)).resolves.toEqual({ content: record, recovered: true });
  });

  it('routes a corrupt explicit session into typed store corruption instead of reporting it missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-resume-corrupt-'));
    const port = new FileSessionRecordPort(root);
    const id = sessionId('native:corrupt');
    fs.writeFileSync(port.pathFor(id), '{corrupt');

    expect(resolveNativeSessionId(parseNativeArgs(['--session', id]), '/workspace', root)).toBe(id);
    await expect(port.read(id)).rejects.toThrow(/corrupt/i);
  });

  it('creates collision-resistant session ids even when clocks are identical', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-session-id-'));
    const first = resolveNativeSessionId(parseNativeArgs([]), '/workspace', root, () => 3_000, undefined, () => 'first');
    const second = resolveNativeSessionId(parseNativeArgs([]), '/workspace', root, () => 3_000, undefined, () => 'second');
    expect(first).toBe('native:3000:first');
    expect(second).toBe('native:3000:second');
    expect(first).not.toBe(second);
  });

  it('keeps no-session state entirely in memory', async () => {
    const root = path.join(os.tmpdir(), `octocode-no-session-${process.pid}-${Date.now()}`);
    const store = createNativeSessionStore(true, root);
    const id = sessionId('memory:test');

    await store.append(id, revision('0'), [{
      schemaVersion: 1,
      sessionId: id,
      eventId: sessionEventId('memory:created'),
      revision: revision('1'),
      sequence: 1,
      timestamp: 1,
      visibility: 'internal',
      event: { type: 'session.created' },
    }]);

    expect(fs.existsSync(root)).toBe(false);
    expect((await store.load(id)).projection.revision).toBe(revision('1'));
  });

  it('persists streamed text deltas as one logical assistant message', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:aggregate');
    await store.append(id, revision('0'), [{
      schemaVersion: 1,
      sessionId: id,
      eventId: sessionEventId('created'),
      revision: revision('1'),
      sequence: 1,
      timestamp: 1,
      visibility: 'internal',
      event: { type: 'session.created' },
    }]);
    const persist = createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') });
    const runtimeEvent = (type: RuntimeEvent['type'], eventId: string, payload: unknown): RuntimeEvent => ({
      schemaVersion: 1,
      eventVersion: 1,
      id: eventId as RuntimeEvent['id'],
      type,
      phase: 'notification',
      sessionId: id,
      timestamp: 2,
      cwd: '/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      payload,
    });
    await persist(runtimeEvent('message.delta', 'delta-1', { type: 'text', text: 'hel' }));
    await persist(runtimeEvent('message.delta', 'delta-2', { type: 'text', text: 'lo' }));
    await persist(runtimeEvent('message.ended', 'message-1', { status: 'complete' }));

    const loaded = await store.load(id);
    expect(loaded.projection.transcript).toHaveLength(1);
    expect(loaded.projection.transcript[0]?.content).toBe('hello');
    expect(loaded.projection.modelContext[0]).toMatchObject({ role: 'assistant', content: 'hello' });
  });

  it('commits peer context and its replay marker atomically before outbox acknowledgement', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:peer-context');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const persist = createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') });
    await persist({
      schemaVersion: 1,
      eventVersion: 1,
      id: 'runtime:peer-context' as RuntimeEvent['id'],
      type: 'context.appended',
      phase: 'after',
      sessionId: id,
      timestamp: 2,
      cwd: '/workspace',
      mode: 'headless',
      trust: { workspace: 'trusted', managedOnly: false },
      payload: { eventId: 'outbox-event-1', text: '[peer:child; authority:data]\nverified', provenance: 'peer-attributed-data' },
    });

    const loaded = await store.load(id);
    expect(loaded.projection.revision).toBe(revision('3'));
    expect(loaded.projection.modelContext).toEqual([
      expect.objectContaining({ role: 'system', content: '[peer:child; authority:data]\nverified' }),
    ]);
    expect(loaded.projection.customEntries).toEqual([
      expect.objectContaining({ kind: 'native.context.event', value: { eventId: 'outbox-event-1', provenance: 'peer-attributed-data' } }),
    ]);
    expect(loaded.events.slice(-2).map((event) => event.causationId)).toEqual(['outbox-event-1', 'outbox-event-1']);
  });

  it('dispatches lifecycle decisions before persistence and returns the effective result', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:lifecycle-authority');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const order: string[] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (...args) => {
      order.push('append');
      return await append(...args);
    });
    const bus = new LifecycleBus<unknown>({
      eventType: 'tool.requested',
      authority: ['rewrite', 'context', 'allow-deny', 'stop'],
      validate: (payload): payload is unknown => typeof payload === 'object' && payload !== null,
    });
    bus.subscribe({
      id: 'rewrite-before-persist',
      source: 'builtin',
      handler: async () => {
        order.push('dispatch');
        return { kind: 'rewrite', payload: { callId: 'rewritten-id-must-not-win', name: 'safe', input: { approved: true } } };
      },
    });
    bus.subscribe({
      id: 'context-after-result',
      source: 'builtin',
      declarationOrder: 1,
      handler: async () => ({ kind: 'context', text: 'Workspace policy: redact secrets.' }),
    });
    const persist = createRuntimeEventPersister({
      sessions: store,
      activeSessionId: id,
      initialRevision: revision('1'),
      lifecycle: new Map([['tool.requested', bus]]),
    });
    const runtimeEvent = (type: RuntimeEvent['type'], eventId: string, payload: unknown): RuntimeEvent => ({
      schemaVersion: 1, eventVersion: 1, id: eventId as RuntimeEvent['id'], type, phase: type === 'tool.requested' ? 'permission' : 'notification', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false },
      payload,
    });

    await persist(runtimeEvent('message.delta', 'call-delta', { type: 'tool-call', id: 'call-1', name: 'unsafe', input: { approved: false } }));
    await persist(runtimeEvent('message.ended', 'message-ended', { status: 'complete' }));
    expect((await store.load(id)).projection.modelContext).toEqual([]);
    order.length = 0;

    const result = await persist(runtimeEvent('tool.requested', 'tool-requested', { callId: 'call-1', name: 'unsafe', input: { approved: false } }));

    expect(order).toEqual(['dispatch', 'append', 'append']);
    expect(result.payload).toEqual({ callId: 'call-1', name: 'safe', input: { approved: true } });
    expect((await store.load(id)).events.at(-1)?.event).toMatchObject({
      type: 'custom.appended',
      kind: 'tool.requested',
      value: { callId: 'call-1', name: 'safe', input: { approved: true } },
    });

    await persist(runtimeEvent('tool.ended', 'tool-ended', { callId: 'call-1', name: 'safe', result: { ok: true } }));
    expect((await store.load(id)).projection.modelContext).toEqual([
      { eventId: expect.any(String), role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'safe', input: { approved: true } }] },
      { eventId: expect.any(String), role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
      { eventId: expect.any(String), role: 'system', content: 'Workspace policy: redact secrets.' },
    ]);
  });

  it.each(['deny', 'stop'] as const)('keeps %s input lifecycle decisions out of durable model history', async (decision) => {
    const store = new InMemorySessionStore();
    const id = sessionId(`native:input-${decision}`);
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const bus = new LifecycleBus<unknown>({
      eventType: 'input.received',
      authority: ['allow-deny', 'stop'],
      validate: (payload): payload is unknown => typeof payload === 'object' && payload !== null,
    });
    bus.subscribe({
      id: `input-${decision}`,
      source: 'builtin',
      handler: async () => decision === 'deny'
        ? { kind: 'deny', reason: 'blocked by lifecycle' }
        : { kind: 'stop', reason: 'handled by lifecycle' },
    });
    const persist = createRuntimeEventPersister({
      sessions: store,
      activeSessionId: id,
      initialRevision: revision('1'),
      lifecycle: new Map([['input.received', bus]]),
    });

    const result = await persist({
      schemaVersion: 1, eventVersion: 1, id: `input-${decision}` as RuntimeEvent['id'], type: 'input.received', phase: 'before', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload: { text: 'must not resume' },
    });

    const loaded = await store.load(id);
    expect(result.decision.kind).toBe(decision);
    expect(loaded.projection.modelContext).toEqual([]);
    expect(loaded.events.at(-1)).toMatchObject({
      visibility: 'diagnostics',
      event: { type: 'custom.appended', kind: 'input.received', value: { text: 'must not resume' } },
    });
  });

  it('runs owned runtime cleanup exactly once when shutdown starts', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:runtime-cleanup');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const cleanup = vi.fn(async () => undefined);
    const persist = createRuntimeEventPersister({
      sessions: store,
      activeSessionId: id,
      initialRevision: revision('1'),
      onRuntimeStopping: cleanup,
    });
    const stopping = (eventId: string): RuntimeEvent => ({
      schemaVersion: 1, eventVersion: 1, id: eventId as RuntimeEvent['id'], type: 'runtime.stopping', phase: 'after', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload: {},
    });

    await persist(stopping('stopping-1'));
    await persist(stopping('stopping-2'));

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not persist partial provider output that the runtime cancels', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:cancelled-partial');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const persist = createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') });
    const runtimeEvent = (type: RuntimeEvent['type'], eventId: string, payload: unknown): RuntimeEvent => ({
      schemaVersion: 1, eventVersion: 1, id: eventId as RuntimeEvent['id'], type, phase: 'notification', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload,
    });

    await persist(runtimeEvent('message.delta', 'partial', { type: 'text', text: 'discard me' }));
    await persist(runtimeEvent('provider.response-received', 'cancelled-response', { stop: 'cancelled' }));
    await persist(runtimeEvent('turn.ended', 'cancelled-turn', { stop: 'cancelled' }));

    expect((await store.load(id)).projection.modelContext).toEqual([]);
  });

  it('persists assistant tool calls and correlated results in model-visible order', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:tools');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const persist = createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') });
    const runtimeEvent = (type: RuntimeEvent['type'], eventId: string, payload: unknown): RuntimeEvent => ({
      schemaVersion: 1, eventVersion: 1, id: eventId as RuntimeEvent['id'], type, phase: 'notification', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload,
    });

    await persist(runtimeEvent('message.delta', 'call-delta', { type: 'tool-call', id: 'call-1', name: 'lookup', input: { q: 1 } }));
    await persist(runtimeEvent('message.ended', 'message-1', { status: 'complete' }));
    await persist(runtimeEvent('tool.ended', 'tool-1', { callId: 'call-1', name: 'lookup', result: { ok: true } }));

    expect((await store.load(id)).projection.modelContext).toEqual([
      { eventId: sessionEventId(`${id}:runtime-event:3`), role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'lookup', input: { q: 1 } }] },
      { eventId: sessionEventId(`${id}:runtime-event:4`), role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
    ]);
  });

  it('allocates persisted event ids from durable session sequence across runtime resumes', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:event-identity');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const runtimeEvent = (eventId: string): RuntimeEvent => ({
      schemaVersion: 1, eventVersion: 1, id: eventId as RuntimeEvent['id'], type: 'runtime.ready', phase: 'notification', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload: {},
    });

    await createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') })(runtimeEvent('runtime:1'));
    await createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('2') })(runtimeEvent('runtime:1'));

    const loaded = await store.load(id);
    expect(loaded.events.map((event) => event.eventId)).toEqual([
      sessionEventId('created'),
      sessionEventId(`${id}:runtime-event:2`),
      sessionEventId(`${id}:runtime-event:3`),
    ]);
  });

  it('persists blocked and cancelled tool calls as terminal model-visible results', async () => {
    const store = new InMemorySessionStore();
    const id = sessionId('native:terminal-tools');
    await store.append(id, revision('0'), [{
      schemaVersion: 1, sessionId: id, eventId: sessionEventId('created'), revision: revision('1'), sequence: 1,
      timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
    }]);
    const persist = createRuntimeEventPersister({ sessions: store, activeSessionId: id, initialRevision: revision('1') });
    const runtimeEvent = (type: RuntimeEvent['type'], eventId: string, payload: unknown): RuntimeEvent => ({
      schemaVersion: 1, eventVersion: 1, id: eventId as RuntimeEvent['id'], type, phase: 'notification', sessionId: id,
      timestamp: 2, cwd: '/workspace', mode: 'headless', trust: { workspace: 'trusted', managedOnly: false }, payload,
    });

    await persist(runtimeEvent('message.delta', 'call-blocked', { type: 'tool-call', id: 'call-blocked', name: 'write', input: {} }));
    await persist(runtimeEvent('message.ended', 'message-blocked', { status: 'complete' }));
    await persist(runtimeEvent('tool.blocked', 'blocked', { callId: 'call-blocked', name: 'write', error: 'approval required', category: 'approval' }));
    await persist(runtimeEvent('tool.ended', 'blocked-ended', { callId: 'call-blocked', name: 'write', error: { message: 'approval required', category: 'approval' } }));
    await persist(runtimeEvent('message.delta', 'call-cancelled', { type: 'tool-call', id: 'call-cancelled', name: 'lookup', input: {} }));
    await persist(runtimeEvent('message.ended', 'message-cancelled', { status: 'complete' }));
    await persist(runtimeEvent('turn.ended', 'turn-ended', { stop: 'cancelled' }));
    await persist(runtimeEvent('message.delta', 'call-canonical-cancelled', { type: 'tool-call', id: 'call-canonical-cancelled', name: 'lookup', input: {} }));
    await persist(runtimeEvent('message.ended', 'message-canonical-cancelled', { status: 'complete' }));
    await persist(runtimeEvent('tool.ended', 'canonical-cancelled', {
      callId: 'call-canonical-cancelled', name: 'lookup', outcome: 'cancelled', category: 'cancelled', message: 'stopped',
      error: { category: 'cancelled', message: 'stopped' },
    }));

    const context = (await store.load(id)).projection.modelContext;
    expect(context.filter((message) => message.role === 'tool')).toEqual([
      expect.objectContaining({ toolCallId: 'call-blocked', content: '{"error":"approval required","category":"approval"}' }),
      expect.objectContaining({ toolCallId: 'call-cancelled', content: '{"error":"Tool call cancelled","category":"cancelled"}' }),
      expect.objectContaining({ toolCallId: 'call-canonical-cancelled', content: '{"error":{"category":"cancelled","message":"stopped"}}' }),
    ]);
  });

  it('maps runtime, input, turn, tool, and usage events into terminal presentation events', async () => {
    const input = new PassThrough();
    input.end('hello\n/exit\n');
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const id = sessionId('native:presentation');
    const emit = (type: RuntimeEvent['type'], payload: unknown) => {
      const runtimeEvent: RuntimeEvent = {
        schemaVersion: 1, eventVersion: 1, id: `event:${type}` as RuntimeEvent['id'], type, phase: 'notification', sessionId: id,
        timestamp: 1, cwd: '/workspace', mode: 'interactive', trust: { workspace: 'trusted', managedOnly: false }, payload,
      };
      for (const listener of listeners) listener(runtimeEvent);
    };
    const runtime = fakeRuntime();
    runtime.snapshot = () => ({
      state: 'ready',
      sessionId: id,
      model: { providerId: 'openai', modelId: 'gpt-runtime' },
    }) as RuntimeSnapshot;
    runtime.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
    runtime.start = vi.fn(async () => { emit('runtime.ready', {}); });
    runtime.submit = vi.fn(async (text: string) => {
      emit('input.queued', { kind: 'follow-up', text: 'next', position: 2 });
      emit('input.rejected', { kind: 'follow-up', text: 'later', reason: 'input queue full', limit: 1 });
      emit('input.received', { text });
      emit('turn.started', { turnId: 'turn-1' });
      emit('tool.requested', { callId: 'call-1', name: 'lookup' });
      emit('tool.started', { callId: 'call-1', name: 'lookup' });
      emit('tool.updated', { callId: 'call-1', name: 'lookup', update: { version: 1, kind: 'status', message: 'Searching' } });
      emit('tool.blocked', { callId: 'call-1', name: 'lookup', error: 'denied' });
      emit('tool.ended', { callId: 'call-2', name: 'read', result: { ok: true } });
      emit('tool.ended', { callId: 'call-3', name: 'fetch', outcome: 'cancelled', category: 'cancelled', message: 'stopped', error: { category: 'cancelled', message: 'stopped' } });
      emit('context.usage-changed', { inputTokens: 3, outputTokens: 2 });
      emit('turn.ended', { turnId: 'turn-1', stop: 'complete' });
    });
    runtime.stop = vi.fn(async () => { emit('runtime.stopping', {}); });
    const terminal = { start: vi.fn(async () => undefined), accept: vi.fn(), stop: vi.fn(async () => undefined), snapshot: vi.fn() };

    await expect(launchNativeAgent([], { createRuntime: async () => runtime, createTerminal: () => terminal, stdin: input })).resolves.toBe(0);

    const presentation = terminal.accept.mock.calls.map(([event]) => event);
    expect(presentation.filter((event) => event.type !== 'runtime-widgets-changed')).toEqual([
      { type: 'interaction-handler-state', ready: false },
      { type: 'runtime-ready' },
      { type: 'notification', severity: 'info', message: 'Follow-up queued · position 2' },
      { type: 'notification', severity: 'error', message: 'Follow-up rejected · input queue full' },
      { type: 'input-received', text: 'hello' },
      { type: 'turn-started', turnId: 'turn-1' },
      { type: 'tool-requested', callId: 'call-1', name: 'lookup', turnId: 'turn-1' },
      { type: 'tool-started', callId: 'call-1', name: 'lookup', turnId: 'turn-1' },
      { type: 'tool-updated', callId: 'call-1', name: 'lookup', message: 'Searching' },
      { type: 'tool-blocked', callId: 'call-1', name: 'lookup', message: 'denied' },
      { type: 'tool-ended', callId: 'call-2', name: 'read', result: '{"ok":true}' },
      { type: 'tool-cancelled', callId: 'call-3', name: 'fetch', message: 'stopped' },
      { type: 'status-changed', name: 'context.usage', text: '3 input · 2 output tokens' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed' },
      { type: 'runtime-stopping' },
    ]);
    expect(presentation.filter((event) => event.type === 'runtime-widgets-changed')).toEqual(expect.arrayContaining([
      expect.objectContaining({ snapshots: expect.objectContaining({
        header: expect.objectContaining({ authority: 'runtime', working: 'idle' }),
        footer: expect.objectContaining({ authority: 'runtime', connection: 'connecting' }),
      }) }),
      expect.objectContaining({ snapshots: expect.objectContaining({
        header: expect.objectContaining({
          working: 'idle', trust: 'trusted', sessionId: id,
          modelId: 'gpt-runtime',
        }),
        footer: expect.objectContaining({ connection: 'connected' }),
      }) }),
      expect.objectContaining({ snapshots: expect.objectContaining({
        header: expect.objectContaining({ working: 'active' }),
        footer: expect.objectContaining({ connection: 'connected' }),
      }) }),
      expect.objectContaining({ snapshots: expect.objectContaining({
        header: expect.objectContaining({ working: 'cancelling' }),
        footer: expect.objectContaining({ connection: 'connecting' }),
      }) }),
    ]));
  });

  it('hydrates a resumed production runtime from durable model-visible history', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-runtime-resume-'));
    const env = { OCTOCODE_HOME: home, TMUX_PANE: '%7' };
    const cwd = '/workspace';
    const id = sessionId('native:resume');
    const store = new TransactionalSessionStore(new FileSessionRecordPort(nativeSessionsDir(env)));
    const events = [
      { visibility: 'internal' as const, event: { type: 'session.created' as const } },
      { visibility: 'internal' as const, event: { type: 'custom.appended' as const, kind: 'session.cwd', value: cwd } },
      { visibility: 'model' as const, event: { type: 'message.appended' as const, role: 'user' as const, content: 'prior question' } },
      { visibility: 'model' as const, event: { type: 'message.appended' as const, role: 'assistant' as const, content: 'prior answer' } },
    ].map((entry, index) => ({
      schemaVersion: 1 as const, sessionId: id, eventId: sessionEventId(`resume-${index + 1}`), revision: revision(String(index + 1)), sequence: index + 1,
      timestamp: index + 1, ...entry,
    }));
    await store.append(id, revision('0'), events);
    const requests: ModelRequest[] = [];
    const model: ModelPort = {
      run: async (request, context) => {
        requests.push(structuredClone(request));
        await context.emit?.({ type: 'text', text: 'current answer' });
        return { stop: 'complete', usage: { inputTokens: 3, outputTokens: 2 } };
      },
    };
    const runtime = await createDefaultNativeRuntime({ env, cwd, args: parseNativeArgs(['--session', id]), model, tools: new ToolRegistry() });

    expect(readBreadcrumb(home, '%7')).toMatchObject({
      sessionFile: path.join(nativeSessionsDir(env), `${encodeURIComponent(id)}.json`),
      cwd,
    });
    const index = new DatabaseSync(path.join(home, 'octocode.sqlite3'), { readOnly: true });
    try {
      expect(index.prepare('SELECT workspace_path, cwd FROM agent_sessions WHERE session_id = ?').get(id)).toEqual({
        workspace_path: cwd,
        cwd,
      });
    } finally {
      index.close();
    }

    await runtime.submit('current question');
    await runtime.stop();

    expect(requests[0]?.messages).toEqual([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('<authority>') }),
      { role: 'user', content: 'prior question' },
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'current question' },
    ]);
  });

  it('persists automatic compaction and restores its summary on restart', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-runtime-auto-compact-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-runtime-auto-compact-workspace-'));
    const env = { OCTOCODE_HOME: home };
    let modelCalls = 0;
    const first = await createDefaultNativeRuntime({
      env,
      cwd,
      args: parseNativeArgs([]),
      tools: new ToolRegistry(),
      model: {
        run: async (request, context) => {
          modelCalls += 1;
          if (request.toolChoice === 'none') {
            await context.emit?.({ type: 'text', text: 'persisted automatic summary' });
            return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 3 } };
          }
          return { stop: 'complete', usage: { inputTokens: 64_000, outputTokens: 1 } };
        },
      },
    });
    const id = first.snapshot().sessionId;

    await first.submit('large turn');
    await first.stop();

    expect(modelCalls).toBe(2);
    const persisted = await createNativeSessionStore(false, nativeSessionsDir(env)).load(id);
    expect(persisted.projection.compaction).toMatchObject({
      summary: 'persisted automatic summary',
      projectionVersion: 1,
    });

    const resumedRequests: ModelRequest[] = [];
    const resumed = await createDefaultNativeRuntime({
      env,
      cwd,
      args: parseNativeArgs(['--session', id]),
      tools: new ToolRegistry(),
      model: {
        run: async (request) => {
          resumedRequests.push(structuredClone(request));
          return { stop: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    await resumed.submit('after compaction');
    await resumed.stop();

    expect(resumedRequests[0]?.messages).toEqual(expect.arrayContaining([
      { role: 'system', content: 'Conversation summary:\npersisted automatic summary' },
      { role: 'user', content: 'after compaction' },
    ]));
  });

  it('retains a correlation-closed tool exchange during compaction', () => {
    const messages = [
      { eventId: sessionEventId('assistant'), role: 'assistant' as const, content: '', toolCalls: [{ id: 'one', name: 'lookup', input: {} }, { id: 'two', name: 'lookup', input: {} }] },
      { eventId: sessionEventId('tool-one'), role: 'tool' as const, toolCallId: 'one', content: 'first' },
      { eventId: sessionEventId('tool-two'), role: 'tool' as const, toolCallId: 'two', content: 'second' },
      { eventId: sessionEventId('user-a'), role: 'user' as const, content: 'a' },
      { eventId: sessionEventId('assistant-a'), role: 'assistant' as const, content: 'a' },
      { eventId: sessionEventId('user-b'), role: 'user' as const, content: 'b' },
    ];

    expect(retainedCompactionEventIds(messages)).toEqual(messages.map(({ eventId }) => eventId));
  });

  it('freezes the trusted system prompt for the durable session generation', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-prompt-freeze-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-prompt-freeze-workspace-'));
    fs.mkdirSync(path.join(cwd, '.git'));
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'SESSION_PROMPT_A');
    const env = { OCTOCODE_HOME: home };
    const settings = new FileSettingsStorage(path.join(home, 'agent', 'settings.json'));
    settings.commit('0', { workspaceTrust: { [cwd]: 'trusted' } });
    const firstRequests: ModelRequest[] = [];
    const first = await createDefaultNativeRuntime({
      env, cwd, args: parseNativeArgs([]), tools: new ToolRegistry(),
      model: { run: async (request) => {
        firstRequests.push(structuredClone(request));
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    await first.submit('first');
    const id = first.snapshot().sessionId;
    await first.stop();

    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'SESSION_PROMPT_B');
    const resumedRequests: ModelRequest[] = [];
    const resumed = await createDefaultNativeRuntime({
      env, cwd, args: parseNativeArgs(['--session', id]), tools: new ToolRegistry(),
      model: { run: async (request) => {
        resumedRequests.push(structuredClone(request));
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    await resumed.submit('second');
    await resumed.stop();

    const firstSystem = firstRequests[0]?.messages[0];
    const resumedSystem = resumedRequests[0]?.messages[0];
    expect(firstSystem).toMatchObject({ role: 'system', content: expect.stringContaining('SESSION_PROMPT_A') });
    expect(resumedSystem).toEqual(firstSystem);
    expect((resumedSystem as { content: string }).content).not.toContain('SESSION_PROMPT_B');
  });

  it('drops repository instructions when a resumed workspace is no longer trusted', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-prompt-downgrade-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-prompt-downgrade-workspace-'));
    fs.mkdirSync(path.join(cwd, '.git'));
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'TRUSTED_SESSION_SECRET');
    const env = { OCTOCODE_HOME: home };
    const settings = new FileSettingsStorage(path.join(home, 'agent', 'settings.json'));
    settings.commit('0', { workspaceTrust: { [cwd]: 'trusted' } });
    const first = await createDefaultNativeRuntime({
      env, cwd, args: parseNativeArgs([]), tools: new ToolRegistry(),
      model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) },
    });
    const id = first.snapshot().sessionId;
    await first.stop();
    settings.commit(settings.read().revision, { workspaceTrust: { [cwd]: 'untrusted' } });

    const resumedRequests: ModelRequest[] = [];
    const resumed = await createDefaultNativeRuntime({
      env, cwd, args: parseNativeArgs(['--session', id]), tools: new ToolRegistry(),
      model: { run: async (request) => {
        resumedRequests.push(structuredClone(request));
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });
    await resumed.submit('after downgrade');
    await resumed.stop();

    const content = (resumedRequests[0]?.messages[0] as { content?: string } | undefined)?.content ?? '';
    expect(content).toContain('<authority>');
    expect(content).not.toContain('TRUSTED_SESSION_SECRET');
  });

  it('fails a native worker closed when its frozen prompt digest does not match', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-worker-prompt-mismatch-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-worker-prompt-workspace-'));
    const env = {
      OCTOCODE_HOME: home,
      OCTOCODE_NATIVE_WORKER: '1',
      OCTOCODE_EXPECTED_PROMPT_SHA256: '0'.repeat(64),
    };

    await expect(createDefaultNativeRuntime({
      env,
      cwd,
      args: parseNativeArgs(['--mode', 'rpc', '--no-session']),
      tools: new ToolRegistry(),
      model: { run: async () => ({ stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }) },
    })).rejects.toThrow(/worker prompt snapshot mismatch/i);
  });

  it('parses bounded worker capability envelopes and rejects malformed delegation', () => {
    const capabilities = resolveNativeWorkerCapabilities({
      OCTOCODE_WORKER_ALLOWED_TOOLS: JSON.stringify(['localSearchCode']),
      OCTOCODE_WORKER_ALLOWED_MODELS: JSON.stringify([{ providerId: 'openai', modelId: 'gpt-5' }]),
      OCTOCODE_WORKER_MAX_TURNS: '8',
    });
    expect([...capabilities.allowedTools!]).toEqual(['localSearchCode']);
    expect(capabilities.allowedModels).toEqual([{ providerId: 'openai', modelId: 'gpt-5' }]);
    expect(capabilities.maxTurns).toBe(8);
    expect(() => resolveNativeWorkerCapabilities({ OCTOCODE_WORKER_ALLOWED_TOOLS: '{' })).toThrow(/malformed/i);
    expect(() => resolveNativeWorkerCapabilities({ OCTOCODE_WORKER_MAX_TURNS: '0' })).toThrow(/turn capability/i);
  });

  it('repairs an interrupted durable tool call before the next provider request', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-runtime-orphan-'));
    const env = { OCTOCODE_HOME: home };
    const cwd = '/workspace';
    const id = sessionId('native:orphan');
    const store = new TransactionalSessionStore(new FileSessionRecordPort(nativeSessionsDir(env)));
    await store.append(id, revision('0'), [
      {
        schemaVersion: 1, sessionId: id, eventId: sessionEventId('orphan-created'), revision: revision('1'), sequence: 1,
        timestamp: 1, visibility: 'internal', event: { type: 'session.created' },
      },
      {
        schemaVersion: 1, sessionId: id, eventId: sessionEventId('orphan-call'), revision: revision('2'), sequence: 2,
        timestamp: 2, visibility: 'model', event: {
          type: 'message.appended', role: 'assistant', content: '',
          toolCalls: [{ id: 'interrupted-call', name: 'lookup', input: { q: 1 } }],
        },
      },
    ]);
    const requests: ModelRequest[] = [];
    const runtime = await createDefaultNativeRuntime({
      env, cwd, args: parseNativeArgs(['--session', id]), tools: new ToolRegistry(),
      model: { run: async (request) => { requests.push(structuredClone(request)); return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } }; } },
    });

    await runtime.submit('continue');

    expect(requests[0]?.messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'assistant', content: '', toolCalls: [{ id: 'interrupted-call', name: 'lookup', input: { q: 1 } }] },
      { role: 'tool', toolCallId: 'interrupted-call', content: JSON.stringify({ error: { category: 'cancelled', message: 'Tool call interrupted before completion' } }) },
      { role: 'user', content: 'continue' },
    ]);
    await runtime.stop();
  });

  it('does not persist assistant output before provider envelopes pass runtime validation', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-runtime-invalid-provider-'));
    const env = { OCTOCODE_HOME: home };
    const cwd = '/workspace';
    const id = sessionId('native:invalid-provider');
    await new TransactionalSessionStore(new FileSessionRecordPort(nativeSessionsDir(env))).append(id, revision('0'), [{
      schemaVersion: 1,
      sessionId: id,
      eventId: sessionEventId('invalid-provider-created'),
      revision: revision('1'),
      sequence: 1,
      timestamp: 1,
      visibility: 'internal',
      event: { type: 'session.created' },
    }]);
    const runtime = await createDefaultNativeRuntime({
      env,
      cwd,
      args: parseNativeArgs(['--session', id]),
      tools: new ToolRegistry(),
      model: { run: async (_request, context) => {
        await context.emit?.({ type: 'tool-call', id: 'invalid-call', name: 'lookup', input: {} });
        return { stop: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
      } },
    });

    await expect(runtime.submit('go')).rejects.toMatchObject({ category: 'adapter-translation' });
    await runtime.stop();

    const stored = await new TransactionalSessionStore(new FileSessionRecordPort(nativeSessionsDir(env))).load(id);
    expect(stored.projection.modelContext).toEqual([
      expect.objectContaining({ role: 'user', content: 'go' }),
    ]);
  });

  it('persists effect admission and terminal state across ledger reconstruction', async () => {
    const sessions = new InMemorySessionStore();
    const id = sessionId('native:durable-effects');
    const receipt = {
      schemaVersion: 1 as const,
      operation: 'tool:MCPTool',
      input: { server: 'workspace', tool: 'read' },
      effects: createEffectSet('network', 'process'),
      policy: {
        trust: { workspace: 'trusted' as const, managedOnly: false },
        approval: 'on-request' as const,
        approved: true as const,
        plan: { authority: 'runtime' as const, active: true, revision: 4 },
        lockTargets: [],
        receipts: [],
      },
    };
    const first = createNativeSessionEffectLedger(sessions, id, () => 10);
    expect(await first.begin('session:turn:call', receipt)).toBe('acquired');
    await first.settle('session:turn:call', 'committed');
    const reconstructed = createNativeSessionEffectLedger(sessions, id, () => 20);
    expect(await reconstructed.begin('session:turn:call', receipt)).toBe('committed');
    expect(await reconstructed.begin('session:turn:call', { ...receipt, input: { server: 'workspace', tool: 'write' } })).toBe('mismatch');
    await expect(reconstructed.settle('session:turn:call', 'committed')).resolves.toBeUndefined();
    await expect(reconstructed.settle('session:turn:call', 'failed')).rejects.toMatchObject({ category: 'conflict' });
    expect(await reconstructed.get('session:turn:call')).toMatchObject({ state: 'committed', updatedAt: 10, receipt });
  });
});
