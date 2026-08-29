import { RuntimeFailure } from '../contracts/errors.js';
import { revision, type Revision, type SessionId } from '../contracts/identity.js';
import type { SessionEvent, SessionLoadResult, SessionProjection, SessionRecord, SessionStore, SessionStoredEvent } from '../contracts/sessions.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasShape = (
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

const isOptionalString = (value: UnknownRecord, key: string): boolean => (
  !Object.hasOwn(value, key) || typeof value[key] === 'string'
);

const isModelToolCall = (value: unknown): boolean => isRecord(value)
  && hasShape(value, ['id', 'name', 'input'])
  && typeof value['id'] === 'string'
  && typeof value['name'] === 'string';

const isStoredEvent = (value: unknown): value is SessionStoredEvent => {
  if (!isRecord(value) || typeof value['type'] !== 'string') return false;
  switch (value['type']) {
    case 'session.created':
      return hasShape(value, ['type'], ['name']) && isOptionalString(value, 'name');
    case 'session.renamed':
      return hasShape(value, ['type', 'name']) && typeof value['name'] === 'string';
    case 'message.appended': {
      if (typeof value['role'] !== 'string' || typeof value['content'] !== 'string') return false;
      if (value['role'] === 'system' || value['role'] === 'user') {
        return hasShape(value, ['type', 'role', 'content']);
      }
      if (value['role'] === 'assistant') {
        return hasShape(value, ['type', 'role', 'content'], ['toolCalls'])
          && (!Object.hasOwn(value, 'toolCalls') || (
            Array.isArray(value['toolCalls']) && value['toolCalls'].every(isModelToolCall)
          ));
      }
      if (value['role'] === 'tool') {
        return hasShape(value, ['type', 'role', 'content'], ['toolCallId'])
          && isOptionalString(value, 'toolCallId');
      }
      return false;
    }
    case 'custom.appended':
      return hasShape(value, ['type', 'kind', 'value']) && typeof value['kind'] === 'string';
    case 'branch.created':
      return hasShape(value, ['type', 'branchId'], ['parentBranchId', 'atEventId'])
        && typeof value['branchId'] === 'string'
        && isOptionalString(value, 'parentBranchId')
        && isOptionalString(value, 'atEventId');
    case 'branch.selected':
      return hasShape(value, ['type', 'branchId']) && typeof value['branchId'] === 'string';
    case 'compaction.started':
      return hasShape(value, ['type', 'attemptId', 'sourceRevision', 'reason', 'attempt'])
        && typeof value['attemptId'] === 'string' && typeof value['sourceRevision'] === 'string'
        && ['manual', 'threshold', 'overflow'].includes(String(value['reason']))
        && Number.isSafeInteger(value['attempt']) && Number(value['attempt']) > 0;
    case 'compaction.retrying':
    case 'compaction.failed':
    case 'compaction.cancelled':
      return hasShape(value, ['type', 'attemptId', 'sourceRevision', 'reason', 'attempt'])
        && typeof value['attemptId'] === 'string' && typeof value['sourceRevision'] === 'string'
        && typeof value['reason'] === 'string' && Number.isSafeInteger(value['attempt']) && Number(value['attempt']) > 0;
    case 'compaction.recorded':
      return hasShape(value, ['type', 'attemptId', 'sourceRevision', 'attempt', 'summary', 'retainedEventIds', 'sourceEventIds', 'projectionVersion'])
        && typeof value['attemptId'] === 'string' && typeof value['sourceRevision'] === 'string'
        && Number.isSafeInteger(value['attempt']) && Number(value['attempt']) > 0
        && typeof value['summary'] === 'string'
        && Array.isArray(value['retainedEventIds'])
        && value['retainedEventIds'].every((eventId) => typeof eventId === 'string')
        && Array.isArray(value['sourceEventIds']) && value['sourceEventIds'].every((eventId) => typeof eventId === 'string')
        && value['projectionVersion'] === 1;
    case 'artifact.linked':
      return hasShape(value, ['type', 'artifactId', 'uri'])
        && typeof value['artifactId'] === 'string'
        && typeof value['uri'] === 'string';
    case 'opaque.imported':
      return hasShape(value, ['type', 'source', 'contentHash', 'record'])
        && typeof value['source'] === 'string'
        && typeof value['contentHash'] === 'string';
    default:
      return false;
  }
};

export function parseSessionEvent(value: unknown, id: SessionId): SessionEvent {
  if (!isRecord(value) || !hasShape(
    value,
    ['schemaVersion', 'sessionId', 'eventId', 'revision', 'sequence', 'timestamp', 'visibility', 'event'],
    ['parentEventId', 'causationId'],
  )) throw new RuntimeFailure('session-corruption', 'Session record contains an invalid event', 'unsafe', true, 'sensitive');
  const sequence = value['sequence'];
  const valid = value['schemaVersion'] === 1
    && value['sessionId'] === id
    && typeof value['eventId'] === 'string'
    && value['eventId'].length > 0
    && typeof value['revision'] === 'string'
    && Number.isSafeInteger(sequence)
    && (sequence as number) > 0
    && value['revision'] === String(sequence)
    && typeof value['timestamp'] === 'number'
    && Number.isFinite(value['timestamp'])
    && typeof value['visibility'] === 'string'
    && ['model', 'transcript', 'diagnostics', 'internal'].includes(value['visibility'])
    && isOptionalString(value, 'parentEventId')
    && isOptionalString(value, 'causationId')
    && isStoredEvent(value['event']);
  if (!valid) throw new RuntimeFailure('session-corruption', 'Session record contains an invalid event', 'unsafe', true, 'sensitive');
  return value as unknown as SessionEvent;
}

