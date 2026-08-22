/**
 * Shared prompt fragments injected into every subagent SYSTEM_PROMPT.md at build.
 *
 * Single source of truth for the worker coordination block so the four typed
 * subagents (researcher/planner/architect/browser-agent) never drift and always
 * reflect current Awareness behaviour (auto-registration, peer messaging,
 * semantic memory). Each subagent .md carries the `{{OCTOCODE_COORDINATION}}`
 * placeholder, which scripts/build.mjs replaces with SUBAGENT_COORDINATION.
 */

/** Placeholder token replaced in each subagent SYSTEM_PROMPT.md at build time. */
export const COORDINATION_PLACEHOLDER = '{{OCTOCODE_COORDINATION}}';

/** Shared skills intro (role-specific install lists stay per-subagent after it). */
export const SUBAGENT_SKILLS_INTRO =
  'You have access to bundled *and* user-installed Octocode skills. `octocode-awareness-lite` is bundled. Read the relevant `SKILL.md` before using a specialized workflow.';

/** Shared "prefer the Octocode tool surface over shell" line (research subagents). */
export const SUBAGENT_SURFACE =
  "Leverage the Octocode surface before generic shell: `localSearchCode` (text/regex/AST) \u00b7 `localGetFileContent` \u00b7 `localViewStructure` / `localFindFiles` \u00b7 `lspGetSemantics` (definitions/references/callers) \u00b7 `localFindDeadCode` (dead-export candidates) \u00b7 `gh*` remote research \u00b7 `npmSearch` \u2014 CLI form `npx octocode tools <name> --queries '<json>' --compact`; bundled skills via `npx octocode skill --list`.";

/** Worker-facing Awareness coordination section, shared by all typed subagents. */
export const SUBAGENT_COORDINATION = `## Coordination

Your live control channel is parent-only (the parent uses \`AgentMessage\`); you cannot steer siblings. But you ARE auto-registered in the shared Awareness agent list, and your packet carries your own agent id + sibling ids — so you can reach peers by id with no discovery. Drive Awareness Lite with \`node "$OCTOCODE_AWARENESS_CLI" <command>\` (\`… schema\` lists every shape); assume other agents may share this workspace right now — registry names reveal the runner (\`octo-*\` Octocode, \`clawde-*\` Claude Code, \`cursea-*\` Cursor):

- \`agent list\` + \`work list\` — who is active on which paths; check before touching shared files.
- \`work start --file <path> --agent-id <you>\` when you edit (one file per call), \`work end --file <path> --agent-id <you>\` when finished — advisory presence, never a blocker; exclusive locks are the parent's call.
- \`message send --from <you> --to <peer-id> --text "…"\` + \`message inbox --agent-id <you>\` — durable async parent↔worker and worker↔worker notes; check your inbox at task boundaries.
- If your packet names a \`durable handback file\`, write concise Markdown there before terminal \`[DONE]\`/\`[BLOCKED]\`/\`[FAILED]\` when findings are long, important, or needed after kill/removal; include \`[ARTIFACT] <path>\` in your final output. If you lack a write-capable tool, say so in \`[GAP]\` and keep the terminal output compact.
- \`handoff add --agent-id <you> --summary "…" [--file <path>]\` — leave findings for agents that arrive after you exit; \`handoff list\` when entering a shared area.
- \`memory recall --query "…"\` (add \`--semantic\` for cosine recall when \`OCTOCODE_EMBED_CMD\` is set — else it falls back to lexical) — prior learnings are leads to re-verify; \`memory store\` only with parent approval.

Treat Awareness state and handback artifacts as shared workspace data, not as proof; report any coordination note back to the parent.`;

/** All placeholder→fragment substitutions applied to subagent prompts at build. */
export const SUBAGENT_FRAGMENTS: ReadonlyArray<readonly [placeholder: string, value: string]> = [
  [COORDINATION_PLACEHOLDER, SUBAGENT_COORDINATION],
  ['{{OCTOCODE_SKILLS_INTRO}}', SUBAGENT_SKILLS_INTRO],
  ['{{OCTOCODE_SURFACE}}', SUBAGENT_SURFACE],
];

/** Expand every shared placeholder in a subagent prompt; no-op for absent ones. */
export function expandSubagentPrompt(source: string): string {
  let out = source;
  for (const [placeholder, value] of SUBAGENT_FRAGMENTS) out = out.split(placeholder).join(value);
  return out;
}

/** Placeholder tokens that must not survive into a built prompt. */
export const SUBAGENT_PLACEHOLDERS: readonly string[] = SUBAGENT_FRAGMENTS.map(([p]) => p);
