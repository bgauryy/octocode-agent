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

// ── Generic settings surface (config get|set|list) ──────────────────────────────

/** Keys `config set` is allowed to write — Pi's own contract fields only. */
export const ALLOWED_CONFIG_KEYS = ['defaultProvider', 'defaultModel', 'theme'] as const;

/** Theme name the launcher pins as the first-launch default (shipped by @octocodeai/pi-extension). */
export const DEFAULT_OCTOCODE_THEME = 'octocode-dark';
export type AllowedConfigKey = (typeof ALLOWED_CONFIG_KEYS)[number];

export function isAllowedConfigKey(key: string): key is AllowedConfigKey {
  return (ALLOWED_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Read one key from Pi's settings.json (undefined when unset). */
export function getSetting(piDir: string, key: string): unknown {
  return readSettings(piDir)[key];
}

/** Write one allowlisted key without clobbering other settings. Returns the file. */
export function setSetting(piDir: string, key: AllowedConfigKey, value: string): string {
  fs.mkdirSync(piDir, { recursive: true });
  const data = readSettings(piDir);
  data[key] = value;
  const file = path.join(piDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/**
 * Write a settings default only when the key is absent. First-launch identity
 * defaults (e.g. the branded theme) use this; any later user choice wins.
 * Returns true when the value was written.
 */
export function ensureDefaultSetting(piDir: string, key: string, value: string): boolean {
  const data = readSettings(piDir);
  if (data[key] !== undefined) return false;
  fs.mkdirSync(piDir, { recursive: true });
  data[key] = value;
  const file = path.join(piDir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return true;
}

/** Full settings doc for diagnostics / `config list`. */
export function listSettings(piDir: string): Record<string, unknown> {
  return readSettings(piDir);
}

/** Current default "provider/model" for the banner; null when unset. */
export function readDefaultModel(piDir: string): string | null {
  const data = readSettings(piDir);
  const provider = data['defaultProvider'];
  const model = data['defaultModel'];
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : null;
}
