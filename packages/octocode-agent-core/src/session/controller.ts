import { branchId, revision, sessionEventId, type SessionId } from '../contracts/identity.js';
import type { SessionControllerPort, SessionEvent, SessionLoadResult, SessionProjection, SessionStore } from '../contracts/sessions.js';
export class SessionController implements SessionControllerPort {
  #current: SessionId | null = null;
  constructor(readonly store: SessionStore, readonly now: () => number = Date.now) {}
  current(): SessionId | null { return this.#current; }
  async create(id: SessionId, name?: string): Promise<SessionProjection> { await this.store.append(id, revision('0'), [this.#event(id, 1, { type: 'session.created', ...(name === undefined ? {} : { name }) })]); this.#current = id; return (await this.store.load(id)).projection; }
  async resume(id: SessionId): Promise<SessionProjection> { const result = await this.store.load(id); this.#current = id; return result.projection; }
  async switch(id: SessionId): Promise<SessionProjection> { return this.resume(id); }
  async fork(source: SessionId, destination: SessionId): Promise<SessionProjection> { const loaded = await this.store.load(source); const copied = loaded.events.map((event, index): SessionEvent => ({ ...event, sessionId: destination, eventId: sessionEventId(`fork:${destination}:${index + 1}`), revision: revision(String(index + 1)), sequence: index + 1 })); if (copied.length > 0) await this.store.append(destination, revision('0'), copied); else await this.store.append(destination, revision('0'), [this.#event(destination, 1, { type: 'session.created' }), this.#event(destination, 2, { type: 'branch.created', branchId: branchId('main') })]); this.#current = destination; return (await this.store.load(destination)).projection; }
  async name(name: string): Promise<SessionProjection> { const id = this.#requireCurrent(); const loaded = await this.store.load(id); await this.store.append(id, loaded.projection.revision, [this.#event(id, loaded.events.length + 1, { type: 'session.renamed', name })]); return (await this.store.load(id)).projection; }
  async export(): Promise<SessionLoadResult> { return this.store.load(this.#requireCurrent()); }
  #requireCurrent(): SessionId { if (this.#current === null) throw new Error('No active session'); return this.#current; }
  #event(id: SessionId, sequence: number, event: SessionEvent['event']): SessionEvent { return { schemaVersion: 1, sessionId: id, eventId: sessionEventId(`${id}:${sequence}`), revision: revision(String(sequence)), sequence, timestamp: this.now(), visibility: 'internal', event }; }
}
