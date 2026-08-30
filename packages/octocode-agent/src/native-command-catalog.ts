export interface NativeSlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly help?: boolean;
}

export type PiCommandParityStatus = 'MATCH' | 'ALIAS' | 'BLOCKED';

export interface PiCommandParityRow {
  readonly piName: string;
  readonly status: PiCommandParityStatus;
  readonly nativeOwner?: string;
  readonly reason: string;
}

export const PI_COMMAND_PARITY: readonly PiCommandParityRow[] = Object.freeze([
  { piName: 'commands', status: 'ALIAS', nativeOwner: 'help', reason: 'Both render the canonical command guide.' },
  { piName: 'octocode', status: 'BLOCKED', reason: 'Pi octocode reports extension health and setup; native status reports runtime state.' },
  { piName: 'octocode-harness', status: 'BLOCKED', reason: 'Native has no single prompt-overhead and live MCP catalog owner.' },
  { piName: 'octocode-now', status: 'BLOCKED', reason: 'Pi now includes permissions, shared tasks, agents, and git beyond native runtime status.' },
  { piName: 'octocode-tasks', status: 'BLOCKED', reason: 'Pi tasks includes Awareness verification beyond native plan presentation.' },
  { piName: 'octocode-skills', status: 'BLOCKED', reason: 'Pi skills includes load and install guidance beyond native Skill discovery.' },
  { piName: 'octocode-agents', status: 'BLOCKED', reason: 'Worker inbox and process controls have no slash-command owner.' },
  { piName: 'octocode-cron', status: 'BLOCKED', reason: 'Native runtime has no session cron scheduler.' },
  { piName: 'settings', status: 'MATCH', nativeOwner: 'settings', reason: 'Canonical local settings page.' },
  { piName: 'mcp', status: 'BLOCKED', reason: 'Pi MCP owns catalog, status, and lifecycle actions beyond native Connections settings.' },
  { piName: 'octocode-setup', status: 'BLOCKED', reason: 'Setup is a native CLI command, not an interactive runtime mutation.' },
  { piName: 'octocode-skills-update', status: 'BLOCKED', reason: 'Pi package update and reload has no native-session equivalent.' },
  { piName: 'octocode-plan', status: 'BLOCKED', reason: 'Pi plan owns lifecycle, review, mutation, and HTML actions beyond native plan presentation.' },
  { piName: 'octocode-theme', status: 'BLOCKED', reason: 'Pi theme applies sync, dark, or light immediately; native settings only opens appearance configuration.' },
  { piName: 'octocode-chrome', status: 'BLOCKED', reason: 'CDP connection reuse is Pi-host state.' },
  { piName: 'octocode-footer', status: 'BLOCKED', reason: 'Pi footer density has no native presentation contract.' },
  { piName: 'octocode-permissions', status: 'BLOCKED', reason: 'Pi approval levels do not map to native effect policy.' },
  { piName: 'octocode-profile', status: 'BLOCKED', reason: 'Pi live profiles can mutate tools and approval mode unavailable natively.' },
  { piName: 'octocode-inbox', status: 'BLOCKED', reason: 'Native worker transcript controls have no slash-command owner.' },
  { piName: 'octocode-palette', status: 'BLOCKED', reason: 'Pi palette is an interactive action picker; native help is a static guide.' },
  { piName: 'octocode-rewind', status: 'BLOCKED', reason: 'Pi automatic file checkpoints have no native owner.' },
  { piName: 'octocode-dial', status: 'BLOCKED', reason: 'Pi dial controls thinking and worker parallelism; native thinking controls model effort only.' },
  { piName: 'octocode-watch', status: 'BLOCKED', reason: 'AI-comment filesystem watch mode has no native owner.' },
  { piName: 'octocode-export', status: 'BLOCKED', reason: 'Pi HTML transcript branding has no native session exporter.' },
  { piName: 'octocode-cleanup', status: 'BLOCKED', reason: 'Destructive scratch cleanup remains an explicit management operation.' },
]);

export const PI_GENERIC_COMMAND_ADAPTER_HOLD = Object.freeze({
  status: 'HOLD' as const,
  concreteName: null,
  reason: 'PiCommandRegistryAdapter can register a caller-supplied name, but no production activation references it.',
});

const NATIVE_COMMAND_ALIASES = Object.freeze(new Map<string, { target: string; defaultArgs?: readonly string[] }>([
  ['commands', { target: 'help' }],
]));

export function nativeCommandAlias(name: string): { readonly target: string; readonly defaultArgs?: readonly string[] } | undefined {
  return NATIVE_COMMAND_ALIASES.get(name);
}

/** One authority for command help, composer completion, and routing documentation. */
export const NATIVE_SLASH_COMMANDS: readonly NativeSlashCommand[] = Object.freeze([
  { name: 'cancel', usage: '/cancel', description: 'Cancel the active interaction or turn.' },
  { name: 'clear', usage: '/clear', description: 'Clear conversation context and start a fresh session.' },
  { name: 'compact', usage: '/compact', description: 'Compact conversation context when supported.' },
  { name: 'exit', usage: '/exit', description: 'Exit the interactive agent.' },
  { name: 'help', usage: '/help', description: 'Show native interactive commands and shortcuts.' },
  { name: 'plan', usage: '/plan show', description: 'Show the current authoritative plan.' },
  { name: 'quit', usage: '/quit', description: 'Exit the interactive agent.', help: false },
  { name: 'settings', usage: '/settings [section]', description: 'Open the secure local configuration center.' },
  { name: 'skills', usage: '/skills', description: 'Show discovered Agent Skills.' },
  { name: 'status', usage: '/status', description: 'Show runtime, model, thinking, and token status.' },
  { name: 'steer', usage: '/steer <message>', description: 'Redirect the active turn before queued follow-ups.' },
  { name: 'thinking', usage: '/thinking <level>', description: 'Set model thinking when the adapter supports it.' },
  { name: 'tools', usage: '/tools', description: 'Show registered tools.' },
  { name: 'commands', usage: '/commands', description: 'Show native interactive commands and shortcuts.' },
]);

export function nativeCommandHelpItems(): readonly string[] {
  return NATIVE_SLASH_COMMANDS
    .filter(({ help }) => help !== false)
    .map(({ usage, description }) => `${usage} — ${description}`);
}
