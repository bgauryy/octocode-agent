/**
 * settings.ts — write the Pi startup model the way Pi itself expects it.
 *
 * Pi's SettingsManager persists `defaultProvider` + `defaultModel` in
 * ~/.pi/agent/settings.json (settings-manager.js#455, model-resolver.js#451).
 * We mirror that exact contract — no extra files, no launcher-only state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

export function readSettings(piDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Persist defaultProvider+defaultModel without clobbering other settings. */
export function setDefaultModelInSettings(piDir: string, provider: string, modelId: string): string {
  fs.mkdirSync(piDir, { recursive: true });
  const data = readSettings(piDir);
  data['defaultProvider'] = provider;
  data['defaultModel'] = modelId;
  const file = path.join(piDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/** Current default "provider/model" for the banner; null when unset. */
export function readDefaultModel(piDir: string): string | null {
  const data = readSettings(piDir);
  const provider = data['defaultProvider'];
  const model = data['defaultModel'];
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : null;
}
