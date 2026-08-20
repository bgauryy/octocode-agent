/**
 * Public entry point for the Octocode TUI shell (Phase C alpha).
 *
 * The launcher package calls `createOctocodeShell(runtime, deps).run()` behind
 * the `OCTOCODE_SHELL=1` env flag, falling back to Pi's InteractiveMode when the
 * flag is unset or the shell throws. See docs/SHELL.md.
 */

export { createOctocodeShell } from './shell.js';
export type {
  OctocodeShell,
  OctocodeShellDeps,
  ShellPromptOptions,
  ShellRuntime,
  ShellSession,
  ShellSessionEvent,
  ShellUi,
} from './shell.js';
