/**
 * dynamic-catalog — a terse system-prompt projection of the agent's self-created
 * dynamic tools (callTool) and skills (callSkill).
 *
 * Why a projection and NOT a file watcher: both registries are read fresh from disk on
 * every access (no in-memory cache), and this addendum is rebuilt on every
 * `before_agent_start` (per turn). So any change — created via callTool/callSkill or
 * edited out-of-band — is reflected on the next turn automatically, with no watcher,
 * no cache, and no invalidation logic. The projection subsumes what a watcher would do.
 *
 * Token discipline: emits `''` when both registries are empty (the common case),
 * truncates descriptions, and caps the number of entries so a large registry can never
 * bloat the prompt — the agent can always `action:"list"` for the full set.
 */

import { listTools } from './dynamic-tools.js';
import { listSkills } from './dynamic-skills.js';

const MAX_ENTRIES_PER_KIND = 30;
const MAX_DESCRIPTION_CHARS = 100;

interface CatalogEntry {
  name: string;
  description: string;
  /** Usage count — most-used entries win when the cap trims the list. */
  uses: number;
}

function truncate(text: string): string {
  const oneLine = (text || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DESCRIPTION_CHARS ? `${oneLine.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : oneLine;
}

function renderSection(label: string, entries: CatalogEntry[]): string[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  const shown = sorted.slice(0, MAX_ENTRIES_PER_KIND);
  const lines = [`${label}:`, ...shown.map((e) => `- ${e.name}: ${truncate(e.description)}`)];
  if (sorted.length > shown.length) {
    lines.push(`- …and ${sorted.length - shown.length} more (call action:"list")`);
  }
  return lines;
}

/**
 * Build the `<dynamic_capabilities>` block, or `''` when there are no dynamic tools or
 * skills. Reads both registries live; safe to call every turn.
 */
export function getDynamicCapabilitiesAddendum(): string {
  let toolEntries: CatalogEntry[] = [];
  let skillEntries: CatalogEntry[] = [];
  try {
    toolEntries = listTools().map((t) => ({ name: t.name, description: t.description, uses: t.stats?.calls ?? 0 }));
  } catch {
    // A missing/corrupt tools registry must never break prompt assembly.
  }
  try {
    skillEntries = listSkills().map((s) => ({ name: s.name, description: s.description, uses: s.stats?.uses ?? 0 }));
  } catch {
    // Same for skills.
  }
  if (toolEntries.length === 0 && skillEntries.length === 0) return '';

  return [
    '<dynamic_capabilities>',
    'Self-created reusable capabilities available this session (via callTool / callSkill). ' +
      'Prefer reusing these by name before proposing new ones; call action:"list" for full schemas/steps.',
    ...renderSection('tools', toolEntries),
    ...renderSection('skills', skillEntries),
    '</dynamic_capabilities>',
  ].join('\n');
}
