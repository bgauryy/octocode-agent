/**
 * Shared pure utilities — no side effects at import time.
 */

import os from 'node:os';
import path from 'node:path';

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
 * Precedence: OCTOCODE_AGENT_DIR › OCTOCODE_HOME › ~/.octocode
 *
 * Single source of truth — used by both launcher and sdk-launcher.
 */
export function getOctocodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOCODE_AGENT_DIR ?? env.OCTOCODE_HOME ?? path.join(os.homedir(), '.octocode');
}

/** Return the names of API keys that are set in `env`. */
export function presentApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return API_KEY_NAMES.filter((k) => Boolean(env[k]));
}
