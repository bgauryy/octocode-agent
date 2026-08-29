/**
 * Native Octocode settings filesystem adapter.
 */
import path from 'node:path';
import { getOctocodeHome } from '@octocodeai/octocode-shared/paths';
import { FileSettingsStorage } from './native-settings.js';

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getOctocodeHome(env), 'agent');
}

function writeSettings(dir: string, data: Record<string, unknown>): string {
  const file = path.join(dir, 'settings.json');
  const storage = new FileSettingsStorage(file);
  storage.commit(storage.read().revision, data);
  return file;
}

export function readSettings(dir: string): Record<string, unknown> {
  try {
    return new FileSettingsStorage(path.join(dir, 'settings.json')).read().values;
  } catch {
    return {};
  }
}

// ── Generic settings surface (config get|set|list) ──────────────────────────────

/** Keys `config set` is allowed to write through the native settings adapter. */
export const ALLOWED_CONFIG_KEYS = ['defaultProvider', 'defaultModel', 'theme'] as const;

/** Theme name the launcher enforces for Octocode-branded sessions. */
export const DEFAULT_OCTOCODE_THEME = 'octocode-dark';
export const OCTOCODE_THEME_NAMES = [DEFAULT_OCTOCODE_THEME, 'octocode-light'] as const;
export type OctocodeThemeName = (typeof OCTOCODE_THEME_NAMES)[number];
export type AllowedConfigKey = (typeof ALLOWED_CONFIG_KEYS)[number];

export function isOctocodeTheme(value: unknown): value is OctocodeThemeName {
  return typeof value === 'string' && (OCTOCODE_THEME_NAMES as readonly string[]).includes(value);
}

export function isAllowedConfigKey(key: string): key is AllowedConfigKey {
  return (ALLOWED_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Read one key from settings.json (undefined when unset). */
export function getSetting(dir: string, key: string): unknown {
  return readSettings(dir)[key];
}

/**
 * Write a settings default only when the key is absent. Returns true when the
 * value was written. Use narrower helpers when a key needs value validation.
 */
export function ensureDefaultSetting(dir: string, key: string, value: string): boolean {
  const data = readSettings(dir);
  if (data[key] !== undefined) return false;
  data[key] = value;
  writeSettings(dir, data);
  return true;
}

/**
 * Octocode owns the agent theme: keep octocode-dark/light, replace every plain
 * unbranded theme (including dark/light) with the branded default on launch.
 */
export function ensureOctocodeThemeSetting(dir: string): boolean {
  const data = readSettings(dir);
  if (isOctocodeTheme(data['theme'])) return false;
  data['theme'] = DEFAULT_OCTOCODE_THEME;
  writeSettings(dir, data);
  return true;
}

/** Public allowlisted settings projection for diagnostics and `config list`. */
export function listSettings(dir: string): Record<string, unknown> {
  const stored = readSettings(dir);
  return Object.fromEntries(
    ALLOWED_CONFIG_KEYS
      .filter((key) => stored[key] !== undefined)
      .map((key) => [key, stored[key]]),
  );
}

/** Current default "provider/model" selection; null when unset. */
export function readDefaultModel(dir: string): string | null {
  const data = readSettings(dir);
  const provider = data['defaultProvider'];
  const model = data['defaultModel'];
  return typeof provider === 'string' && typeof model === 'string' ? `${provider}/${model}` : null;
}
