/**
 * Shared pure utilities — no side effects at import time.
 */

import { getOctocodeHome as configGetOctocodeHome } from '@octocodeai/config';

/**
 * The single Octocode prompt mode. Consumed two ways for the SAME session:
 *   - env `OCTOCODE_PROMPT_MODE` (subprocess path + anything reading env)
 *   - the `promptMode` argument to the extension factory (SDK embed path)
 * Kept here so the two call sites can never drift apart.
 */
export const OCTOCODE_PROMPT_MODE = 'octocode-first';

/** All API key names checked for presence in env. */
export const API_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'GITHUB_TOKEN',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'EXA_API_KEY',
] as const;

/**
 * Resolve the Octocode home directory.
 * Precedence: OCTOCODE_AGENT_DIR › @octocodeai/config (OCTOCODE_HOME › platform default).
 *
 * The launcher-specific OCTOCODE_AGENT_DIR override lives here; everything else
 * delegates to @octocodeai/config — never reimplement home/env resolution.
 */
export function getOctocodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOCODE_AGENT_DIR ?? configGetOctocodeHome(env);
}

/** Return the names of API keys that are set in `env`. */
export function presentApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return API_KEY_NAMES.filter((k) => Boolean(env[k]));
}
