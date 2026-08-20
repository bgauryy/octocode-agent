import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVE_SESSION,
  DEFAULT_SERVE_SESSION_NAME,
  type RawRpcInput,
  type RawRpcOutput,
  type ServeCommandEnvelope,
  type ServeOutputEnvelope,
  buildRawRpcArgv,
  classifyRpcOutput,
  createSessionNameCommand,
  makeServeError,
  parseServeArgs,
  runServeStdio,
  unwrapServeInputLine,
  wrapRpcOutput,
} from '../src/serve.js';

describe('octocode serve thin-client envelope', () => {
  it('defaults to the octocode stdio envelope, not raw Pi RPC', () => {
    const parsed = parseServeArgs([]);
    expect(parsed).toEqual({
      mode: 'stdio',
      session: DEFAULT_SERVE_SESSION,
      sessionName: DEFAULT_SERVE_SESSION_NAME,
      rpcArgs: [],
    });
    expect(buildRawRpcArgv(parsed)).toEqual(['--mode', 'rpc']);
  });

  it('keeps raw Pi RPC as an explicit compatibility mode', () => {
    const parsed = parseServeArgs(['--raw-rpc', '--no-session', '--', '--mode', 'text']);
    expect(parsed.mode).toBe('raw-rpc');
    expect(parsed.rpcArgs).toEqual(['--no-session', '--mode', 'text']);
    expect(buildRawRpcArgv(parsed)).toEqual(['--mode', 'rpc', '--no-session', '--mode', 'text']);
  });

  it('accepts Octocode session routing metadata separately from raw RPC command bodies', () => {
    const parsed = parseServeArgs(['--session', 'ide-main', '--name', 'Octocode IDE']);
    expect(parsed.session).toBe('ide-main');
    expect(parsed.sessionName).toBe('Octocode IDE');
    expect(parsed.rpcArgs).toEqual([]);
  });

  it('type-checks client envelopes against Pi RpcCommand and RpcExtensionUIResponse bodies', () => {
    const promptCommand = { type: 'prompt', message: 'fix the bug', streamingBehavior: 'steer' } satisfies RpcCommand;
    const uiResponse = { type: 'extension_ui_response', id: 'ui1', confirmed: true } satisfies RpcExtensionUIResponse;

    const promptEnvelope = { v: 1, session: 's1', id: 'c42', cmd: promptCommand } satisfies ServeCommandEnvelope;
    const uiEnvelope = { v: 1, session: 's1', cmd: uiResponse } satisfies ServeCommandEnvelope;

    expect(unwrapServeInputLine(JSON.stringify(promptEnvelope)).command).toEqual({
      type: 'prompt',
      message: 'fix the bug',
      streamingBehavior: 'steer',
      id: 'c42',
    } satisfies RawRpcInput);
    expect(unwrapServeInputLine(JSON.stringify(uiEnvelope)).command).toEqual(uiResponse);
  });

  it('unwraps client envelopes into verbatim Pi RpcCommand bodies', () => {
    const { session, command } = unwrapServeInputLine(
      JSON.stringify({ v: 1, session: 's1', id: 'c42', cmd: { type: 'get_state' } }),
    );
    expect(session).toBe('s1');
    expect(command).toEqual({ type: 'get_state', id: 'c42' });
  });

  it('preserves a command id when the command already supplies one', () => {
    const { command } = unwrapServeInputLine(
      JSON.stringify({ id: 'outer', cmd: { id: 'inner', type: 'prompt', message: 'hi' } }),
    );
    expect(command).toEqual({ id: 'inner', type: 'prompt', message: 'hi' });
  });

  it('type-checks output envelopes against Pi RpcResponse and RpcExtensionUIRequest bodies', () => {
    const response = { id: 'c42', type: 'response', command: 'prompt', success: true } satisfies RpcResponse;
    const uiRequest = { id: 'ui1', type: 'extension_ui_request', method: 'notify', message: 'hello' } satisfies RpcExtensionUIRequest;
    const event = { type: 'agent_start' } satisfies RawRpcOutput;

    expect(wrapRpcOutput(response, 's1')).toEqual({
      v: 1,
      session: 's1',
      id: 'c42',
      kind: 'response',
      body: response,
    } satisfies ServeOutputEnvelope);
    expect(wrapRpcOutput(uiRequest, 's1')).toEqual({
      v: 1,
      session: 's1',
      id: 'ui1',
      kind: 'ui',
      body: uiRequest,
    } satisfies ServeOutputEnvelope);
    expect(wrapRpcOutput(event, 's1')).toEqual({
      v: 1,
      session: 's1',
      kind: 'event',
      body: event,
    } satisfies ServeOutputEnvelope);
  });

  it('wraps raw Pi RPC responses, events, and extension UI requests', () => {
    expect(classifyRpcOutput({ type: 'response', command: 'get_state', success: true })).toBe('response');
    expect(classifyRpcOutput({ type: 'extension_ui_request', id: 'ui1', method: 'notify' })).toBe('ui');
    expect(classifyRpcOutput({ type: 'agent_start' })).toBe('event');

    expect(wrapRpcOutput({ id: 'c42', type: 'response', command: 'get_state', success: true }, 's1')).toEqual({
      v: 1,
      session: 's1',
      id: 'c42',
      kind: 'response',
      body: { id: 'c42', type: 'response', command: 'get_state', success: true },
    });
    expect(wrapRpcOutput({ type: 'agent_start' }, 's1')).toMatchObject({ v: 1, session: 's1', kind: 'event' });
    expect(wrapRpcOutput({ id: 'ui1', type: 'extension_ui_request', method: 'notify' }, 's1')).toMatchObject({
      v: 1,
      session: 's1',
      id: 'ui1',
      kind: 'ui',
    });
  });

  it('suppresses the internal Octocode session-name response', () => {
    const internal = createSessionNameCommand('Octocode IDE');
    expect(internal).toEqual({
      id: 'octocode-serve:set-session-name',
      type: 'set_session_name',
      name: 'Octocode IDE',
    });
    expect(wrapRpcOutput({ id: internal.id, type: 'response', command: 'set_session_name', success: true })).toBeNull();
  });

  it('returns envelope-shaped parse errors instead of raw throws on the wire', () => {
    expect(() => unwrapServeInputLine(JSON.stringify({ type: 'get_state' }))).toThrow(/cmd object/);
    expect(() => unwrapServeInputLine(JSON.stringify({ cmd: { id: 'missing-type' } }))).toThrow(/string type/);
    expect(makeServeError('bad input', 's1', 'c1')).toEqual({
      v: 1,
      session: 's1',
      id: 'c1',
      kind: 'error',
      body: { type: 'error', error: 'bad input' },
    });
  });

  it('proxies stdio envelopes to a raw RPC child and wraps child output', async () => {
    const parentIn = new PassThrough();
    const parentOut = new PassThrough();
    const parentErr = new PassThrough();
    const childIn = new PassThrough();
    const childOut = new PassThrough();
    const childErr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = childIn;
    child.stdout = childOut;
    child.stderr = childErr;

    const childInput: string[] = [];
    childIn.on('data', chunk => childInput.push(String(chunk)));
    const parentOutput: string[] = [];
    parentOut.on('data', chunk => parentOutput.push(String(chunk)));

    const run = runServeStdio({
      argv: ['--session', 'ide-main', '--name', 'Octocode IDE', '--no-session'],
      stdin: parentIn,
      stdout: parentOut,
      stderr: parentErr,
      entrypoint: '/fake/octocode-agent.mjs',
      spawnProcess: (_command, args) => {
        expect(args).toEqual(['/fake/octocode-agent.mjs', '--mode', 'rpc', '--no-session']);
        return child as never;
      },
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(childInput.at(0)).toBe(
      `${JSON.stringify({ id: 'octocode-serve:set-session-name', type: 'set_session_name', name: 'Octocode IDE' })}\n`,
    );

    parentIn.write(`${JSON.stringify({ session: 'ide-main', id: 'c1', cmd: { type: 'get_state' } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(childInput.at(-1)).toBe(`${JSON.stringify({ type: 'get_state', id: 'c1' })}\n`);

    childOut.write(`${JSON.stringify({ id: 'c1', type: 'response', command: 'get_state', success: true, data: { sessionId: 's' } })}\n`);
    childOut.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
    await new Promise(resolve => setImmediate(resolve));

    const envelopes = parentOutput.join('').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    expect(envelopes).toEqual([
      {
        v: 1,
        session: 'ide-main',
        id: 'c1',
        kind: 'response',
        body: { id: 'c1', type: 'response', command: 'get_state', success: true, data: { sessionId: 's' } },
      },
      { v: 1, session: 'ide-main', kind: 'event', body: { type: 'agent_start' } },
    ]);

    child.emit('close', 0);
    await expect(run).resolves.toBe(0);
  });
});
