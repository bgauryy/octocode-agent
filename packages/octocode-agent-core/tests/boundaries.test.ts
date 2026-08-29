import { describe, expect, it } from 'vitest';
import { ExecutionScope, HookCatalog, assemblePrompt, parseCodexHooks, parseRpcEvent, parseRpcRequest, parseRpcResponse, revision, type HookSourceDescriptor } from '../src/index.js';
describe('external boundaries', () => {
  it('validates Codex hooks and preserves unsupported definitions', () => { const parsed = parseCodexHooks({ hooks: { PreToolUse: [{ matcher: '^edit$', hooks: [{ type: 'command', command: './check', async: false }] }], FutureEvent: [{ value: 1 }] } }); expect(parsed.hooks.PreToolUse?.[0]?.handlers[0]).toMatchObject({ type: 'command', timeoutSeconds: 600 }); expect(parsed.unsupported).toHaveLength(1); expect(() => parseCodexHooks({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: './end', timeout: 4 }] }] } })).toThrow(/timeout/i); });
  it('rejects unknown RPC major versions', () => { expect(() => parseRpcRequest({ protocolVersion: 2, requestId: 'r', command: { type: 'runtime.snapshot' } })).toThrow(/version/i); });
  it('validates RPC commands as closed discriminated objects', () => {
    expect(parseRpcRequest({ protocolVersion: 1, requestId: 'r', command: { type: 'input.submit', text: 'hello' } })).toMatchObject({ requestId: 'r' });
    expect(() => parseRpcRequest({ protocolVersion: 1, requestId: 'r', command: { type: 'input.submit' } })).toThrow(/command/i);
    expect(() => parseRpcRequest({ protocolVersion: 1, requestId: 'r', command: { type: 'runtime.snapshot', extra: true } })).toThrow(/command/i);
    expect(() => parseRpcRequest({ protocolVersion: 1, requestId: 'r', command: { type: 'unknown' } })).toThrow(/command/i);
  });
  it('validates RPC response branches and runtime errors as closed objects', () => {
    const error = {
      category: 'validation', message: 'bad request', retry: 'unsafe', userVisible: true,
      redaction: 'public', terminalEffect: 'operation',
    };
    expect(parseRpcResponse({ protocolVersion: 1, requestId: 'ok', ok: true, data: { value: 1 } })).toMatchObject({ requestId: 'ok', ok: true });
    expect(parseRpcResponse({ protocolVersion: 1, requestId: 'failed', ok: false, error })).toMatchObject({ requestId: 'failed', ok: false });
    expect(() => parseRpcResponse({ protocolVersion: 1, requestId: 'missing', ok: false })).toThrow(/response/i);
    expect(() => parseRpcResponse({ protocolVersion: 1, requestId: 'contradictory', ok: true, error })).toThrow(/response/i);
    expect(() => parseRpcResponse({ protocolVersion: 1, requestId: 'extra', ok: true, extra: true })).toThrow(/response/i);
    expect(() => parseRpcResponse({ protocolVersion: 1, requestId: 'malformed', ok: false, error: { ...error, retry: 'eventually' } })).toThrow(/error/i);
  });
  it('validates RPC event envelopes and their runtime event payload boundary', () => {
    const event = {
      schemaVersion: 1, eventVersion: 1, id: 'event-1', type: 'message.delta', phase: 'notification',
      sessionId: 'session-1', timestamp: 1, cwd: '/workspace', mode: 'rpc',
      trust: { workspace: 'trusted', managedOnly: false }, payload: { type: 'text', text: 'hello' },
    };
    expect(parseRpcEvent({ protocolVersion: 1, sequence: 1, event })).toMatchObject({ sequence: 1, event: { type: 'message.delta' } });
    expect(() => parseRpcEvent({ protocolVersion: 1, sequence: 0, event })).toThrow(/event/i);
    expect(() => parseRpcEvent({ protocolVersion: 1, sequence: 1, event: { ...event, payload: undefined } })).toThrow(/payload/i);
    expect(() => parseRpcEvent({ protocolVersion: 1, sequence: 1, event: { ...event, type: 'invented.event' } })).toThrow(/event/i);
    expect(() => parseRpcEvent({ protocolVersion: 1, sequence: 1, event: { ...event, trust: { workspace: 'trusted', managedOnly: false, extra: true } } })).toThrow(/event/i);
    expect(() => parseRpcEvent({ protocolVersion: 1, sequence: 1, event, extra: true })).toThrow(/event/i);
  });
});
describe('hook discovery and trust', () => {
  it('merges eligible sources deterministically and invalidates changed hashes', () => { const catalog = new HookCatalog(); const source = (id: string, scope: HookSourceDescriptor['scope'], hash: string, order: number): HookSourceDescriptor => ({ id, scope, provenance: id, managed: false, rawHash: hash, normalizedHash: hash, trust: 'trusted', revision: revision(hash), discoveryOrder: order }); const config = parseCodexHooks({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: './check' }] }] } }); catalog.register(source('workspace', 'workspace', 'h1', 1), config); catalog.review('workspace', 'h1'); expect(catalog.effective(false, false)).toHaveLength(0); expect(catalog.effective(true, false)).toHaveLength(1); catalog.register(source('workspace', 'workspace', 'h2', 1), config); expect(catalog.effective(true, false)).toHaveLength(0); expect(() => catalog.review('workspace', 'h1')).toThrow(/hash/i); });
});
describe('pure runtime primitives', () => {
  it('cascades cancellation to child scopes', () => { const parent = new ExecutionScope('turn'); const child = parent.child('tool'); parent.cancel('stop'); expect(child.signal.aborted).toBe(true); expect(child.signal.reason).toBe('stop'); });
  it('assembles role-preserving prompts deterministically with semantic receipt', () => {
    const fragments = [
      { id: 'b', placement: 'after-user', priority: 0, content: 'B', provenance: 'test', trusted: true },
      { id: 'a', placement: 'system', priority: 0, content: 'A', provenance: 'test', trusted: true },
    ] as const;
    const snapshot = assemblePrompt(fragments, { maxBytes: 10 });
    expect(snapshot.text).toBe('A\n\nB');
    expect(snapshot.sections).toEqual([
      { placement: 'system', content: 'A', fragmentIds: ['a'], bytes: 1 },
      { placement: 'after-user', content: 'B', fragmentIds: ['b'], bytes: 1 },
    ]);
    expect(snapshot.semanticDigest).toMatch(/^[0-9a-f]{8}$/);
    expect(() => assemblePrompt([...fragments, fragments[0]])).toThrow(/duplicate prompt fragment id b/);
    expect(() => assemblePrompt(fragments, { maxBytes: 3 })).toThrow(/prompt exceeds byte budget 3/);
  });
});
