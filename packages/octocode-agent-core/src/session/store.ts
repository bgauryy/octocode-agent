import { RuntimeFailure } from '../contracts/errors.js';
import { revision, type Revision, type SessionId } from '../contracts/identity.js';
import type { SessionEvent, SessionLoadResult, SessionProjection, SessionStore } from '../contracts/sessions.js';

export const projectSession = (id: SessionId, events: readonly SessionEvent[]): SessionProjection => {
  let name: string | undefined; const transcript: SessionProjection['transcript'][number][] = []; const customEntries: SessionProjection['customEntries'][number][] = []; const branches: SessionProjection['branches'][number][] = []; let selectedBranch: SessionProjection['selectedBranch']; let compaction: SessionProjection['compaction'] = null; const artifacts: SessionProjection['artifacts'][number][] = [];
  const seen = new Set<string>(); let expected = 1;
  for (const stored of events) {
    if (stored.sessionId !== id || seen.has(stored.eventId) || stored.sequence !== expected) throw new RuntimeFailure('session-corruption', `Invalid session event sequence at ${stored.eventId}`);
    seen.add(stored.eventId); expected += 1;
    const event = stored.event;
    switch (event.type) {
      case 'session.created': name = event.name; break; case 'session.renamed': name = event.name; break;
      case 'message.appended': transcript.push({ eventId: stored.eventId, role: event.role, content: event.content }); break;
      case 'custom.appended': customEntries.push({ eventId: stored.eventId, kind: event.kind, value: event.value }); break;
      case 'branch.created': branches.push({ id: event.branchId, ...(event.parentBranchId === undefined ? {} : { parentId: event.parentBranchId }) }); break;
      case 'branch.selected': selectedBranch = event.branchId; break;
      case 'compaction.recorded': compaction = { summary: event.summary, retainedEventIds: event.retainedEventIds }; break;
      case 'artifact.linked': artifacts.push({ id: event.artifactId, uri: event.uri }); break;
      case 'opaque.imported': break;
    }
  }
  return { sessionId: id, revision: revision(String(events.length)), ...(name === undefined ? {} : { name }), transcript, customEntries, branches, ...(selectedBranch === undefined ? {} : { selectedBranch }), compaction, artifacts };
};

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<SessionId, SessionEvent[]>();
  async append(id: SessionId, expectedRevision: Revision, events: readonly SessionEvent[]): Promise<Revision> {
    const current = this.#sessions.get(id) ?? [];
    if (expectedRevision !== revision(String(current.length))) throw new RuntimeFailure('session-conflict', `Expected revision ${expectedRevision}, current ${current.length}`, 'safe');
    const candidate = [...current, ...events]; projectSession(id, candidate);
    this.#sessions.set(id, candidate); return revision(String(candidate.length));
  }
  async load(id: SessionId): Promise<SessionLoadResult> { const events = [...(this.#sessions.get(id) ?? [])]; return { events, projection: projectSession(id, events) }; }
}
