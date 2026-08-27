import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  OCTOCODE_DB_FILENAME,
  awarenessDbPath,
  getOctocodeHome,
  octocodeDbPath,
  safeSessionId,
  sessionArtifactDir,
  sessionDir,
  sessionsRoot,
} from '../src/paths.js';

const HOME = '/tmp/octo-home';
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ OCTOCODE_AGENT_DIR: HOME, ...extra });

describe('getOctocodeHome', () => {
  it('honors OCTOCODE_AGENT_DIR over config resolution', () => {
    expect(getOctocodeHome(env())).toBe(HOME);
  });
});

describe('octocodeDbPath', () => {
  it('defaults to <home>/octocode.sqlite3', () => {
    expect(octocodeDbPath(env())).toBe(join(HOME, OCTOCODE_DB_FILENAME));
  });

  it('honors OCTOCODE_DB_PATH override', () => {
    expect(octocodeDbPath(env({ OCTOCODE_DB_PATH: '/var/db/x.sqlite3' }))).toBe('/var/db/x.sqlite3');
  });

  it('ignores a blank OCTOCODE_DB_PATH override', () => {
    expect(octocodeDbPath(env({ OCTOCODE_DB_PATH: '   ' }))).toBe(join(HOME, OCTOCODE_DB_FILENAME));
  });
});

describe('awarenessDbPath', () => {
  it('lives under the same home in its own file', () => {
    expect(awarenessDbPath(env())).toBe(join(HOME, 'memory', 'awareness.sqlite3'));
  });
});

describe('session paths', () => {
  it('roots sessions under <home>/agent/sessions', () => {
    expect(sessionsRoot(env())).toBe(join(HOME, 'agent', 'sessions'));
  });

  it('builds a per-session directory', () => {
    expect(sessionDir('abc123', env())).toBe(join(HOME, 'agent', 'sessions', 'abc123'));
  });

  it('builds artifact bucket directories', () => {
    expect(sessionArtifactDir('abc123', 'compaction', env())).toBe(
      join(HOME, 'agent', 'sessions', 'abc123', 'compaction'),
    );
  });
});

describe('safeSessionId', () => {
  it('sanitizes unsafe characters', () => {
    expect(safeSessionId('a/b c:d')).toBe('a_b_c_d');
  });

  it('falls back to a pid-scoped id when empty', () => {
    expect(safeSessionId('   ')).toBe(`pid-${process.pid}`);
    expect(safeSessionId(null)).toBe(`pid-${process.pid}`);
  });

  it('caps very long ids', () => {
    expect(safeSessionId('x'.repeat(200))).toHaveLength(96);
  });
});