export function parseSessionRecord(value: unknown, id: SessionId): SessionRecord {
  if (!isRecord(value) || !hasShape(value, ['schemaVersion', 'sessionId', 'revision', 'events'])) {
    throw new RuntimeFailure('session-corruption', 'Session record envelope is invalid', 'unsafe', true, 'sensitive');
  }
  if (
    value['schemaVersion'] !== 1
    || value['sessionId'] !== id
    || typeof value['revision'] !== 'string'
    || !Array.isArray(value['events'])
    || value['revision'] !== String(value['events'].length)
  ) throw new RuntimeFailure('session-corruption', 'Session record envelope is invalid', 'unsafe', true, 'sensitive');
  return {
    schemaVersion: 1,
    sessionId: id,
    revision: revision(value['revision']),
    events: value['events'].map((event) => parseSessionEvent(event, id)),
  };
}

export const projectSession = (id: SessionId, events: readonly SessionEvent[]): SessionProjection => {
  let name: string | undefined; const transcript: SessionProjection['transcript'][number][] = []; const modelContext: SessionProjection['modelContext'][number][] = []; const customEntries: SessionProjection['customEntries'][number][] = []; const branches: SessionProjection['branches'][number][] = []; let selectedBranch: SessionProjection['selectedBranch']; let compaction: SessionProjection['compaction'] = null; let compactionAttempt: SessionProjection['compactionAttempt'] = null; const artifacts: SessionProjection['artifacts'][number][] = [];
  const seen = new Set<string>(); let expected = 1;
  for (const candidate of events) {
    const stored = parseSessionEvent(candidate, id);
    if (stored.sessionId !== id || seen.has(stored.eventId) || stored.sequence !== expected) throw new RuntimeFailure('session-corruption', `Invalid session event sequence at ${stored.eventId}`);
    seen.add(stored.eventId); expected += 1;
    const event = stored.event;
    switch (event.type) {
      case 'session.created': name = event.name; break; case 'session.renamed': name = event.name; break;
      case 'message.appended': {
        if (stored.visibility === 'model' || stored.visibility === 'transcript') transcript.push({ eventId: stored.eventId, role: event.role, content: event.content });
        if (stored.visibility === 'model') {
          if (event.role === 'assistant') modelContext.push({ eventId: stored.eventId, role: 'assistant', content: event.content, ...(event.toolCalls === undefined ? {} : { toolCalls: event.toolCalls }) });
          else if (event.role === 'tool') {
            if (event.toolCallId !== undefined) modelContext.push({ eventId: stored.eventId, role: 'tool', content: event.content, toolCallId: event.toolCallId });
          } else modelContext.push({ eventId: stored.eventId, role: event.role, content: event.content });
        }
        break;
      }
      case 'custom.appended': customEntries.push({ eventId: stored.eventId, kind: event.kind, value: event.value }); break;
      case 'branch.created': branches.push({ id: event.branchId, ...(event.parentBranchId === undefined ? {} : { parentId: event.parentBranchId }) }); break;
      case 'branch.selected': selectedBranch = event.branchId; break;
      case 'compaction.started': compactionAttempt = { state: 'running', attemptId: event.attemptId, sourceRevision: event.sourceRevision, attempt: event.attempt }; break;
      case 'compaction.retrying': compactionAttempt = { state: 'retrying', attemptId: event.attemptId, sourceRevision: event.sourceRevision, attempt: event.attempt, reason: event.reason }; break;
      case 'compaction.failed': compactionAttempt = { state: 'failed', attemptId: event.attemptId, sourceRevision: event.sourceRevision, attempt: event.attempt, reason: event.reason }; break;
      case 'compaction.cancelled': compactionAttempt = { state: 'cancelled', attemptId: event.attemptId, sourceRevision: event.sourceRevision, attempt: event.attempt, reason: event.reason }; break;
      case 'compaction.recorded': compaction = { attemptId: event.attemptId, sourceRevision: event.sourceRevision, summary: event.summary, retainedEventIds: event.retainedEventIds, sourceEventIds: event.sourceEventIds, projectionVersion: event.projectionVersion }; compactionAttempt = { state: 'compacted', attemptId: event.attemptId, sourceRevision: event.sourceRevision, attempt: event.attempt }; break;
      case 'artifact.linked': artifacts.push({ id: event.artifactId, uri: event.uri }); break;
      case 'opaque.imported': break;
    }
  }
  return { sessionId: id, revision: revision(String(events.length)), ...(name === undefined ? {} : { name }), transcript, modelContext, customEntries, branches, ...(selectedBranch === undefined ? {} : { selectedBranch }), compaction, compactionAttempt, artifacts };
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
