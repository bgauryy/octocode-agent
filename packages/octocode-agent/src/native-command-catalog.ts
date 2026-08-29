export interface NativeSlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly help?: boolean;
}

/** One authority for command help, composer completion, and routing documentation. */
export const NATIVE_SLASH_COMMANDS: readonly NativeSlashCommand[] = Object.freeze([
  { name: 'cancel', usage: '/cancel', description: 'Cancel the active interaction or turn.' },
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
]);

export function nativeCommandHelpItems(): readonly string[] {
  return NATIVE_SLASH_COMMANDS
    .filter(({ help }) => help !== false)
    .map(({ usage, description }) => `${usage} — ${description}`);
}
