/**
 * paths.ts — canonical Octocode home + on-disk layout.
 *
 * Single source of truth for where Octocode keeps its state. Everything lives
 * under the Octocode home (`~/.octocode` by default):
 *
 *   <home>/octocode.sqlite3                       the shared local DB (agent + lite + sessions)
 *   <home>/memory/awareness.sqlite3               the full-awareness store (own schema contract)
 *   <home>/agent/sessions/<sessionId>/            per-session artifacts
 *       compaction/   plans/   logs/   db/
 *
 * Home resolution is NEVER reimplemented — it delegates to `@octocodeai/config`
 * (`OCTOCODE_HOME` → platform default), with the launcher-scoped
 * `OCTOCODE_AGENT_DIR` override taking precedence when set.
 */
import { join, resolve } from 'node:path';
import { getOctocodeHome as configGetOctocodeHome } from '@octocodeai/config';

/** Filename of the single shared local SQLite store, under the Octocode home. */
export const OCTOCODE_DB_FILENAME = 'octocode.sqlite3';

/** Env var that pins the shared DB file, overriding the home-relative default. */
export const OCTOCODE_DB_PATH_ENV = 'OCTOCODE_DB_PATH';

/** Per-session artifact buckets written under `<home>/agent/sessions/<id>/`. */
export type SessionArtifact = 'compaction' | 'plans' | 'logs' | 'db';

/**
 * Resolve the Octocode home directory.
 * Precedence: OCTOCODE_AGENT_DIR › @octocodeai/config (OCTOCODE_HOME › platform default).
 */
export function getOctocodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOCODE_AGENT_DIR ?? configGetOctocodeHome(env);
}

/**
 * Path to the single shared local SQLite store.
 * `OCTOCODE_DB_PATH` overrides the home-relative default (used by tests and
 * callers that need an isolated file).
 */
export function octocodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OCTOCODE_DB_PATH_ENV]?.trim();
  if (override) return resolve(override);
  return join(getOctocodeHome(env), OCTOCODE_DB_FILENAME);
}

/**
 * Path to the full-awareness store. Awareness owns its own strict schema
 * contract, so it lives in a separate file — but under the same shared home.
 */
export function awarenessDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOctocodeHome(env), 'memory', 'awareness.sqlite3');
}

/** Root that holds every session's artifact directory. */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOctocodeHome(env), 'agent', 'sessions');
}

/**
 * Normalise a session identifier into a filesystem-safe directory segment.
 * Falls back to a process-scoped id when no session id is available, matching
 * the harness convention (`pid-<pid>`).
 */
export function safeSessionId(sessionId?: string | null): string {
  const trimmed = (sessionId ?? '').trim();
  const safe = trimmed.replace(/[^\w.-]+/g, '_').slice(0, 96);
  return safe || `pid-${process.pid}`;
}

/** Directory holding all artifacts for one session. */
export function sessionDir(sessionId?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return join(sessionsRoot(env), safeSessionId(sessionId));
}

/** Directory for one artifact bucket within a session (e.g. `compaction`). */
export function sessionArtifactDir(
  sessionId: string | null | undefined,
  kind: SessionArtifact,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(sessionDir(sessionId, env), kind);
}
