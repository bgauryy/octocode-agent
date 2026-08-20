/**
 * sessions.ts — scan Pi's bucketed session storage.
 *
 * Pi stores sessions per project cwd:
 *   ~/.pi/agent/sessions/<--encoded-cwd-->/<timestamp>_<uuid>.jsonl
 * The file's first JSONL line is the session header (`{"type":"session", id, cwd,
 * timestamp, ...}`) — the authoritative source for id+cwd (bucket names are only a
 * display fallback; their encoding is a Pi internal).
 *
 * Pi itself resolves `--session <key>` fuzzy+globally (main.js resolveSessionPath),
 * so this module's job is LISTING (pickers/reports), not resolution.
 */
import fs from 'node:fs';
import path from 'node:path';
import { piAgentDir } from './settings.js';

export interface SessionFile {
  /** Full filename without extension: `<timestamp>_<uuid>` — Pi accepts this key. */
  key: string;
  /** Header id (uuid) when readable; falls back to the filename uuid segment. */
  uuid: string;
  /** Project cwd from the session header; decoded bucket name as fallback. */
  cwd: string | null;
  file: string;
  mtimeMs: number;
}

/** Parse the first JSONL line; tolerant to partial/corrupt files. */
function readHeader(file: string): { id?: string; cwd?: string } {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      const line = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed?.type !== 'session') return {};
      return {
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
}

/**
 * Inverse of Pi's `getDefaultSessionDirPath` (`sessions-manager.js`):
 * `--${cwd minus leading slash, with / \\ : → '-'}--`. Display fallback only —
 * hyphenated dir names make the inverse lossy; header cwd wins when present.
 */
export function decodeBucketName(bucket: string): string {
  const inner = bucket.replace(/^--|--$/g, '');
  return '/' + inner.replace(/-/g, '/');
}

/**
 * All sessions across all project buckets, newest first.
 * Tolerant: unreadable buckets/files are skipped, never fatal.
 */
export function listSessions(sessionsRoot: string = path.join(piAgentDir(), 'sessions')): SessionFile[] {
  const out: SessionFile[] = [];
  let buckets: fs.Dirent[] = [];
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const b of buckets) {
    if (!b.isDirectory()) continue;
    const dir = path.join(sessionsRoot, b.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const key = f.replace(/\.jsonl$/, '');
      const header = readHeader(file);
      out.push({
        key,
        uuid: header.id ?? key.split('_').pop() ?? key,
        cwd: header.cwd ?? decodeBucketName(b.name),
        file,
        mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Sessions whose header cwd matches `cwd` exactly, newest first. */
export function listProjectSessions(
  cwd: string,
  sessionsRoot?: string,
): SessionFile[] {
  return listSessions(sessionsRoot).filter((s) => s.cwd === cwd);
}

/** Newest session belonging to `cwd` (post-launch breadcrumb anchor), or null. */
export function newestProjectSession(
  cwd: string,
  sessionsRoot?: string,
): SessionFile | null {
  return listProjectSessions(cwd, sessionsRoot)[0] ?? null;
}
