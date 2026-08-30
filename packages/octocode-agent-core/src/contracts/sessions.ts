import type { BranchId, Revision, SessionEventId, SessionId } from './identity.js';
import type { ModelMessage, ModelToolCall } from './ports.js';
export type SessionStoredEvent =
  | { readonly type: 'session.created'; readonly name?: string }
  | { readonly type: 'session.renamed'; readonly name: string }
  | { readonly type: 'message.appended'; readonly role: 'system' | 'user'; readonly content: string }
  | { readonly type: 'message.appended'; readonly role: 'assistant'; readonly content: string; readonly toolCalls?: readonly ModelToolCall[] }
  | { readonly type: 'message.appended'; readonly role: 'tool'; readonly content: string; readonly toolCallId?: string }
  | { readonly type: 'custom.appended'; readonly kind: string; readonly value: unknown }
  | { readonly type: 'branch.created'; readonly branchId: BranchId; readonly parentBranchId?: BranchId; readonly atEventId?: SessionEventId }
  | { readonly type: 'branch.selected'; readonly branchId: BranchId }
  | { readonly type: 'compaction.started'; readonly attemptId: string; readonly sourceRevision: Revision; readonly reason: 'manual' | 'threshold' | 'overflow'; readonly attempt: number }
  | { readonly type: 'compaction.retrying'; readonly attemptId: string; readonly sourceRevision: Revision; readonly reason: string; readonly attempt: number }
  | { readonly type: 'compaction.failed' | 'compaction.cancelled'; readonly attemptId: string; readonly sourceRevision: Revision; readonly reason: string; readonly attempt: number }
  | { readonly type: 'compaction.recorded'; readonly attemptId: string; readonly sourceRevision: Revision; readonly attempt: number; readonly summary: string; readonly retainedEventIds: readonly SessionEventId[]; readonly sourceEventIds: readonly SessionEventId[]; readonly projectionVersion: 1 }
  | { readonly type: 'artifact.linked'; readonly artifactId: string; readonly uri: string }
  | { readonly type: 'opaque.imported'; readonly source: string; readonly contentHash: string; readonly record: unknown };
export interface SessionEvent { readonly schemaVersion: 1; readonly sessionId: SessionId; readonly eventId: SessionEventId; readonly revision: Revision; readonly sequence: number; readonly timestamp: number; readonly visibility: 'model' | 'transcript' | 'diagnostics' | 'internal'; readonly parentEventId?: SessionEventId; readonly causationId?: string; readonly event: SessionStoredEvent; }
export interface SessionProjection { readonly sessionId: SessionId; readonly revision: Revision; readonly name?: string; readonly transcript: readonly { readonly eventId: SessionEventId; readonly role: string; readonly content: string }[]; readonly modelContext: readonly (ModelMessage & { readonly eventId: SessionEventId })[]; readonly customEntries: readonly { readonly eventId: SessionEventId; readonly kind: string; readonly value: unknown }[]; readonly branches: readonly { readonly id: BranchId; readonly parentId?: BranchId }[]; readonly selectedBranch?: BranchId; readonly compaction: { readonly attemptId: string; readonly sourceRevision: Revision; readonly summary: string; readonly retainedEventIds: readonly SessionEventId[]; readonly sourceEventIds: readonly SessionEventId[]; readonly projectionVersion: 1 } | null; readonly compactionAttempt: { readonly state: 'running' | 'retrying' | 'failed' | 'cancelled' | 'compacted'; readonly attemptId: string; readonly sourceRevision: Revision; readonly attempt: number; readonly reason?: string } | null; readonly artifacts: readonly { readonly id: string; readonly uri: string }[]; }
export interface SessionLoadResult { readonly events: readonly SessionEvent[]; readonly projection: SessionProjection; }
export interface SessionStore { append(id: SessionId, expectedRevision: Revision, events: readonly SessionEvent[]): Promise<Revision>; load(id: SessionId): Promise<SessionLoadResult>; }
export type SessionRecord =
  | { readonly schemaVersion: 1; readonly sessionId: SessionId; readonly revision: Revision; readonly events: readonly SessionEvent[] }
  | { readonly schemaVersion: 2; readonly sessionId: SessionId; readonly revision: Revision; readonly retention: { readonly omittedDiagnostics: number; readonly maxDiagnostics: number }; readonly events: readonly SessionEvent[] };
export interface SessionRecordPort {
  /** Read the last committed record. Implementations may recover a valid backup before returning. */
  read(id: SessionId): Promise<{ readonly content: string; readonly recovered: boolean } | null>;
  /** Atomically commit or reject when the durable revision differs. Hosts implement temp-write, sync, and rename. */
  commit(id: SessionId, expectedRevision: Revision, nextRevision: Revision, content: string): Promise<void>;
  /** Optional incremental path. Implementations must atomically admit the exact expected revision or reject. */
  appendEvents?(id: SessionId, expectedRevision: Revision, nextRevision: Revision, events: readonly SessionEvent[]): Promise<void | { readonly checkpointed: boolean }>;
  /** Optional cheap durable revision check used to retain a validated in-process projection cache. */
  readRevision?(id: SessionId): Promise<Revision | null>;
}
export interface LegacySessionSource { readonly sourceId: string; digest(): Promise<string>; readRecords(): AsyncIterable<unknown>; }
export interface SessionImportReceipt { readonly sourceId: string; readonly sourceDigest: string; readonly destinationId: SessionId; readonly imported: number; readonly opaque: number; readonly destinationRevision: Revision; }
export interface SessionIdentityReader { current(): SessionId | null; }
export interface SessionControllerPort extends SessionIdentityReader { create(id: SessionId, name?: string): Promise<SessionProjection>; resume(id: SessionId): Promise<SessionProjection>; fork(source: SessionId, destination: SessionId): Promise<SessionProjection>; switch(id: SessionId): Promise<SessionProjection>; name(name: string): Promise<SessionProjection>; export(): Promise<SessionLoadResult>; }
