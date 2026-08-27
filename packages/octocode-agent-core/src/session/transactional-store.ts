import { RuntimeFailure } from '../contracts/errors.js';
import { revision, type Revision, type SessionId } from '../contracts/identity.js';
import type { SessionEvent, SessionLoadResult, SessionRecord, SessionRecordPort, SessionStore } from '../contracts/sessions.js';
import { projectSession } from './store.js';

export class TransactionalSessionStore implements SessionStore {
  constructor(readonly port: SessionRecordPort) {}
  async append(id: SessionId, expectedRevision: Revision, events: readonly SessionEvent[]): Promise<Revision> {
    const loaded = await this.#readRecord(id); const current = loaded?.events ?? [];
    if (expectedRevision !== revision(String(current.length))) throw new RuntimeFailure('session-conflict', `Expected revision ${expectedRevision}, current ${current.length}`, 'safe');
    const candidate = [...current, ...events]; projectSession(id, candidate); const nextRevision = revision(String(candidate.length));
    const record: SessionRecord = { schemaVersion: 1, sessionId: id, revision: nextRevision, events: candidate };
    try { await this.port.commit(id, expectedRevision, nextRevision, JSON.stringify(record)); }
    catch (error) { if (error instanceof RuntimeFailure) throw error; throw new RuntimeFailure('persistence', 'Atomic session commit failed', 'safe', true, 'sensitive', 'operation', error instanceof Error ? error.message : undefined); }
    return nextRevision;
  }
  async load(id: SessionId): Promise<SessionLoadResult> { const record = await this.#readRecord(id); const events = record?.events ?? []; return { events, projection: projectSession(id, events) }; }
  async #readRecord(id: SessionId): Promise<SessionRecord | null> {
    const raw = await this.port.read(id); if (raw === null) return null;
    let value: unknown; try { value = JSON.parse(raw.content); } catch { throw new RuntimeFailure('session-corruption', 'Session record is not valid JSON', 'unsafe', true, 'sensitive'); }
    if (!isSessionRecord(value, id)) throw new RuntimeFailure('session-corruption', 'Session record envelope is invalid', 'unsafe', true, 'sensitive');
    projectSession(id, value.events); return value;
  }
}
const isSessionRecord = (value: unknown, id: SessionId): value is SessionRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const record = value as Partial<SessionRecord>;
  return record.schemaVersion === 1 && record.sessionId === id && typeof record.revision === 'string' && Array.isArray(record.events) && record.revision === revision(String(record.events.length)) && record.events.every(isEvent);
};
const isEvent = (value: unknown): value is SessionEvent => { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const event = value as Partial<SessionEvent>; return event.schemaVersion === 1 && typeof event.sessionId === 'string' && typeof event.eventId === 'string' && typeof event.revision === 'string' && Number.isInteger(event.sequence) && typeof event.timestamp === 'number' && typeof event.visibility === 'string' && typeof event.event === 'object' && event.event !== null && typeof (event.event as { type?: unknown }).type === 'string'; };
