import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RuntimeFailure, parseSessionRecord, revision, type LegacySessionSource, type Revision, type SessionEvent, type SessionId, type SessionRecord, type SessionRecordPort } from '@octocodeai/agent-core';
import { ensurePrivateDirectory, hardenPrivateFile } from './private-fs.js';

function parseRecord(content: string, id: SessionId): SessionRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`Session ${id} is corrupt`); }
  return parseSessionRecord(parsed, id);
}

interface FileSessionRecordPortOptions { readonly checkpointEvery?: number; readonly maxDiagnostics?: number; }
interface SessionSegment { readonly schemaVersion: 1; readonly sessionId: SessionId; readonly expectedRevision: Revision; readonly nextRevision: Revision; readonly events: readonly SessionEvent[]; }
interface SessionLock { readonly schemaVersion: 1; readonly pid: number; readonly token: string; readonly createdAt: number; }

export class FileSessionRecordPort implements SessionRecordPort {
  readonly #checkpointEvery: number;
  readonly #maxDiagnostics: number;
  constructor(readonly directory: string, options: FileSessionRecordPortOptions = {}) {
    this.#checkpointEvery = Number.isSafeInteger(options.checkpointEvery) && Number(options.checkpointEvery) > 0 ? Number(options.checkpointEvery) : 64;
    this.#maxDiagnostics = Number.isSafeInteger(options.maxDiagnostics) && Number(options.maxDiagnostics) > 0 ? Number(options.maxDiagnostics) : 256;
  }
  pathFor(id: SessionId): string { return path.join(this.directory, `${encodeURIComponent(id)}.json`); }
  backupPathFor(id: SessionId): string { return `${this.pathFor(id)}.bak`; }
  lockPathFor(id: SessionId): string { return `${this.pathFor(id)}.lock`; }
  headPathFor(id: SessionId): string { return `${this.pathFor(id)}.head`; }
  segmentDirectoryFor(id: SessionId): string { return `${this.pathFor(id)}.segments`; }

  async read(id: SessionId): Promise<{ content: string; recovered: boolean } | null> {
    const base = this.#readBase(id);
    const segments = this.#readSegments(id);
    if (base === null && segments.length === 0) return null;
    let record: SessionRecord = base === null
      ? { schemaVersion: 1, sessionId: id, revision: revision('0'), events: [] }
      : parseRecord(base.content, id);
    for (const segment of segments) {
      if (Number(segment.nextRevision) <= Number(record.revision)) continue;
      if (segment.expectedRevision !== record.revision) throw new RuntimeFailure('session-corruption', 'Session append segment revision chain is invalid', 'unsafe', true, 'sensitive');
      const events = [...record.events, ...segment.events];
      record = record.schemaVersion === 2
        ? { ...record, revision: segment.nextRevision, events }
        : { schemaVersion: 1, sessionId: id, revision: segment.nextRevision, events };
      parseSessionRecord(record, id);
    }
    return { content: JSON.stringify(record), recovered: base?.recovered ?? false };
  }

