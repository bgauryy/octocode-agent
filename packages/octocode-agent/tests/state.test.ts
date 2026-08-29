import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { readAgentState, readBreadcrumb, writeAgentState, writeBreadcrumb } from '../src/state.js';

describe('launcher home state', () => {
  it('writes state and terminal breadcrumbs atomically with private permissions', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-state-'));
    fs.chmodSync(home, 0o755);
    const sessionFile = path.join(home, 'session.json');
    fs.writeFileSync(sessionFile, '{}');

    const stateFile = writeAgentState(home, { setupVersion: 1 });
    const breadcrumb = writeBreadcrumb(home, '%7/unsafe', { sessionFile, cwd: '/workspace' });

    expect(readAgentState(home)).toEqual({ setupVersion: 1 });
    expect(readBreadcrumb(home, '%7/unsafe')).toMatchObject({ sessionFile, cwd: '/workspace' });
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(breadcrumb).not.toBeNull();
    expect(fs.statSync(breadcrumb!).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(breadcrumb!)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
