import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_CONFIG_KEYS,
  DEFAULT_OCTOCODE_THEME,
  ensureDefaultSetting,
  ensureOctocodeThemeSetting,
  isAllowedConfigKey,
  isOctocodeTheme,
  listSettings,
  parseConfigSettingValue,
  readSettings,
} from '../src/settings.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-settings-'));
}

describe('ensureDefaultSetting', () => {
  it('writes the default when the key is absent', () => {
    const dir = tmpDir();
    expect(ensureDefaultSetting(dir, 'theme', DEFAULT_OCTOCODE_THEME)).toBe(true);
    expect(readSettings(dir)['theme']).toBe('octocode-dark');
  });

  it('never clobbers an existing user choice', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    expect(ensureDefaultSetting(dir, 'theme', DEFAULT_OCTOCODE_THEME)).toBe(false);
    expect(readSettings(dir)['theme']).toBe('dark');
  });

  it('preserves unrelated settings when writing', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ defaultModel: 'x' }));
    ensureDefaultSetting(dir, 'theme', DEFAULT_OCTOCODE_THEME);
    expect(readSettings(dir)).toEqual({ defaultModel: 'x', theme: 'octocode-dark' });
  });
});

describe('ensureOctocodeThemeSetting', () => {
  it('writes octocode-dark when theme is absent', () => {
    const dir = tmpDir();
    expect(ensureOctocodeThemeSetting(dir)).toBe(true);
    expect(readSettings(dir)['theme']).toBe(DEFAULT_OCTOCODE_THEME);
  });

  it('replaces plain themes with octocode-dark', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', defaultModel: 'x' }));
    expect(ensureOctocodeThemeSetting(dir)).toBe(true);
    expect(readSettings(dir)).toEqual({ theme: DEFAULT_OCTOCODE_THEME, defaultModel: 'x' });
  });

  it('preserves explicit Octocode theme choices', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'octocode-light' }));
    expect(ensureOctocodeThemeSetting(dir)).toBe(false);
    expect(readSettings(dir)['theme']).toBe('octocode-light');
  });

  it('recognizes only Octocode themes', () => {
    expect(isOctocodeTheme('octocode-dark')).toBe(true);
    expect(isOctocodeTheme('octocode-light')).toBe(true);
    expect(isOctocodeTheme('dark')).toBe(false);
  });
});

describe('config key allowlist', () => {
  it('matches every public native setting', () => {
    expect(ALLOWED_CONFIG_KEYS).toEqual([
      'theme',
      'reducedMotion',
      'compactionInputTokenThreshold',
      'defaultProvider',
      'defaultModel',
    ]);
    for (const key of ALLOWED_CONFIG_KEYS) expect(isAllowedConfigKey(key)).toBe(true);
  });

  it('still rejects non-contract keys', () => {
    expect(isAllowedConfigKey('quietStartup')).toBe(false);
    expect(isAllowedConfigKey('anything')).toBe(false);
  });

  it('projects only public allowlisted keys for config diagnostics', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      theme: 'octocode-dark',
      reducedMotion: false,
      compactionInputTokenThreshold: 80_000,
      defaultModel: 'gpt-5.6',
      apiKey: 'must-never-render',
      arbitrary: { nested: true },
    }));

    expect(listSettings(dir)).toEqual({
      theme: 'octocode-dark',
      reducedMotion: false,
      compactionInputTokenThreshold: 80_000,
      defaultModel: 'gpt-5.6',
    });
    expect(readSettings(dir)).toMatchObject({ apiKey: 'must-never-render', arbitrary: { nested: true } });
  });

  it('parses boolean and integer CLI values for the typed registry', () => {
    expect(parseConfigSettingValue('reducedMotion', 'true')).toBe(true);
    expect(parseConfigSettingValue('reducedMotion', 'false')).toBe(false);
    expect(parseConfigSettingValue('reducedMotion', 'yes')).toBe('yes');
    expect(parseConfigSettingValue('compactionInputTokenThreshold', '64000')).toBe(64_000);
    expect(parseConfigSettingValue('compactionInputTokenThreshold', '64k')).toBe('64k');
    expect(parseConfigSettingValue('theme', 'octocode-light')).toBe('octocode-light');
  });
});
