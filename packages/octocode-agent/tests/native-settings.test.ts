import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FileSettingsStorage } from '../src/native-settings.js';

describe('native settings storage and page', () => {
  it('uses revisions, atomic replacement, backups, and redacted projections', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-settings-'));
    const store = new FileSettingsStorage(path.join(dir, 'settings.json'));
    fs.chmodSync(dir, 0o755);
    const first = store.commit('0', { theme: 'octocode-dark', apiKey: 'synthetic-secret' });
    expect(() => store.commit('0', { theme: 'octocode-light' })).toThrow(/revision/i);
    const second = store.commit(first.revision, { theme: 'octocode-light', apiKey: 'synthetic-secret' });
    expect(second.revision).not.toBe(first.revision);
    expect(store.project().values).toEqual({ theme: 'octocode-light', apiKey: { configured: true } });
    expect(fs.readFileSync(`${store.file}.bak`, 'utf8')).not.toContain('octocode-light');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${store.file}.bak`).mode & 0o777).toBe(0o600);
  });
});
