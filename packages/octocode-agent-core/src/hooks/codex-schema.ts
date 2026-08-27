import { RuntimeFailure } from '../contracts/errors.js';
import type { CodexHookConfiguration, HookHandlerDefinition, HookMatcherGroup } from '../contracts/hooks.js';
const SUPPORTED_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionStart', 'SessionEnd']);
const DEFAULT_TIMEOUT = 600; const DEFAULT_SESSION_END_TIMEOUT = 1; const MAX_SESSION_END_TIMEOUT = 3;
export const parseCodexHooks = (input: unknown): CodexHookConfiguration => {
  if (!record(input)) throw new RuntimeFailure('validation', 'Hook configuration must be an object');
  const source = record(input.hooks) ? input.hooks : input;
  const hooks: Record<string, readonly HookMatcherGroup[]> = {}; const unsupported: { event: string; definition: unknown }[] = [];
  for (const [event, rawGroups] of Object.entries(source)) {
    if (!SUPPORTED_EVENTS.has(event)) { unsupported.push({ event, definition: rawGroups }); continue; }
    if (!Array.isArray(rawGroups)) throw new RuntimeFailure('validation', `${event} must be an array`);
    hooks[event] = rawGroups.map((rawGroup, declarationOrder) => parseGroup(event, rawGroup, declarationOrder));
  }
  return { schemaVersion: 1, hooks, unsupported } as CodexHookConfiguration;
};
const parseGroup = (event: string, input: unknown, declarationOrder: number): HookMatcherGroup => {
  if (!record(input) || !Array.isArray(input.hooks)) throw new RuntimeFailure('validation', `${event} matcher group requires hooks`);
  const matcher = typeof input.matcher === 'string' ? input.matcher : undefined; if (matcher !== undefined) { try { new RegExp(matcher); } catch { throw new RuntimeFailure('validation', `Invalid matcher for ${event}`); } }
  return { ...(matcher === undefined ? {} : { matcher }), handlers: input.hooks.map((handler) => parseHandler(event, handler)), declarationOrder };
};
const parseHandler = (event: string, input: unknown): HookHandlerDefinition => {
  if (!record(input) || typeof input.type !== 'string') throw new RuntimeFailure('validation', 'Hook handler requires a type');
  const async = input.async === true; const timeoutValue = input.timeout; const timeout = typeof timeoutValue === 'number' ? timeoutValue : event === 'SessionEnd' ? DEFAULT_SESSION_END_TIMEOUT : DEFAULT_TIMEOUT;
  if (!Number.isFinite(timeout) || timeout <= 0 || (event === 'SessionEnd' && timeout > MAX_SESSION_END_TIMEOUT)) throw new RuntimeFailure('validation', `Invalid timeout for ${event}`);
  const statusMessage = input.statusMessage ?? input.status_message; const additionalContextLimit = input.additionalContextLimit ?? input.additional_context_limit;
  if (input.type === 'command') { const command = platformString(input.command); if (command === undefined) throw new RuntimeFailure('validation', 'Command hook requires command'); return { type: 'command', command, ...(platformString(input.commandWindows ?? input.command_windows) === undefined ? {} : { commandWindows: platformString(input.commandWindows ?? input.command_windows)! }), timeoutSeconds: timeout, ...(typeof statusMessage === 'string' ? { statusMessage } : {}), ...(typeof additionalContextLimit === 'number' ? { additionalContextLimit } : {}), async }; }
  if (input.type === 'mcp_tool') { if (typeof input.server !== 'string' || typeof input.tool !== 'string') throw new RuntimeFailure('validation', 'MCP hook requires server and tool'); return { type: 'mcp_tool', server: input.server, tool: input.tool, ...(input.input === undefined ? {} : { input: input.input }), timeoutSeconds: timeout, ...(typeof statusMessage === 'string' ? { statusMessage } : {}), async }; }
  return { type: 'unsupported', originalType: input.type, reason: 'Handler type is parsed but not executable', definition: input };
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const platformString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
