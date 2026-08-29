import { join, resolve } from 'node:path';

export type AwarenessStorageScope = 'repo' | 'global';

export function parseStorageScope(
  value: string | null | undefined,
  fallback: AwarenessStorageScope = 'global',
): AwarenessStorageScope {
  if (value == null || value.trim() === '') return fallback;
  if (value === 'repo' || value === 'global') return value;
  throw new Error('--db-scope must be repo or global');
}

export function repoDatabasePath(workspace: string, databaseName: string): string {
  return join(resolve(workspace), '.octocode', databaseName);
}
