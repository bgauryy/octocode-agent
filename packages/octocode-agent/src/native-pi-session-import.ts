import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RuntimeFailure,
  revision,
  sessionEventId,
  type ModelToolCall,
  type SessionEvent,
  type SessionId,
  type SessionStore,
  type SessionStoredEvent,
} from '@octocodeai/agent-core';

const PI_SESSION_VERSION = 3 as const;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_RECORDS = 100_000;
const COMPACTION_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const COMPACTION_SUFFIX = '\n</summary>';
const BRANCH_PREFIX =
  'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n';
const BRANCH_SUFFIX = '</summary>';

type JsonRecord = Record<string, unknown>;

export interface PiSessionSnapshotSource {
  readonly sourceId: string;
  readSnapshot(): Promise<Uint8Array>;
}

/** Read-only filesystem adapter. Parsing and destination persistence remain separate. */
export class FilePiSessionSnapshotSource implements PiSessionSnapshotSource {
  readonly sourceId: string;
  readonly #file: string;

  constructor(file: string) {
    this.#file = path.resolve(file);
    this.sourceId = `pi-jsonl:${path.basename(this.#file)}`;
  }

  async readSnapshot(): Promise<Uint8Array> {
    const before = await fs.promises.lstat(this.#file);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw migrationFailure('Pi session source must be a regular, non-symlink file');
    }
    if (before.size > MAX_SOURCE_BYTES) {
      throw migrationFailure(`Pi session source exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    const bytes = await fs.promises.readFile(this.#file);
    const after = await fs.promises.lstat(this.#file);
    if (
      after.isSymbolicLink()
      || !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw migrationFailure('Pi session source changed while its snapshot was read');
    }
    return bytes;
  }
}

export interface PiSessionImportReceipt {
  readonly schemaVersion: 1;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly piSessionId: string;
  readonly piSessionVersion: typeof PI_SESSION_VERSION;
  readonly activeLeafId: string | null;
  readonly sourceRecords: number;
  readonly importedEvents: number;
  readonly destinationId: SessionId;
  readonly destinationRevision: string;
}

export interface PiSessionImportInput {
  readonly source: PiSessionSnapshotSource;
  /** Rust-backed production storage is injected through this host-neutral port. */
  readonly destination: SessionStore;
  readonly destinationId: SessionId;
  readonly now?: () => number;
}

interface ParsedPiSession {
  readonly header: JsonRecord & {
    readonly type: 'session';
    readonly version: typeof PI_SESSION_VERSION;
    readonly id: string;
    readonly cwd: string;
    readonly timestamp: string;
  };
  readonly entries: readonly PiEntry[];
  readonly activePath: readonly PiEntry[];
  readonly contextEntries: readonly PiEntry[];
  readonly name?: string;
}

interface PiEntry extends JsonRecord {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

/**
 * Imports one frozen Pi v3 snapshot into an empty native session. The source is
 * read twice and the destination receives one compare-and-append transaction.
 */
export async function importPiSession(input: PiSessionImportInput): Promise<PiSessionImportReceipt> {
  const first = boundedSnapshot(await input.source.readSnapshot());
  const sourceDigest = digest(first);
  const parsed = parsePiSession(first);
  const second = boundedSnapshot(await input.source.readSnapshot());
  if (digest(second) !== sourceDigest) {
    throw migrationFailure('Pi session source changed during read-only import');
  }

  const loaded = await input.destination.load(input.destinationId);
  if (loaded.events.length !== 0) {
    throw new RuntimeFailure(
      'session-conflict',
      'Pi session import destination must be empty',
      'safe',
    );
  }

  const events = buildImportEvents(parsed, input.destinationId, sourceDigest, input.source.sourceId, input.now);
  const destinationRevision = events.length === 0
    ? revision('0')
    : await input.destination.append(input.destinationId, revision('0'), events);
  return Object.freeze({
    schemaVersion: 1,
    sourceId: input.source.sourceId,
    sourceDigest,
    piSessionId: parsed.header.id,
    piSessionVersion: PI_SESSION_VERSION,
    activeLeafId: parsed.activePath.at(-1)?.id ?? null,
    sourceRecords: parsed.entries.length + 1,
    importedEvents: events.length,
    destinationId: input.destinationId,
    destinationRevision: String(destinationRevision),
  });
}

function boundedSnapshot(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw migrationFailure('Pi session source did not return bytes');
  if (value.byteLength === 0) throw migrationFailure('Pi session source is empty');
  if (value.byteLength > MAX_SOURCE_BYTES) {
    throw migrationFailure(`Pi session source exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  return value;
}

function parsePiSession(bytes: Uint8Array): ParsedPiSession {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw migrationFailure('Pi session source is not valid UTF-8');
  }
  const records: JsonRecord[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    if (records.length >= MAX_SOURCE_RECORDS) {
      throw migrationFailure(`Pi session source exceeds ${MAX_SOURCE_RECORDS} records`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw migrationFailure(`Pi session source has malformed JSON at line ${index + 1}`);
    }
    if (!isRecord(value)) {
      throw migrationFailure(`Pi session source record ${index + 1} must be an object`);
    }
    records.push(value);
  }
  const header = records[0];
  if (
    header === undefined
    || header['type'] !== 'session'
    || header['version'] !== PI_SESSION_VERSION
    || !boundedString(header['id'], 200)
    || typeof header['cwd'] !== 'string'
    || !validTimestamp(header['timestamp'])
  ) {
    throw migrationFailure(`Pi session source must begin with a supported v${PI_SESSION_VERSION} header`);
  }
  if (records.slice(1).some((record) => record['type'] === 'session')) {
    throw migrationFailure('Pi session source contains more than one session header');
  }

  const entries = records.slice(1).map((record, index) => parseEntry(record, index + 2));
  const byId = new Map<string, PiEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw migrationFailure(`Pi session source has duplicate entry id ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw migrationFailure(`Pi session entry ${entry.id} references a missing parent`);
    }
  }
  const activePath = activePiPath(entries, byId);
  const contextEntries = compactedPiContext(activePath);
  const names = entries.filter((entry) => entry.type === 'session_info');
  const latestName = names.at(-1)?.['name'];
  if (latestName !== undefined && !boundedString(latestName, 500)) {
    throw migrationFailure('Pi session name is malformed');
  }
  return {
    header: header as ParsedPiSession['header'],
    entries,
    activePath,
    contextEntries,
    ...(typeof latestName === 'string' ? { name: latestName } : {}),
  };
}

function parseEntry(record: JsonRecord, line: number): PiEntry {
  if (
    !boundedString(record['type'], 100)
    || !boundedString(record['id'], 200)
    || !(record['parentId'] === null || boundedString(record['parentId'], 200))
    || !validTimestamp(record['timestamp'])
  ) {
    throw migrationFailure(`Pi session source has a malformed entry at line ${line}`);
  }
  if (!KNOWN_PI_ENTRY_TYPES.has(record['type'])) {
    throw migrationFailure(`Pi session entry type is unsupported: ${record['type']}`);
  }
  return record as PiEntry;
}

const KNOWN_PI_ENTRY_TYPES = new Set([
  'message',
  'thinking_level_change',
  'model_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
]);

function activePiPath(entries: readonly PiEntry[], byId: ReadonlyMap<string, PiEntry>): readonly PiEntry[] {
  const leaf = entries.at(-1);
  if (leaf === undefined) return [];
  const reversed: PiEntry[] = [];
  const seen = new Set<string>();
  let current: PiEntry | undefined = leaf;
  while (current !== undefined) {
    if (seen.has(current.id)) throw migrationFailure('Pi session source contains a parent cycle');
    seen.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return reversed.reverse();
}

function compactedPiContext(pathEntries: readonly PiEntry[]): readonly PiEntry[] {
  const compaction = [...pathEntries].reverse().find((entry) => entry.type === 'compaction');
  if (compaction === undefined) return pathEntries;
  if (!boundedString(compaction['summary'], 4_000_000)) {
    throw migrationFailure('Pi compaction summary is malformed');
  }
  if (!boundedString(compaction['firstKeptEntryId'], 200)) {
    throw migrationFailure('Pi compaction first-kept entry is malformed');
  }
  const index = pathEntries.findIndex((entry) => entry.id === compaction.id);
  const before = pathEntries.slice(0, index);
  const keptIndex = before.findIndex((entry) => entry.id === compaction['firstKeptEntryId']);
  return [
    compaction,
    ...(keptIndex < 0 ? [] : before.slice(keptIndex)),
    ...pathEntries.slice(index + 1),
  ];
}

function buildImportEvents(
  parsed: ParsedPiSession,
  destinationId: SessionId,
  sourceDigest: string,
  sourceId: string,
  now: (() => number) | undefined,
): readonly SessionEvent[] {
  const stored: Array<{ readonly event: SessionStoredEvent; readonly timestamp: number; readonly visibility: SessionEvent['visibility'] }> = [
    {
      event: { type: 'session.created', ...(parsed.name === undefined ? {} : { name: parsed.name }) },
      timestamp: timestamp(parsed.header.timestamp),
      visibility: 'internal',
    },
    {
      event: { type: 'custom.appended', kind: 'session.cwd', value: parsed.header.cwd },
      timestamp: timestamp(parsed.header.timestamp),
      visibility: 'internal',
    },
    {
      event: {
        type: 'custom.appended',
        kind: 'native.import.pi',
        value: {
          schemaVersion: 1,
          sourceId,
          sourceDigest,
          piSessionId: parsed.header.id,
          piSessionVersion: parsed.header.version,
          activeLeafId: parsed.activePath.at(-1)?.id ?? null,
        },
      },
      timestamp: now?.() ?? timestamp(parsed.header.timestamp),
      visibility: 'internal',
    },
  ];
  if (typeof parsed.header['parentSession'] === 'string') {
    stored.push({
      event: { type: 'custom.appended', kind: 'native.import.pi.parent-source', value: parsed.header['parentSession'] },
      timestamp: timestamp(parsed.header.timestamp),
      visibility: 'internal',
    });
  }
  for (const entry of parsed.contextEntries) {
    const projected = projectPiContextEntry(entry);
    if (projected !== null) stored.push(projected);
  }
  return stored.map((item, index): SessionEvent => ({
    schemaVersion: 1,
    sessionId: destinationId,
    eventId: sessionEventId(`pi-import:${index + 1}`),
    revision: revision(String(index + 1)),
    sequence: index + 1,
    timestamp: item.timestamp,
    visibility: item.visibility,
    event: item.event,
  }));
}

function projectPiContextEntry(
  entry: PiEntry,
): { readonly event: SessionStoredEvent; readonly timestamp: number; readonly visibility: SessionEvent['visibility'] } | null {
  const entryTimestamp = timestamp(entry.timestamp);
  if (entry.type === 'message') {
    if (!isRecord(entry['message'])) throw migrationFailure(`Pi message entry ${entry.id} is malformed`);
    const message = entry['message'];
    if (message['role'] === 'user') {
      return messageProjection('user', textContent(message['content'], `Pi user message ${entry.id}`), entryTimestamp);
    }
    if (message['role'] === 'assistant') {
      const projected = assistantContent(message['content'], entry.id);
      return {
        event: {
          type: 'message.appended', role: 'assistant', content: projected.text,
          ...(projected.toolCalls.length === 0 ? {} : { toolCalls: projected.toolCalls }),
        },
        timestamp: entryTimestamp,
        visibility: 'model',
      };
    }
    if (message['role'] === 'toolResult') {
      if (!boundedString(message['toolCallId'], 500)) {
        throw migrationFailure(`Pi tool result ${entry.id} has no valid tool call id`);
      }
      return {
        event: {
          type: 'message.appended', role: 'tool',
          content: textContent(message['content'], `Pi tool result ${entry.id}`),
          toolCallId: message['toolCallId'],
        },
        timestamp: entryTimestamp,
        visibility: 'model',
      };
    }
    if (message['role'] === 'bashExecution') {
      if (message['excludeFromContext'] === true) return null;
      return messageProjection('user', bashExecutionText(message, entry.id), entryTimestamp);
    }
    if (message['role'] === 'custom' || message['role'] === 'hookMessage') {
      return messageProjection('user', textContent(message['content'], `Pi custom message ${entry.id}`), entryTimestamp);
    }
    throw migrationFailure(`Pi message role is unsupported in entry ${entry.id}`);
  }
  if (entry.type === 'custom_message') {
    return messageProjection('user', textContent(entry['content'], `Pi custom message ${entry.id}`), entryTimestamp);
  }
  if (entry.type === 'branch_summary') {
    if (typeof entry['summary'] !== 'string') throw migrationFailure(`Pi branch summary ${entry.id} is malformed`);
    return messageProjection('user', `${BRANCH_PREFIX}${entry['summary']}${BRANCH_SUFFIX}`, entryTimestamp);
  }
  if (entry.type === 'compaction') {
    if (typeof entry['summary'] !== 'string') throw migrationFailure(`Pi compaction ${entry.id} is malformed`);
    return messageProjection('user', `${COMPACTION_PREFIX}${entry['summary']}${COMPACTION_SUFFIX}`, entryTimestamp);
  }
  return null;
}

function messageProjection(
  role: 'user' | 'system',
  content: string,
  eventTimestamp: number,
): { readonly event: SessionStoredEvent; readonly timestamp: number; readonly visibility: 'model' } {
  return { event: { type: 'message.appended', role, content }, timestamp: eventTimestamp, visibility: 'model' };
}

function assistantContent(value: unknown, entryId: string): { readonly text: string; readonly toolCalls: readonly ModelToolCall[] } {
  if (!Array.isArray(value)) throw migrationFailure(`Pi assistant message ${entryId} has malformed content`);
  const text: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const part of value) {
    if (!isRecord(part) || typeof part['type'] !== 'string') {
      throw migrationFailure(`Pi assistant message ${entryId} has malformed content`);
    }
    if (part['type'] === 'thinking') {
      if (typeof part['thinking'] !== 'string') throw migrationFailure(`Pi assistant thinking ${entryId} is malformed`);
      continue;
    }
    if (part['type'] === 'text') {
      if (typeof part['text'] !== 'string') throw migrationFailure(`Pi assistant text ${entryId} is malformed`);
      text.push(part['text']);
      continue;
    }
    if (part['type'] === 'toolCall') {
      if (!boundedString(part['id'], 500) || !boundedString(part['name'], 500) || !isRecord(part['arguments'])) {
        throw migrationFailure(`Pi assistant tool call ${entryId} is malformed`);
      }
      if (part['namespace'] !== undefined) {
        throw migrationFailure(`Pi assistant tool call ${entryId} uses an unsupported namespace`);
      }
      toolCalls.push({ id: part['id'], name: part['name'], input: structuredClone(part['arguments']) });
      continue;
    }
    throw migrationFailure(`Pi assistant message ${entryId} contains unsupported ${part['type']} content`);
  }
  return { text: text.join(''), toolCalls };
}

function textContent(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) throw migrationFailure(`${label} has malformed content`);
  const text: string[] = [];
  for (const part of value) {
    if (!isRecord(part)) throw migrationFailure(`${label} has malformed content`);
    if (part['type'] === 'image') {
      throw migrationFailure(`${label} contains an image that native session events cannot preserve`);
    }
    if (part['type'] !== 'text' || typeof part['text'] !== 'string') {
      throw migrationFailure(`${label} contains unsupported content`);
    }
    text.push(part['text']);
  }
  return text.join('');
}

function bashExecutionText(message: JsonRecord, entryId: string): string {
  if (
    typeof message['command'] !== 'string'
    || typeof message['output'] !== 'string'
    || typeof message['cancelled'] !== 'boolean'
    || typeof message['truncated'] !== 'boolean'
  ) {
    throw migrationFailure(`Pi bash execution ${entryId} is malformed`);
  }
  let text = `Ran \`${message['command']}\`\n`;
  text += message['output'] ? `\`\`\`\n${message['output']}\n\`\`\`` : '(no output)';
  if (message['cancelled']) text += '\n\n(command cancelled)';
  else if (typeof message['exitCode'] === 'number' && message['exitCode'] !== 0) {
    text += `\n\nCommand exited with code ${message['exitCode']}`;
  }
  if (message['truncated'] && typeof message['fullOutputPath'] === 'string') {
    text += `\n\n[Output truncated. Full output: ${message['fullOutputPath']}]`;
  }
  return text;
}

export type PiSessionMigrationMode = 'disabled' | 'shadow' | 'canary' | 'enabled' | 'rollback';
export interface PiSessionMigrationPolicyV1 {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly mode: PiSessionMigrationMode;
  readonly cohortPercent: number;
  readonly cohortSalt: string;
}
export interface PiSessionMigrationDecision {
  readonly schemaVersion: 1;
  readonly policyRevision: string;
  readonly mode: PiSessionMigrationMode;
  readonly selected: boolean;
  readonly bucket: number;
  readonly reason: PiSessionMigrationMode | 'cohort-selected' | 'cohort-excluded';
}

/** Pure release boundary: no user settings, environment flags, or host package fallback. */
export function selectPiSessionMigration(
  value: unknown,
  installationId: string,
): PiSessionMigrationDecision {
  const policy = parseMigrationPolicy(value);
  if (!boundedString(installationId, 500)) throw migrationFailure('Migration installation id is invalid');
  const hash = createHash('sha256')
    .update(policy.cohortSalt)
    .update('\0')
    .update(policy.revision)
    .update('\0')
    .update(installationId)
    .digest();
  const bucket = Math.floor((hash.readUInt32BE(0) / 0x1_0000_0000) * 10_000);
  const selected = policy.mode === 'enabled'
    || (policy.mode === 'canary' && bucket < policy.cohortPercent * 100);
  const reason = policy.mode === 'canary'
    ? selected ? 'cohort-selected' : 'cohort-excluded'
    : policy.mode;
  return Object.freeze({
    schemaVersion: 1,
    policyRevision: policy.revision,
    mode: policy.mode,
    selected,
    bucket,
    reason,
  });
}

function parseMigrationPolicy(value: unknown): PiSessionMigrationPolicyV1 {
  if (!isRecord(value)) throw migrationFailure('Migration policy must be an object');
  const allowed = new Set(['schemaVersion', 'revision', 'mode', 'cohortPercent', 'cohortSalt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw migrationFailure('Migration policy contains unknown fields');
  }
  if (
    value['schemaVersion'] !== 1
    || !boundedString(value['revision'], 200)
    || typeof value['mode'] !== 'string'
    || !MIGRATION_MODES.has(value['mode'] as PiSessionMigrationMode)
    || !Number.isInteger(value['cohortPercent'])
    || Number(value['cohortPercent']) < 0
    || Number(value['cohortPercent']) > 100
    || !boundedString(value['cohortSalt'], 500)
  ) {
    throw migrationFailure('Migration policy cohort, mode, or revision is invalid');
  }
  return value as unknown as PiSessionMigrationPolicyV1;
}

const MIGRATION_MODES = new Set<PiSessionMigrationMode>([
  'disabled', 'shadow', 'canary', 'enabled', 'rollback',
]);

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw migrationFailure('Pi session timestamp is invalid');
  return parsed;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrationFailure(message: string): RuntimeFailure {
  return new RuntimeFailure('session-migration', message, 'unsafe', true, 'sensitive');
}
