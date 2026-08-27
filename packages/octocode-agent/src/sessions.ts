import fs from 'node:fs';
import path from 'node:path';
import type { SessionRecord } from '@octocodeai/agent-core';

import { agentDir } from './settings.js';

export interface SessionFile {
  key: string;
  uuid: string;
  cwd: string | null;
  file: string;
  mtimeMs: number;
}

export function nativeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env), 'sessions');
}

function readSessionRecord(file: string, expectedId: string): SessionRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SessionRecord>;
    if (
      parsed.schemaVersion !== 1
      || parsed.sessionId !== expectedId
      || typeof parsed.revision !== 'string'
      || !Array.isArray(parsed.events)
    ) return null;
    return parsed as SessionRecord;
  } catch {
    return null;
  }
}

function sessionCwd(record: SessionRecord): string | null {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const stored = record.events[index]?.event;
    if (
      stored?.type === 'custom.appended'
      && stored.kind === 'session.cwd'
      && typeof stored.value === 'string'
    ) return stored.value;
  }
  return null;
}

export function listSessions(sessionsRoot: string = nativeSessionsDir()): SessionFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let id: string;
    try { id = decodeURIComponent(entry.name.slice(0, -'.json'.length)); }
    catch { continue; }
    const file = path.join(sessionsRoot, entry.name);
    const record = readSessionRecord(file, id);
    if (!record) continue;
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(file).mtimeMs; }
    catch { continue; }
    sessions.push({ key: id, uuid: id, cwd: sessionCwd(record), file, mtimeMs });
  }
  return sessions.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function listProjectSessions(cwd: string, sessionsRoot?: string): SessionFile[] {
  return listSessions(sessionsRoot).filter((session) => session.cwd === cwd);
}

export function newestProjectSession(cwd: string, sessionsRoot?: string): SessionFile | null {
  return listProjectSessions(cwd, sessionsRoot)[0] ?? null;
}
