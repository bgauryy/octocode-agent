export const PACKAGE_NAME = '@octocodeai/pi-extension';
export const SYSTEM_PROMPT_MARKER = '<!-- octocode-pi-extension:system-prompt -->';
export const MANAGED_BLOCK_START = '<!-- OCTOCODE_PI_EXTENSION_APPEND_SYSTEM_START -->';
export const MANAGED_BLOCK_END = '<!-- OCTOCODE_PI_EXTENSION_APPEND_SYSTEM_END -->';

// Research tools (GitHub, local, LSP, npm) are served via MCPTool → octocode MCP server.
// They are NOT registered as native Pi tools. See mcp-tool.ts DEFAULT_OCTOCODE_MCP_SERVER.

// Replaced by Octocode MCPTool-backed equivalents: localGetFileContent, localSearchCode, localFindFiles, localViewStructure
export const DISABLED_BUILTIN_TOOL_NAMES = ['read', 'grep', 'find', 'ls'] as const;

// Same-name registerTool overrides (Pi keeps the name; Octocode owns the implementation).
export const OVERRIDDEN_BUILTIN_TOOL_NAMES = ['edit', 'write', 'bash'] as const;

// Support tools: typed subagent orchestration, web, and browser surfaces.
export const OCTOCODE_SUPPORT_TOOL_NAMES = [
  'web',
  'chromeDebug',
  'browserAgent',
  'spawnSubagent',
  'MCPTool',
  'mcp',
  'askUser',
  'memory',
  'manage_context',
  'spawnAgent',
  'AgentMessage',
] as const;
