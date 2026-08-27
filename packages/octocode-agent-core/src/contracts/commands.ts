import type { ExecutionContext } from './tools.js';
export interface CommandContext extends ExecutionContext { readonly capabilities: ReadonlySet<'session.read' | 'session.mutate' | 'model.select' | 'settings.read' | 'ui.interact'>; }
export interface CommandResult { readonly status: 'ok' | 'cancelled' | 'unsupported'; readonly message?: string; readonly data?: unknown; }
export interface CommandDefinition { readonly name: string; readonly description: string; readonly permission: 'none' | 'trusted-workspace' | 'approval'; readonly headless: 'supported' | 'unsupported' | 'error'; complete?(prefix: string, context: CommandContext): Promise<readonly string[]>; execute(args: readonly string[], context: CommandContext): Promise<CommandResult>; }
