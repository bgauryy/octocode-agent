import { RuntimeFailure } from '../contracts/errors.js';
import { revision, sessionEventId, type SessionId } from '../contracts/identity.js';
import type { LegacySessionSource, SessionEvent, SessionImportReceipt, SessionStore, SessionStoredEvent } from '../contracts/sessions.js';

export const importLegacySession = async (source: LegacySessionSource, destination: SessionStore, destinationId: SessionId, now: () => number = Date.now): Promise<SessionImportReceipt> => {
  const before = await source.digest(); const output: SessionEvent[] = []; let opaque = 0;
  for await (const record of source.readRecords()) { const translated = translateLegacyRecord(record); if (translated.type === 'opaque.imported') opaque += 1; output.push({ schemaVersion: 1, sessionId: destinationId, eventId: sessionEventId(`import:${output.length + 1}`), revision: revision(String(output.length + 1)), sequence: output.length + 1, timestamp: now(), visibility: translated.type === 'message.appended' ? 'transcript' : 'internal', event: translated }); }
  if (output[0]?.event.type !== 'session.created') output.unshift({ schemaVersion: 1, sessionId: destinationId, eventId: sessionEventId('import:0'), revision: revision('1'), sequence: 1, timestamp: now(), visibility: 'internal', event: { type: 'session.created' } });
  const normalized = output.map((event, index): SessionEvent => ({ ...event, eventId: sessionEventId(`import:${index + 1}`), revision: revision(String(index + 1)), sequence: index + 1 }));
  const current = await destination.load(destinationId); if (current.events.length !== 0) throw new RuntimeFailure('session-conflict', 'Legacy import destination must be empty', 'safe');
  const destinationRevision = normalized.length === 0 ? revision('0') : await destination.append(destinationId, revision('0'), normalized);
  const after = await source.digest(); if (before !== after) throw new RuntimeFailure('session-migration', 'Legacy source changed during read-only import', 'unsafe');
  return { sourceId: source.sourceId, sourceDigest: before, destinationId, imported: normalized.length, opaque, destinationRevision };
};
export const translateLegacyRecord = (value: unknown): SessionStoredEvent => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return opaque(value);
  const record = value as Record<string, unknown>;
  if ((record.type === 'session' || record.type === 'session.created') && (record.name === undefined || typeof record.name === 'string')) return { type: 'session.created', ...(typeof record.name === 'string' ? { name: record.name } : {}) };
  if ((record.type === 'message' || record.type === 'message.appended') && (record.role === 'system' || record.role === 'user' || record.role === 'assistant' || record.role === 'tool') && typeof record.content === 'string') return { type: 'message.appended', role: record.role, content: record.content };
  if ((record.type === 'branch' || record.type === 'branch.created') && typeof record.id === 'string') return { type: 'branch.created', branchId: record.id as never, ...(typeof record.parentId === 'string' ? { parentBranchId: record.parentId as never } : {}) };
  return opaque(value);
};
const opaque = (record: unknown): SessionStoredEvent => ({ type: 'opaque.imported', source: 'legacy', contentHash: digest(record), record });
const digest = (value: unknown): string => { const text = JSON.stringify(value) ?? 'undefined'; let hash = 0x811c9dc5; for (const byte of new TextEncoder().encode(text)) { hash ^= byte; hash = Math.imul(hash, 0x01000193); } return (hash >>> 0).toString(16).padStart(8, '0'); };
