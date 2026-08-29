import { RuntimeFailure } from '../contracts/errors.js';
import { branchId, revision, sessionEventId, type SessionEventId, type SessionId } from '../contracts/identity.js';
import type { SessionControllerPort, SessionEvent, SessionLoadResult, SessionProjection, SessionStore, SessionStoredEvent } from '../contracts/sessions.js';

function requiredForkReference(reference: SessionEventId, eventIds: ReadonlyMap<SessionEventId, SessionEventId>): SessionEventId {
  const remapped = eventIds.get(reference);
  if (remapped === undefined) throw new RuntimeFailure('session-corruption', `Cannot fork a session with dangling event reference ${reference}`, 'unsafe', true, 'sensitive');
  return remapped;
}

function remapForkPayload(event: SessionStoredEvent, destination: SessionId, eventIds: ReadonlyMap<SessionEventId, SessionEventId>, attemptIds: Map<string, string>): SessionStoredEvent {
  if (event.type === 'branch.created') return { ...event, ...(event.atEventId === undefined ? {} : { atEventId: requiredForkReference(event.atEventId, eventIds) }) };
  switch (event.type) {
    case 'compaction.started':
    case 'compaction.retrying':
    case 'compaction.failed':
    case 'compaction.cancelled':
    case 'compaction.recorded': {
      const attemptId = attemptIds.get(event.attemptId) ?? `${destination}:compact:${event.sourceRevision}`;
      attemptIds.set(event.attemptId, attemptId);
      if (event.type === 'compaction.recorded') return { ...event, attemptId, retainedEventIds: event.retainedEventIds.map((id) => requiredForkReference(id, eventIds)), sourceEventIds: event.sourceEventIds.map((id) => requiredForkReference(id, eventIds)) };
      return { ...event, attemptId };
    }
    default: return event;
  }
}
export class SessionController implements SessionControllerPort {
  #current: SessionId | null = null;
  constructor(readonly store: SessionStore, readonly now: () => number = Date.now) {}
  current(): SessionId | null { return this.#current; }
  async create(id: SessionId, name?: string): Promise<SessionProjection> { await this.store.append(id, revision('0'), [this.#event(id, 1, { type: 'session.created', ...(name === undefined ? {} : { name }) })]); this.#current = id; return (await this.store.load(id)).projection; }
  async resume(id: SessionId): Promise<SessionProjection> { const result = await this.store.load(id); this.#current = id; return result.projection; }
  async switch(id: SessionId): Promise<SessionProjection> { return this.resume(id); }
  async fork(source: SessionId, destination: SessionId): Promise<SessionProjection> {
    const loaded = await this.store.load(source);
    const eventIds = new Map(loaded.events.map((event, index) => [event.eventId, sessionEventId(`fork:${destination}:${index + 1}`)]));
    const attemptIds = new Map<string, string>();
    const copied = loaded.events.map((event, index): SessionEvent => ({
      ...event,
      sessionId: destination,
      eventId: eventIds.get(event.eventId)!,
      revision: revision(String(index + 1)),
      sequence: index + 1,
      ...(event.parentEventId === undefined ? {} : { parentEventId: requiredForkReference(event.parentEventId, eventIds) }),
      ...(event.causationId === undefined ? {} : { causationId: eventIds.get(sessionEventId(event.causationId)) ?? event.causationId }),
      event: remapForkPayload(event.event, destination, eventIds, attemptIds),
    }));
    const base = copied.length > 0 ? copied : [this.#event(destination, 1, { type: 'session.created' }), this.#event(destination, 2, { type: 'branch.created', branchId: branchId('main') })];
    const sequence = base.length + 1;
    const lineage = this.#event(destination, sequence, { type: 'custom.appended', kind: 'session.parent', value: source });
    await this.store.append(destination, revision('0'), [...base, lineage]);
    this.#current = destination;
    return (await this.store.load(destination)).projection;
  }
  async name(name: string): Promise<SessionProjection> { const id = this.#requireCurrent(); const loaded = await this.store.load(id); await this.store.append(id, loaded.projection.revision, [this.#event(id, loaded.events.length + 1, { type: 'session.renamed', name })]); return (await this.store.load(id)).projection; }
  async export(): Promise<SessionLoadResult> { return this.store.load(this.#requireCurrent()); }
  #requireCurrent(): SessionId { if (this.#current === null) throw new Error('No active session'); return this.#current; }
  #event(id: SessionId, sequence: number, event: SessionEvent['event']): SessionEvent { return { schemaVersion: 1, sessionId: id, eventId: sessionEventId(`${id}:${sequence}`), revision: revision(String(sequence)), sequence, timestamp: this.now(), visibility: 'internal', event }; }
}
