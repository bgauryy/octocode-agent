import { join, resolve } from 'node:path';
import { getOctocodeHome } from '@octocodeai/octocode-shared/paths';

export type AwarenessStorageScope = 'repo' | 'global';

export const AWARENESS_APPLICATION_ID = 0x4f435431;
export const AWARENESS_DB_FILENAME = 'awareness.sqlite3';

export function parseStorageScope(
  value: string | null | undefined,
  fallback: AwarenessStorageScope = 'repo',
): AwarenessStorageScope {
  if (value == null || value.trim() === '') return fallback;
  if (value === 'repo' || value === 'global') return value;
  throw new Error('--db-scope must be repo or global');
}

export function repoDatabasePath(workspace: string, databaseName: string): string {
  return join(resolve(workspace), '.octocode', databaseName);
}

export function globalAwarenessDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getOctocodeHome(env), 'awareness', AWARENESS_DB_FILENAME);
}

export function awarenessDatabasePath(
  workspace: string,
  scope: AwarenessStorageScope = 'repo',
): string {
  return scope === 'global'
    ? globalAwarenessDatabasePath()
    : repoDatabasePath(workspace, AWARENESS_DB_FILENAME);
}
