/**
 * registerUniqueTool — shared helper used by all extension tool registrations.
 *
 * Native Octocode research tools (GitHub, local, LSP, npm) are no longer registered
 * as individual Pi tools. They are served via the bundled octocode MCP server through
 * MCPTool. This removes 13 tool definitions from the Pi tool palette, cutting per-turn
 * token cost. The catalog is pre-warmed at session_start via warmMcpCatalog() so the
 * <mcp_cached_catalog> block is populated before the agent's first turn.
 */
import { withOctocodeRender } from '../branding/renderers.js';
import type { ToolDefinition } from '../types.js';

// ─── Registration helper ─────────────────────────────────────────────────────

export function registerUniqueTool(
  pi: { registerTool?(def: ToolDefinition): void },
  registeredToolNames: Set<string>,
  toolDefinition: ToolDefinition,
): void {
  if (registeredToolNames.has(toolDefinition.name)) {
    throw new Error(
      `Octocode Pi extension tool name collision: ${toolDefinition.name}`,
    );
  }
  registeredToolNames.add(toolDefinition.name);
  pi.registerTool?.(withOctocodeRender(toolDefinition));
}
