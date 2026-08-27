import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FileSettingsStorage, renderSettingsHtml } from '../src/native-settings.js';

describe('native settings storage and page', () => {
  it('uses revisions, atomic replacement, backups, and redacted projections', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-native-settings-'));
    const store = new FileSettingsStorage(path.join(dir, 'settings.json'));
    const first = store.commit('0', { theme: 'octocode-dark', apiKey: 'synthetic-secret' });
    expect(() => store.commit('0', { theme: 'octocode-light' })).toThrow(/revision/i);
    const second = store.commit(first.revision, { theme: 'octocode-light', apiKey: 'synthetic-secret' });
    expect(second.revision).not.toBe(first.revision);
    expect(store.project().values).toEqual({ theme: 'octocode-light', apiKey: { configured: true } });
    expect(fs.readFileSync(`${store.file}.bak`, 'utf8')).not.toContain('octocode-light');
  });

  it('renders the one settings control center with models, hooks, and plugins without secrets', () => {
    const html = renderSettingsHtml({
      revision: 'r1',
      values: { theme: 'octocode-dark', apiKey: { configured: true } },
    });
    for (const section of ['overview', 'runtime', 'appearance', 'models', 'hooks', 'plugins', 'commands', 'connections', 'skills', 'overrides', 'diagnostics']) {
      expect(html).toContain(`id="${section}"`);
    }
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('synthetic-secret');
  });
});
