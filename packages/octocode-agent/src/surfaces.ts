/**
 * Octocode "surface" verbs — thin, honest wrappers over the bundled Awareness CLI
 * and the external `octocode` CLI. The launcher owns no research/coordination logic;
 * these verbs just build the right command line and forward args + exit code.
 *
 *   memory / awareness → bundled  node <pi-extension>/dist/awareness/octocode-awareness.js
 *   research / tools / skills → external  npx octocode <search|tools|skill>
 *
 * No side effects at import (safe to unit-test).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

const CORE_PACKAGE = '@octocodeai/pi-extension';

/** A command to spawn, or an actionable error explaining why it could not be built. */
export type SurfaceSpec = { cmd: string; args: string[] } | { error: string };

/** Resolve the installed pi-extension package root (or null). Mirrors launcher.resolvePackageJson. */
function resolveCoreRoot(): string | null {
  try {
    return path.dirname(_require.resolve(`${CORE_PACKAGE}/package.json`));
  } catch {
    /* exports-gated — scan the resolve chain */
  }
  const segments = CORE_PACKAGE.split('/');
  for (const base of _require.resolve.paths(CORE_PACKAGE) ?? []) {
    const pj = path.join(base, ...segments, 'package.json');
    if (fs.existsSync(pj)) return path.dirname(pj);
  }
  return null;
}

/**
 * Resolve the bundled Awareness CLI path.
 * Precedence: OCTOCODE_AWARENESS_CLI env → installed pi-extension dist → null.
 */
export function resolveAwarenessCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.OCTOCODE_AWARENESS_CLI;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const root = resolveCoreRoot();
  if (!root) return null;
  const bundled = path.join(root, 'dist', 'awareness', 'octocode-awareness.js');
  return fs.existsSync(bundled) ? bundled : null;
}

/** The launcher surface verbs. */
export type SurfaceVerb = 'research' | 'memory' | 'awareness' | 'tools' | 'skills';

/**
 * Build the spawn spec for a surface verb.
 * `rest` is the user's trailing args (already stripped of the verb token).
 */
export function buildSurfaceSpec(
  verb: SurfaceVerb,
  rest: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): SurfaceSpec {
  switch (verb) {
    case 'memory':
    case 'awareness': {
      const cli = resolveAwarenessCli(env);
      if (!cli) {
        return {
          error:
            'Awareness CLI not found. Install/refresh the core: octocode-agent update core',
        };
      }
      // `memory` is a noun of the awareness CLI; `awareness` passes through raw.
      const prefix = verb === 'memory' ? ['memory'] : [];
      return { cmd: 'node', args: [cli, ...prefix, ...rest] };
    }
    case 'research':
      return { cmd: 'npx', args: ['octocode', 'search', ...rest] };
    case 'tools':
      return { cmd: 'npx', args: ['octocode', 'tools', ...rest] };
    case 'skills':
      return { cmd: 'npx', args: ['octocode', 'skill', ...rest] };
    default: {
      const _exhaustive: never = verb;
      return { error: `Unknown surface verb: ${String(_exhaustive)}` };
    }
  }
}

// ── Profiles ────────────────────────────────────────────────────────────────────

/** A named preset: model + permission + tool scoping, applied as Pi flags at launch. */
export interface Profile {
  model?: string;
  tools?: string;
  excludeTools?: string;
  /** 'always' → non-interactive trust (-a); 'never' → -na; 'ask' → no flag. */
  approve?: 'always' | 'never' | 'ask';
}

/** Load a named profile from <home>/profiles.json, or null when absent/invalid. */
export function loadProfile(name: string, home: string): Profile | null {
  const file = path.join(home, 'profiles.json');
  if (!fs.existsSync(file)) return null;
  try {
    const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Profile>;
    return all[name] ?? null;
  } catch {
    return null;
  }
}

/** Translate a profile into Pi CLI flags (order-stable). */
export function profileToPiArgs(profile: Profile): string[] {
  const args: string[] = [];
  if (profile.model) args.push('--model', profile.model);
  if (profile.tools) args.push('--tools', profile.tools);
  if (profile.excludeTools) args.push('--exclude-tools', profile.excludeTools);
  if (profile.approve === 'always') args.push('-a');
  else if (profile.approve === 'never') args.push('-na');
  return args;
}
