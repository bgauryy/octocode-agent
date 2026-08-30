import { RuntimeFailure } from '../contracts/errors.js';
import { revision, type Revision, type SessionId } from '../contracts/identity.js';
import type { SessionEvent, SessionLoadResult, SessionRecord, SessionRecordPort, SessionStore } from '../contracts/sessions.js';
import { extendSessionProjection, parseSessionRecord, projectSession } from './store.js';

export class TransactionalSessionStore implements SessionStore {
  readonly #cache = new Map<SessionId, { readonly record: SessionRecord; readonly projection: SessionLoadResult['projection']; readonly eventIds: ReadonlySet<string> }>();
  constructor(readonly port: SessionRecordPort) {}
  async append(id: SessionId, expectedRevision: Revision, events: readonly SessionEvent[]): Promise<Revision> {
    const state = await this.#loadState(id);
    const currentRevision = state?.record.revision ?? revision('0');
    if (expectedRevision !== currentRevision) throw new RuntimeFailure('session-conflict', `Expected revision ${expectedRevision}, current ${currentRevision}`, 'safe');
    const nextRevision = revision(String(Number(currentRevision) + events.length));
    const baseProjection = state?.projection ?? projectSession(id, []);
    const eventIds = state?.eventIds ?? new Set<string>();
    const projection = extendSessionProjection(id, baseProjection, events, eventIds);
    if (projection.revision !== nextRevision) throw new RuntimeFailure('session-corruption', 'Appended session events do not match the next revision', 'unsafe', true, 'sensitive');
    const candidate = [...(state?.record.events ?? []), ...events];
    const record: SessionRecord = state?.record.schemaVersion === 2
      ? { schemaVersion: 2, sessionId: id, revision: nextRevision, retention: state.record.retention, events: candidate }
      : { schemaVersion: 1, sessionId: id, revision: nextRevision, events: candidate };
    let checkpointed = false;
    try {
      if (this.port.appendEvents) checkpointed = (await this.port.appendEvents(id, expectedRevision, nextRevision, events))?.checkpointed === true;
      else await this.port.commit(id, expectedRevision, nextRevision, JSON.stringify(record));
    }
    catch (error) { if (error instanceof RuntimeFailure) throw error; throw new RuntimeFailure('persistence', 'Atomic session commit failed', 'safe', true, 'sensitive', 'operation', error instanceof Error ? error.message : undefined); }
    if (checkpointed) {
      this.#cache.delete(id);
      await this.#loadState(id);
    } else {
      this.#cache.set(id, { record, projection, eventIds: new Set([...eventIds, ...events.map(({ eventId }) => String(eventId))]) });
    }
    return nextRevision;
  }
  async load(id: SessionId): Promise<SessionLoadResult> {
    const state = await this.#loadState(id);
    return state === null ? { events: [], projection: projectSession(id, []) } : { events: state.record.events, projection: state.projection };
  }
  async #loadState(id: SessionId): Promise<{ readonly record: SessionRecord; readonly projection: SessionLoadResult['projection']; readonly eventIds: ReadonlySet<string> } | null> {
    const cached = this.#cache.get(id);
    if (cached && this.port.readRevision && await this.port.readRevision(id) === cached.record.revision) return cached;
    const record = await this.#readRecord(id);
    if (record === null) { this.#cache.delete(id); return null; }
    const projection = projectSession(id, record.events, { allowGaps: record.schemaVersion === 2, revision: record.revision });
    const state = { record, projection, eventIds: new Set(record.events.map(({ eventId }) => String(eventId))) };
    this.#cache.set(id, state);
    return state;
  }
  async #readRecord(id: SessionId): Promise<SessionRecord | null> {
    const raw = await this.port.read(id); if (raw === null) return null;
    let value: unknown; try { value = JSON.parse(raw.content); } catch { throw new RuntimeFailure('session-corruption', 'Session record is not valid JSON', 'unsafe', true, 'sensitive'); }
    const record = parseSessionRecord(value, id);
    projectSession(id, record.events, { allowGaps: record.schemaVersion === 2, revision: record.revision }); return record;
  }
}
