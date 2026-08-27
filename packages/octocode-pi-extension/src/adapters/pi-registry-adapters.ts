import {
  sessionId,
  toolCallId,
  type CommandContext,
  type CommandDefinition as CoreCommandDefinition,
  type CommandRegistry,
  type CommandResult,
  type ExecutionContext,
  type ToolDefinition as CoreToolDefinition,
  type ToolExecutionInput,
  type ToolRegistry,
  type ToolResult,
} from '@octocodeai/agent-core';
import type { PiCommandContext, PiContext, PiInstance, ToolCallResult } from '../types.js';

function mode(ctx: PiContext | undefined): ExecutionContext['mode'] {
  return ctx?.mode === 'tui' ? 'interactive' : ctx?.mode ?? 'headless';
}

async function executionContext(ctx: PiContext | undefined, signal: AbortSignal): Promise<ExecutionContext> {
  let trusted: boolean | undefined;
  try { trusted = ctx?.isProjectTrusted ? await ctx.isProjectTrusted() : undefined; } catch { trusted = undefined; }
  const cwd = ctx?.cwd ?? process.cwd();
  const workspace: ExecutionContext['trust']['workspace'] = trusted === undefined ? 'unknown' : trusted ? 'trusted' : 'untrusted';
  const context: ExecutionContext = {
    sessionId: sessionId(ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? `pi:${cwd}`),
    cwd,
    mode: mode(ctx),
    trust: { workspace, managedOnly: false },
    signal,
  };
  return Object.freeze(context);
}

function piContent(result: ToolResult): ToolCallResult {
  const content = Array.isArray(result.content)
    ? result.content
    : [{ type: 'text' as const, text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }];
  return { content: content as ToolCallResult['content'], isError: !result.ok, details: { version: result.detailsVersion, category: result.category } };
}

export type CanonicalToolDispatch = (name: string, input: ToolExecutionInput) => Promise<ToolResult>;

export class PiToolRegistryAdapter {
  constructor(
    private readonly pi: PiInstance,
    private readonly registry: ToolRegistry,
    private readonly dispatch: CanonicalToolDispatch,
  ) {}

  register(definition: CoreToolDefinition, owner: string): void {
    this.registry.register(definition, owner);
    this.pi.registerTool?.({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.inputSchema,
      execute: async (callId, params, signal, onUpdate, ctx) => {
        const controller = signal ? undefined : new AbortController();
        const activeSignal = signal ?? controller!.signal;
        const input: ToolExecutionInput = {
          input: params,
          callId: toolCallId(callId),
          context: await executionContext(ctx, activeSignal),
          signal: activeSignal,
          update: async (update) => {
            if (typeof onUpdate === 'function') await onUpdate(update);
          },
        };
        return piContent(await this.dispatch(definition.name, input));
      },
    });
  }
}

const COMMAND_CAPABILITIES = new Set<CommandContext['capabilities'] extends ReadonlySet<infer T> ? T : never>([
  'session.read', 'session.mutate', 'model.select', 'settings.read', 'ui.interact',
]);

export type CanonicalCommandDispatch = (name: string, args: readonly string[], context: CommandContext) => Promise<CommandResult>;

export class PiCommandRegistryAdapter {
  constructor(
    private readonly pi: PiInstance,
    private readonly registry: CommandRegistry,
    private readonly dispatch: CanonicalCommandDispatch,
  ) {}

  register(definition: CoreCommandDefinition, owner: string): void {
    this.registry.register(definition, owner);
    this.pi.registerCommand?.(definition.name, {
      description: definition.description,
      handler: async (rawArgs: string, ctx: PiCommandContext) => {
        const signal = new AbortController().signal;
        const base = await executionContext(ctx, signal);
        const context: CommandContext = Object.freeze({ ...base, capabilities: COMMAND_CAPABILITIES });
        await this.dispatch(definition.name, rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [], context);
      },
      ...(definition.complete ? {
        getArgumentCompletions: async (prefix: string) => {
          const signal = new AbortController().signal;
          const context: CommandContext = Object.freeze({
            ...await executionContext(undefined, signal),
            capabilities: COMMAND_CAPABILITIES,
          });
          return (await definition.complete!(prefix, context)).map((value) => ({ value, label: value }));
        },
      } : {}),
    });
  }
}