  #readBase(id: SessionId): { content: string; recovered: boolean } | null {
    const primary = this.pathFor(id);
    if (!fs.existsSync(primary)) {
      const backup = this.backupPathFor(id);
      if (!fs.existsSync(backup)) return null;
      this.#rejectSymlink(backup);
      const content = fs.readFileSync(backup, 'utf8');
      parseRecord(content, id);
      this.#writeAtomic(primary, content);
      return { content, recovered: true };
    }
    this.#rejectSymlink(primary);
    try {
      const content = fs.readFileSync(primary, 'utf8');
      parseRecord(content, id);
      return { content, recovered: false };
    } catch (primaryError) {
      const backup = this.backupPathFor(id);
      if (!fs.existsSync(backup)) throw primaryError;
      this.#rejectSymlink(backup);
      const content = fs.readFileSync(backup, 'utf8');
      parseRecord(content, id);
      this.#writeAtomic(primary, content);
      return { content, recovered: true };
    }
  }

  async commit(id: SessionId, expectedRevision: Revision, nextRevision: Revision, content: string): Promise<void> {
    const candidate = parseRecord(content, id);
    if (candidate.revision !== nextRevision) throw new Error(`Session ${id} next revision does not match content`);
    ensurePrivateDirectory(this.directory);
    const lock = this.#acquireLock(id);
    try {
      const current = await this.read(id);
      const durableRevision = current ? parseRecord(current.content, id).revision : '0';
      if (durableRevision !== expectedRevision) {
        throw new RuntimeFailure('session-conflict', `Session revision conflict: expected ${expectedRevision}, current ${durableRevision}`, 'safe');
      }
      const primary = this.pathFor(id);
      if (current) this.#writeAtomic(this.backupPathFor(id), current.content);
      this.#writeAtomic(primary, content);
      this.#clearSegments(id);
      this.#writeHead(id, nextRevision);
    } finally {
      this.#releaseLock(id, lock);
    }
  }

  async readRevision(id: SessionId): Promise<Revision | null> {
    let highest: number | undefined;
    const head = this.headPathFor(id);
    if (fs.existsSync(head)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(head, 'utf8')) as { schemaVersion?: unknown; revision?: unknown };
        if (parsed.schemaVersion === 1 && typeof parsed.revision === 'string' && Number.isSafeInteger(Number(parsed.revision))) highest = Number(parsed.revision);
      } catch { /* Fall through to durable files. */ }
    }
    for (const file of this.#segmentFiles(id)) {
      const match = /-(\d+)\.json$/u.exec(file);
      if (match) highest = Math.max(highest ?? 0, Number(match[1]));
    }
    if (highest !== undefined) return revision(String(highest));
    const base = this.#readBase(id);
    return base === null ? null : parseRecord(base.content, id).revision;
  }

  async appendEvents(id: SessionId, expectedRevision: Revision, nextRevision: Revision, events: readonly SessionEvent[]): Promise<{ readonly checkpointed: boolean }> {
    if (events.length === 0 || Number(nextRevision) !== Number(expectedRevision) + events.length) throw new RuntimeFailure('validation', 'Session append segment has an invalid revision range');
    const lock = this.#acquireLock(id);
    try {
      const durableRevision = await this.readRevision(id) ?? revision('0');
      if (durableRevision !== expectedRevision) throw new RuntimeFailure('session-conflict', `Session revision conflict: expected ${expectedRevision}, current ${durableRevision}`, 'safe');
      if (expectedRevision === revision('0') && !fs.existsSync(this.pathFor(id)) && !fs.existsSync(this.backupPathFor(id))) {
        const record: SessionRecord = { schemaVersion: 1, sessionId: id, revision: nextRevision, events };
        parseSessionRecord(record, id);
        const content = JSON.stringify(record);
        this.#writeAtomic(this.backupPathFor(id), content);
        this.#writeAtomic(this.pathFor(id), content);
      } else {
        const segment: SessionSegment = { schemaVersion: 1, sessionId: id, expectedRevision, nextRevision, events };
        const directory = this.segmentDirectoryFor(id);
        ensurePrivateDirectory(directory);
        this.#writeAtomic(path.join(directory, `${String(Number(expectedRevision) + 1).padStart(16, '0')}-${String(Number(nextRevision)).padStart(16, '0')}.json`), JSON.stringify(segment));
      }
      this.#writeHead(id, nextRevision);
      const checkpointed = this.#segmentFiles(id).length >= this.#checkpointEvery;
      if (checkpointed) this.#checkpoint(id);
      return { checkpointed };
    } finally {
      this.#releaseLock(id, lock);
    }
  }

  #readSegments(id: SessionId): SessionSegment[] {
    return this.#segmentFiles(id).map((file) => {
      const value = JSON.parse(fs.readFileSync(path.join(this.segmentDirectoryFor(id), file), 'utf8')) as SessionSegment;
      if (value.schemaVersion !== 1 || value.sessionId !== id || !Array.isArray(value.events)) throw new RuntimeFailure('session-corruption', 'Session append segment is invalid', 'unsafe', true, 'sensitive');
      return value;
    });
  }

  #segmentFiles(id: SessionId): string[] {
    const directory = this.segmentDirectoryFor(id);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((file) => /^\d{16}-\d{16}\.json$/u.test(file)).sort();
  }

  #checkpoint(id: SessionId): void {
    const loaded = this.#readBase(id);
    let record: SessionRecord = loaded === null
      ? { schemaVersion: 1, sessionId: id, revision: revision('0'), events: [] }
      : parseRecord(loaded.content, id);
    for (const segment of this.#readSegments(id)) {
      if (Number(segment.nextRevision) <= Number(record.revision)) continue;
      if (segment.expectedRevision !== record.revision) throw new RuntimeFailure('session-corruption', 'Session append segment revision chain is invalid', 'unsafe', true, 'sensitive');
      record = record.schemaVersion === 2
        ? { ...record, revision: segment.nextRevision, events: [...record.events, ...segment.events] }
        : { schemaVersion: 1, sessionId: id, revision: segment.nextRevision, events: [...record.events, ...segment.events] };
    }
    const diagnostics = record.events.filter(({ visibility }) => visibility === 'diagnostics');
    const dropped = Math.max(0, diagnostics.length - this.#maxDiagnostics);
    const droppedIds = new Set(diagnostics.slice(0, dropped).map(({ eventId }) => String(eventId)));
    const omittedDiagnostics = (record.schemaVersion === 2 ? record.retention.omittedDiagnostics : 0) + dropped;
    const checkpoint: SessionRecord = {
      schemaVersion: 2,
      sessionId: id,
      revision: record.revision,
      retention: { omittedDiagnostics, maxDiagnostics: this.#maxDiagnostics },
      events: record.events.filter(({ eventId }) => !droppedIds.has(String(eventId))),
    };
    parseSessionRecord(checkpoint, id);
    const content = JSON.stringify(checkpoint);
    this.#writeAtomic(this.backupPathFor(id), content);
    this.#writeAtomic(this.pathFor(id), content);
    this.#clearSegments(id);
  }

  #writeHead(id: SessionId, value: Revision): void { this.#writeAtomic(this.headPathFor(id), JSON.stringify({ schemaVersion: 1, revision: value })); }

  #clearSegments(id: SessionId): void {
    const directory = this.segmentDirectoryFor(id);
    for (const file of this.#segmentFiles(id)) fs.unlinkSync(path.join(directory, file));
  }

  #acquireLock(id: SessionId): { readonly descriptor: number; readonly token: string } {
    ensurePrivateDirectory(this.directory);
    const file = this.lockPathFor(id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      try {
        const descriptor = fs.openSync(file, 'wx', 0o600);
        const owner: SessionLock = { schemaVersion: 1, pid: process.pid, token, createdAt: Date.now() };
        fs.writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
        fs.fsyncSync(descriptor);
        return { descriptor, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt === 0 && this.#reclaimDeadLock(file)) continue;
        throw new RuntimeFailure('session-conflict', `Session ${id} is being modified`, 'safe');
      }
    }
    throw new RuntimeFailure('session-conflict', `Session ${id} is being modified`, 'safe');
  }

  #reclaimDeadLock(file: string): boolean {
    let owner: SessionLock;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock; }
    catch { return false; }
    if (owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || !owner.token) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
      if (current.token !== owner.token || current.pid !== owner.pid) return false;
      fs.unlinkSync(file);
      return true;
    } catch { return false; }
  }

  #releaseLock(id: SessionId, lock: { readonly descriptor: number; readonly token: string }): void {
    fs.closeSync(lock.descriptor);
    const file = this.lockPathFor(id);
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionLock;
      if (owner.token === lock.token && owner.pid === process.pid) fs.unlinkSync(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  #rejectSymlink(file: string): void {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Session path must not be a symbolic link: ${file}`);
  }

  #writeAtomic(file: string, content: string): void {
    ensurePrivateDirectory(path.dirname(file));
    hardenPrivateFile(file);
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    hardenPrivateFile(file);
    try {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      // Some platforms do not allow syncing directory handles.
    }
  }
}

export class JsonlLegacySessionSource implements LegacySessionSource {
  readonly sourceId: string;
  constructor(readonly file: string) { this.sourceId = `jsonl:${path.basename(file)}`; }
  async digest(): Promise<string> {
    return createHash('sha256').update(fs.readFileSync(this.file)).digest('hex');
  }
  async *readRecords(): AsyncIterable<unknown> {
    const lines = createInterface({ input: fs.createReadStream(this.file), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      try { yield JSON.parse(line) as unknown; }
      catch { yield { type: 'corrupt-record', line: lineNumber }; }
    }
  }
}
