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

/** Theme name the launcher enforces for Octocode-branded sessions. */
export const DEFAULT_OCTOCODE_THEME = 'octocode-dark';
export const OCTOCODE_THEME_NAMES = [DEFAULT_OCTOCODE_THEME, 'octocode-light'] as const;
export type OctocodeThemeName = (typeof OCTOCODE_THEME_NAMES)[number];

/** Public persistent settings exposed by `config get|set|list`. */
export const PUBLIC_CONFIG_SETTINGS = Object.freeze([
  {
    key: 'theme',
    value: 'octocode-dark|octocode-light',
    description: 'Terminal and settings-page color theme',
  },
  {
    key: 'reducedMotion',
    value: 'true|false',
    description: 'Use static terminal transitions',
  },
  {
    key: 'compactionInputTokenThreshold',
    value: '4096..2000000',
    description: 'Input-token occupancy that triggers compaction',
  },
  {
    key: 'defaultProvider',
    value: 'provider-id',
    description: 'Default model provider',
  },
  {
    key: 'defaultModel',
    value: 'model-id',
    description: 'Default model within the selected provider',
  },
] as const);

export type AllowedConfigKey = (typeof PUBLIC_CONFIG_SETTINGS)[number]['key'];
export const ALLOWED_CONFIG_KEYS: readonly AllowedConfigKey[] = Object.freeze(
  PUBLIC_CONFIG_SETTINGS.map(({ key }) => key),
);

export function isOctocodeTheme(value: unknown): value is OctocodeThemeName {
  return typeof value === 'string' && (OCTOCODE_THEME_NAMES as readonly string[]).includes(value);
}

export function isAllowedConfigKey(key: string): key is AllowedConfigKey {
  return (ALLOWED_CONFIG_KEYS as readonly string[]).includes(key);
}

/** Parse a CLI string into the typed value consumed by the settings registry. */
export function parseConfigSettingValue(key: AllowedConfigKey, value: string): unknown {
  if (key === 'reducedMotion') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (key === 'compactionInputTokenThreshold') {
    return /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  }
  return value;
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
