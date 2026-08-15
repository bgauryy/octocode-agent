/**
 * Branding-layer theme constants and sync helpers.
 *
 * Reuses the constants and resolver already defined in ui-extras so there is
 * a single source of truth for theme names across the extension.
 */

import {
  OCTOCODE_THEME_DARK,
  OCTOCODE_THEME_LIGHT,
  resolveSystemThemeName,
  resolveSystemTheme,
  type OctocodeThemeName,
  type SystemThemeSignals,
} from '../ui-extras.js';

export {
  OCTOCODE_THEME_DARK,
  OCTOCODE_THEME_LIGHT,
  resolveSystemThemeName,
  resolveSystemTheme,
  type OctocodeThemeName,
  type SystemThemeSignals,
};

/** The default Octocode theme name (dark variant). */
export const DEFAULT_OCTOCODE_THEME = OCTOCODE_THEME_DARK;

/** The light Octocode theme name. */
export const LIGHT_OCTOCODE_THEME = OCTOCODE_THEME_LIGHT;

/**
 * Resolve the preferred Octocode theme from the current process environment.
 *
 * Reads `process.platform`, `APPLE_INTERFACE_STYLE` / `AppleInterfaceStyle`
 * (set by some launchers), and `COLORFGBG`. Returns `DEFAULT_OCTOCODE_THEME`
 * when the system appearance cannot be determined.
 */
export function resolvePreferredTheme(): OctocodeThemeName {
  const result = resolveSystemThemeName({
    platform: process.platform,
    appleInterfaceStyle: process.env['APPLE_INTERFACE_STYLE'] ?? process.env['AppleInterfaceStyle'],
    colorfgbg: process.env['COLORFGBG'],
  });
  return result ?? DEFAULT_OCTOCODE_THEME;
}
