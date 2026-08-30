import fs from 'node:fs';
import path from 'node:path';
import { parseSessionRecord, sessionId, type SessionRecord } from '@octocodeai/agent-core';

import { agentDir } from './settings.js';

export interface SessionFile {
  key: string;
  uuid: string;
  cwd: string | null;
  parentSessionId?: string;
  file: string;
  mtimeMs: number;
}

export type SessionNavigationDirection = 'parent' | 'child' | 'previous' | 'next';

export function nativeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentDir(env), 'sessions');
}

function readSessionRecord(file: string, expectedId: string): SessionRecord | null {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      return parseSessionRecord(JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown, sessionId(expectedId));
    } catch {
      // Inventory may inspect the backup, but only the transactional store promotes it.
    }
  }
  return null;
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

function sessionParent(record: SessionRecord): string | undefined {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const stored = record.events[index]?.event;
    if (
      stored?.type === 'custom.appended'
      && stored.kind === 'session.parent'
      && typeof stored.value === 'string'
      && stored.value.trim()
    ) return stored.value;
  }
  return undefined;
}

export function listSessions(sessionsRoot: string = nativeSessionsDir()): SessionFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const encoded = entry.name.endsWith('.json.bak')
      ? entry.name.slice(0, -'.json.bak'.length)
      : entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : null;
    if (encoded === null) continue;
    let id: string;
    try { id = decodeURIComponent(encoded); }
    catch { continue; }
    ids.add(id);
  }

  const sessions: SessionFile[] = [];
  for (const id of ids) {
    const file = path.join(sessionsRoot, `${encodeURIComponent(id)}.json`);
    const record = readSessionRecord(file, id);
    if (!record) continue;
    const transactionFiles = [file, `${file}.bak`, `${file}.head`].filter((candidate) => fs.existsSync(candidate));
    if (transactionFiles.length === 0) continue;
    let mtimeMs: number;
    try { mtimeMs = Math.max(...transactionFiles.map((candidate) => fs.statSync(candidate).mtimeMs)); }
    catch { continue; }
    const parentSessionId = sessionParent(record);
    sessions.push({
      key: id,
      uuid: id,
      cwd: sessionCwd(record),
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      file,
      mtimeMs,
    });
  }
  return sessions.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

export function listProjectSessions(cwd: string, sessionsRoot?: string): SessionFile[] {
  return listSessions(sessionsRoot).filter((session) => session.cwd === cwd);
}

export function newestProjectSession(cwd: string, sessionsRoot?: string): SessionFile | null {
  return listProjectSessions(cwd, sessionsRoot)[0] ?? null;
}

export function resolveSessionNavigation(
  current: string,
  direction: SessionNavigationDirection,
  cwd: string,
  sessionsRoot?: string,
): string | null {
  const available = listProjectSessions(cwd, sessionsRoot);
  const index = available.findIndex(({ uuid }) => uuid === current);
  if (index < 0) return null;
  if (direction === 'parent') {
    const parent = available[index]?.parentSessionId;
    return parent !== undefined && available.some(({ uuid }) => uuid === parent) ? parent : null;
  }
  if (direction === 'child') return available.find(({ parentSessionId }) => parentSessionId === current)?.uuid ?? null;
  const target = direction === 'previous' ? available[index + 1] : available[index - 1];
  return target?.uuid ?? null;
}
