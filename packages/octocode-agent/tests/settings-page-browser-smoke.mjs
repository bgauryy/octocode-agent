import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileSettingsStorage } from '../src/native-settings.ts';
import { createNativeSettingsPageController } from '../src/native-settings-page.ts';
import { createNativeSettingsService } from '../src/native-settings-service.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-settings-browser-'));
const storage = new FileSettingsStorage(path.join(directory, 'settings.json'));
storage.commit('0', {
  theme: 'octocode-dark',
  defaultModel: 'gpt-5.6',
  defaultProvider: 'openai',
});
const settings = await createNativeSettingsService(storage);
const controller = createNativeSettingsPageController({
  settings,
  cwd: directory,
  env: { ENABLE_LOCAL: 'true' },
  getRuntimeSnapshot: () => ({
    schemaVersion: 1,
    state: 'ready',
    sessionId: 'browser-smoke',
    activeTurn: false,
    model: { providerId: 'openai', modelId: 'gpt-5.6' },
    thinkingLevel: 'high',
    usage: { inputTokens: 1200, outputTokens: 320 },
    revision: 1,
  }),
  workspaceTrust: 'trusted',
  capabilityControl: {
    snapshot: () => ({
      revision: 'browser-capabilities-1',
      mcpServers: [{ name: 'browser-smoke', enabled: true, tools: [{ name: 'search', enabled: true }] }],
      skills: [{ name: 'browser-smoke-skill', enabled: true }],
    }),
    mutate: async () => ({ ok: true, revision: 'browser-capabilities-2' }),
  },
  openUrl: async () => ({ ok: true }),
});
const opened = await controller.open('models');
if (!opened.ok || !opened.url) throw new Error(opened.message ?? 'settings page did not start');
process.stdout.write(`${opened.url}\n`);

const stop = async () => {
  await controller.close();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
setInterval(() => undefined, 60_000);
