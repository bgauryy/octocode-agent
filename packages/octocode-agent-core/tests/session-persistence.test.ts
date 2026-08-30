import { describe, expect, it } from 'vitest';
import { DurableCompactionService, InMemorySessionStore, RuntimeFailure, SessionController, TransactionalSessionStore, branchId, importLegacySession, parseSessionRecord, revision, sessionEventId, sessionId, type SessionEvent, type SessionRecordPort } from '../src/index.js';
class RecordPort implements SessionRecordPort {
  content: string | null = null; backup: string | null = null; failCommit = false;
  async read(): Promise<{ content: string; recovered: boolean } | null> { if (this.content === null && this.backup === null) return null; const content = this.content ?? this.backup!; return { content, recovered: this.content === null }; }
  async commit(_id: unknown, expected: string, _next: string, content: string): Promise<void> { const current = this.content === null ? '0' : String((JSON.parse(this.content) as { events: unknown[] }).events.length); if (expected !== current) throw new RuntimeFailure('session-conflict', 'durable conflict', 'safe'); if (this.failCommit) throw new Error('interrupted before rename'); this.backup = this.content; this.content = content; }
}

class AppendRecordPort implements SessionRecordPort {
  readonly events: SessionEvent[] = [];
  reads = 0;
  commits = 0;
  appends = 0;
  async read(): Promise<{ content: string; recovered: boolean } | null> {
    this.reads += 1;
    if (this.events.length === 0) return null;
    return { content: JSON.stringify({ schemaVersion: 1, sessionId: 's', revision: String(this.events.length), events: this.events }), recovered: false };
  }
  async readRevision(): Promise<ReturnType<typeof revision> | null> { return this.events.length === 0 ? null : revision(String(this.events.length)); }
  async appendEvents(_id: unknown, expected: string, _next: string, events: readonly SessionEvent[]): Promise<void> {
    this.appends += 1;
    if (expected !== String(this.events.length)) throw new RuntimeFailure('session-conflict', 'durable conflict', 'safe');
    this.events.push(...events);
  }
  async commit(): Promise<void> { this.commits += 1; throw new Error('whole-record commit must not be used'); }
}
const make = (sequence: number, event: SessionEvent['event']): SessionEvent => ({ schemaVersion: 1, sessionId: sessionId('s'), eventId: sessionEventId(`e${sequence}`), revision: revision(String(sequence)), sequence, timestamp: sequence, visibility: 'internal', event });
describe('transactional persistence and migration', () => {
  it('uses incremental durable append without replaying or rewriting the whole record', async () => {
    const port = new AppendRecordPort();
    const store = new TransactionalSessionStore(port);
    await store.append(sessionId('s'), revision('0'), [make(1, { type: 'session.created' })]);
    await store.append(sessionId('s'), revision('1'), [make(2, { type: 'session.renamed', name: 'two' })]);
    await store.append(sessionId('s'), revision('2'), [make(3, { type: 'artifact.linked', artifactId: 'a', uri: 'file:///a' })]);

    expect(port.appends).toBe(3);
    expect(port.commits).toBe(0);
    expect(port.reads).toBeLessThanOrEqual(1);
    expect((await store.load(sessionId('s'))).projection.revision).toBe(revision('3'));
  });

  it('accepts only versioned checkpoints with declared diagnostic omissions', () => {
    const first = make(1, { type: 'session.created' });
    const third = make(3, { type: 'session.renamed', name: 'retained' });
    expect(parseSessionRecord({
      schemaVersion: 2,
      sessionId: 's',
      revision: '3',
      retention: { omittedDiagnostics: 1, maxDiagnostics: 256 },
      events: [first, third],
    }, sessionId('s'))).toMatchObject({ schemaVersion: 2, revision: '3' });
    expect(() => parseSessionRecord({
      schemaVersion: 2,
      sessionId: 's',
      revision: '3',
      retention: { omittedDiagnostics: 0, maxDiagnostics: 256 },
      events: [first, third],
    }, sessionId('s'))).toThrow(/session record/i);
  });
  it('rejects malformed durable event unions before projection or recovery', () => {
    const valid = make(1, { type: 'session.created', name: 'valid' });
    const record = (event: unknown) => ({ schemaVersion: 1, sessionId: 's', revision: '1', events: [event] });
    const invalid = [
      { ...valid, visibility: 'secret' },
      { ...valid, sessionId: 'other' },
      { ...valid, revision: '9' },
      { ...valid, event: { type: 'future.event' } },
      { ...valid, event: { type: 'message.appended', role: 'user' } },
      { ...valid, event: { type: 'message.appended', role: 'assistant', content: 'x', toolCalls: [{ id: 'call', input: {} }] } },
    ];

    expect(parseSessionRecord(record(valid), sessionId('s'))).toEqual(record(valid));
    for (const event of invalid) {
      expect(() => parseSessionRecord(record(event), sessionId('s'))).toThrow(/session record/i);
    }
  });
  it('preserves the last commit across an interrupted write and rejects corruption', async () => { const port = new RecordPort(); const store = new TransactionalSessionStore(port); await store.append(sessionId('s'), revision('0'), [make(1, { type: 'session.created' })]); const committed = port.content; port.failCommit = true; await expect(store.append(sessionId('s'), revision('1'), [make(2, { type: 'session.renamed', name: 'two' })])).rejects.toMatchObject({ category: 'persistence' }); expect(port.content).toBe(committed); port.content = '{bad'; await expect(store.load(sessionId('s'))).rejects.toMatchObject({ category: 'session-corruption' }); });
  it('projects branches and supported legacy messages while preserving unknown entries as opaque without mutating the source', async () => { const store = new TransactionalSessionStore(new RecordPort()); const records = [{ type: 'session', name: 'old' }, { type: 'message', role: 'user', content: 'legacy question' }, { type: 'branch', id: 'child', parentId: 'main' }, { type: 'future', payload: 1 }]; let digestCalls = 0; const receipt = await importLegacySession({ sourceId: 'pi-jsonl', digest: async () => { digestCalls += 1; return 'same'; }, readRecords: async function* () { yield* records; } }, store, sessionId('s'), () => 1); const loaded = await store.load(sessionId('s')); expect(receipt.opaque).toBe(1); expect(digestCalls).toBe(2); expect(loaded.projection.branches).toEqual([{ id: branchId('child'), parentId: branchId('main') }]); expect(loaded.projection.modelContext).toEqual([expect.objectContaining({ role: 'user', content: 'legacy question' })]); expect(loaded.events.some(({ event }) => event.type === 'opaque.imported')).toBe(true); });
  it('leaves the destination empty when the legacy source changes during import', async () => {
    const store = new TransactionalSessionStore(new RecordPort());
    let digestCalls = 0;
    await expect(importLegacySession({
      sourceId: 'changing-pi-jsonl',
      digest: async () => (++digestCalls === 1 ? 'before' : 'after'),
      readRecords: async function* () { yield { type: 'message', role: 'user', content: 'hello' }; },
    }, store, sessionId('s'), () => 1)).rejects.toMatchObject({ category: 'session-migration' });
    expect((await store.load(sessionId('s'))).events).toEqual([]);
  });
  it('persists compaction attempts, retry, result metadata, and restart recovery', async () => {
    const store = new InMemorySessionStore();
    await store.append(sessionId('s'), revision('0'), [
      make(1, { type: 'session.created' }),
      { ...make(2, { type: 'message.appended', role: 'user', content: 'keep me' }), visibility: 'model' },
    ]);
    let attempts = 0;
    const service = new DurableCompactionService({ store, summarizer: { summarize: async ({ messages }) => {
      attempts += 1;
      if (attempts === 1) throw new RuntimeFailure('compaction', 'transient', 'safe');
      return { summary: 'durable summary', retainedEventIds: [messages[0]!.eventId] };
    } } });
    await expect(service.compact(sessionId('s'), 'threshold')).resolves.toMatchObject({ summary: 'durable summary' });
    const loaded = await store.load(sessionId('s'));
    expect(loaded.projection.compactionAttempt?.state).toBe('compacted');
    expect(loaded.projection.compaction).toMatchObject({ sourceRevision: '2', projectionVersion: 1, sourceEventIds: ['e2'], retainedEventIds: ['e2'] });
    expect(loaded.events.map(({ event }) => event.type)).toEqual(expect.arrayContaining(['compaction.started', 'compaction.retrying', 'compaction.recorded']));

    const interruptedRevision = loaded.projection.revision;
    const next = Number(interruptedRevision) + 1;
    await store.append(sessionId('s'), interruptedRevision, [{ ...make(next, { type: 'compaction.started', attemptId: 'old', sourceRevision: interruptedRevision, reason: 'manual', attempt: 1 }), eventId: sessionEventId(`interrupted-${next}`) }]);
    const recovered = new DurableCompactionService({ store, summarizer: { summarize: async ({ messages }) => ({ summary: 'after restart', retainedEventIds: messages.map(({ eventId }) => eventId) }) } });
    await recovered.compact(sessionId('s'), 'manual');
    expect((await store.load(sessionId('s'))).events.some(({ event }) => event.type === 'compaction.failed' && event.reason.includes('restart'))).toBe(true);
  });
  it('forks a compacted session with a closed destination reference graph', async () => {
    const store = new InMemorySessionStore();
    const source = sessionId('source');
    const destination = sessionId('destination');
    const sourceEvent = (sequence: number, event: SessionEvent['event'], references: Partial<Pick<SessionEvent, 'parentEventId' | 'causationId'>> = {}): SessionEvent => ({
      schemaVersion: 1, sessionId: source, eventId: sessionEventId(`source-${sequence}`), revision: revision(String(sequence)), sequence,
      timestamp: sequence, visibility: event.type === 'message.appended' ? 'model' : 'internal', ...references, event,
    });
    await store.append(source, revision('0'), [
      sourceEvent(1, { type: 'session.created' }),
      sourceEvent(2, { type: 'message.appended', role: 'user', content: 'retain me' }, { parentEventId: sessionEventId('source-1'), causationId: 'source-1' }),
      sourceEvent(3, { type: 'branch.created', branchId: branchId('child'), atEventId: sessionEventId('source-2') }),
      sourceEvent(4, { type: 'compaction.started', attemptId: 'source:compact:3', sourceRevision: revision('3'), reason: 'manual', attempt: 1 }),
      sourceEvent(5, { type: 'compaction.recorded', attemptId: 'source:compact:3', sourceRevision: revision('3'), attempt: 1, summary: 'summary', retainedEventIds: [sessionEventId('source-2')], sourceEventIds: [sessionEventId('source-2')], projectionVersion: 1 }),
    ]);

    const controller = new SessionController(store, () => 10);
    await controller.fork(source, destination);
    const forked = await store.load(destination);
    const copied = forked.events.slice(0, 5);
    const ids = new Set(copied.map(({ eventId }) => eventId));
    expect(copied[1]).toMatchObject({ parentEventId: copied[0]!.eventId, causationId: copied[0]!.eventId });
    expect(copied[2]!.event).toMatchObject({ type: 'branch.created', atEventId: copied[1]!.eventId });
    expect(copied[3]!.event).toMatchObject({ type: 'compaction.started', attemptId: 'destination:compact:3', sourceRevision: '3' });
    expect(copied[4]!.event).toMatchObject({
      type: 'compaction.recorded', attemptId: 'destination:compact:3', sourceRevision: '3',
      retainedEventIds: [copied[1]!.eventId], sourceEventIds: [copied[1]!.eventId],
    });
    for (const event of copied) {
      if (event.parentEventId !== undefined) expect(ids.has(event.parentEventId)).toBe(true);
      if (event.causationId !== undefined && event.causationId.startsWith('fork:destination:')) expect(ids.has(sessionEventId(event.causationId))).toBe(true);
      if (event.event.type === 'branch.created' && event.event.atEventId !== undefined) expect(ids.has(event.event.atEventId)).toBe(true);
      if (event.event.type === 'compaction.recorded') {
        expect(event.event.retainedEventIds.every((id) => ids.has(id))).toBe(true);
        expect(event.event.sourceEventIds.every((id) => ids.has(id))).toBe(true);
      }
    }
  });
});
