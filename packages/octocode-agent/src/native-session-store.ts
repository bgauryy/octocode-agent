import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { RuntimeFailure, parseSessionRecord, type LegacySessionSource, type Revision, type SessionId, type SessionRecord, type SessionRecordPort } from '@octocodeai/agent-core';
import { ensurePrivateDirectory, hardenPrivateFile } from './private-fs.js';

function parseRecord(content: string, id: SessionId): SessionRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`Session ${id} is corrupt`); }
  return parseSessionRecord(parsed, id);
}

export class FileSessionRecordPort implements SessionRecordPort {
  constructor(readonly directory: string) {}
  pathFor(id: SessionId): string { return path.join(this.directory, `${encodeURIComponent(id)}.json`); }
  backupPathFor(id: SessionId): string { return `${this.pathFor(id)}.bak`; }
  lockPathFor(id: SessionId): string { return `${this.pathFor(id)}.lock`; }

  async read(id: SessionId): Promise<{ content: string; recovered: boolean } | null> {
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
    const lock = this.lockPathFor(id);
    let lockDescriptor: number;
    try {
      lockDescriptor = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RuntimeFailure('session-conflict', `Session ${id} is being modified`, 'safe');
      }
      throw error;
    }
    try {
      const current = await this.read(id);
      const durableRevision = current ? parseRecord(current.content, id).revision : '0';
      if (durableRevision !== expectedRevision) {
        throw new RuntimeFailure('session-conflict', `Session revision conflict: expected ${expectedRevision}, current ${durableRevision}`, 'safe');
      }
      const primary = this.pathFor(id);
      if (current) this.#writeAtomic(this.backupPathFor(id), current.content);
      this.#writeAtomic(primary, content);
    } finally {
      try { fs.closeSync(lockDescriptor); }
      finally {
        try { fs.unlinkSync(lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
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
