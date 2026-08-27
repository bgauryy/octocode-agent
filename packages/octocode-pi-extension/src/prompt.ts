import { SYSTEM_PROMPT_MARKER, MANAGED_BLOCK_START, MANAGED_BLOCK_END } from './constants.js';
import type { PromptMode } from './types.js';

export function shouldAppendSystemPrompt(
  systemPrompt: string,
  octocodePrompt: string,
): boolean {
  if (octocodePrompt.trim().length === 0) return false;
  // Rely solely on the unique marker rather than a content probe slice.
  // A probe-slice false-negative would silently skip the append when Pi's own
  // system prompt happens to share the same boilerplate prefix as the Octocode
  // prompt (e.g. the same authority/safety preamble).
  return !systemPrompt.includes(SYSTEM_PROMPT_MARKER);
}

export function renderSystemPromptAddendum(octocodePrompt: string): string {
  return `${SYSTEM_PROMPT_MARKER}\n${octocodePrompt.trim()}\n${SYSTEM_PROMPT_MARKER}`;
}

export function renderManagedAppendSystem(octocodePrompt: string): string {
  return `${MANAGED_BLOCK_START}\n${octocodePrompt.trim()}\n${MANAGED_BLOCK_END}\n`;
}

export function mergeManagedAppendSystem(
  existingContent: string,
  octocodePrompt: string,
): string {
  const block = renderManagedAppendSystem(octocodePrompt);
  const startIndex = existingContent.indexOf(MANAGED_BLOCK_START);
  const endIndex = existingContent.indexOf(MANAGED_BLOCK_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Well-formed block → replace it in place.
    const afterEnd = endIndex + MANAGED_BLOCK_END.length;
    return `${existingContent.slice(0, startIndex)}${block}${existingContent.slice(afterEnd).replace(/^\n+/, '')}`;
  }

  // A dangling/corrupted managed block (START without a valid END after it, or an
  // orphaned END) must not accumulate: drop everything from the first marker of a
  // broken pair onward, then append one fresh block. Without this, every write
  // would leave the old half-block and stack a new one below it.
  const brokenAt = startIndex !== -1 ? startIndex : endIndex;
  const base = brokenAt !== -1 ? existingContent.slice(0, brokenAt) : existingContent;
  const prefix = base.trimEnd();
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

/**
 * Resolve the harness prompt mode.
 * Precedence: explicit option > OCTOCODE_PROMPT_MODE env > 'append'.
 */
export function resolvePromptMode(option?: string): PromptMode {
  if (option === 'append' || option === 'octocode-first') return option;
  const envMode = process.env['OCTOCODE_PROMPT_MODE'];
  if (envMode === 'octocode-first') return 'octocode-first';
  return 'append';
}

/**
 * Build the system prompt the extension hands back to Pi.
 * - append (default): Pi's prompt, then the Octocode harness addendum.
 * - octocode-first: the Octocode harness leads, with Pi's prompt preserved below.
 */
/**
 * Remove Pi's `<project_context>` block (AGENTS.md / CLAUDE.md content) from an
 * already-built Pi system prompt. Pi assembles the prompt BEFORE
 * `before_agent_start` fires, so suppressing context files can only happen by
 * stripping the block from `event.systemPrompt` — mutating
 * `systemPromptOptions.contextFiles` in the hook has no effect.
 */
export function stripProjectContext(piSystemPrompt: string): string {
  return piSystemPrompt.replace(/\n*<project_context>[\s\S]*?<\/project_context>\n?/g, '\n');
}

/**
 * Remove Pi's own skills section from an already-built Pi system prompt.
 * Octocode owns the model-facing skill flow (the `skill` tool + the
 * `<available_skills>` addendum): Pi's section instructs the model to use the
 * `read` builtin (removed by Octocode) and duplicates the same
 * `<available_skills>` tag. Pi normally omits it when `read` is inactive, but
 * that is a side effect of tool selection — stripping here makes the disable
 * deterministic regardless of tool-set timing.
 */
export function stripPiSkillsSection(piSystemPrompt: string): string {
  return piSystemPrompt.replace(
    /\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>\n?/g,
    '\n',
  );
}

export function composeSystemPrompt(opts: {
  piSystemPrompt: string;
  octocodePrompt: string;
  promptMode: PromptMode;
}): string {
  const addendum = renderSystemPromptAddendum(opts.octocodePrompt);
  if (opts.promptMode === 'octocode-first') {
    return `${addendum}\n\n${opts.piSystemPrompt}`;
  }
  return `${opts.piSystemPrompt}\n\n${addendum}`;
}
