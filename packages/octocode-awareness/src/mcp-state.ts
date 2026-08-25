/**
 * Published bridge for MCP enablement state.
 *
 * Awareness owns the zero-runtime-dependency SQLite package boundary; the
 * implementation remains in octocode-shared so the schema and precedence rules
 * have one source.
 */
export {
  MCP_GLOBAL_SCOPE,
  getMcpEnablement,
  listMcpOverrides,
  setMcpServerEnabled,
  setMcpToolEnabled,
  type McpServerOverride,
  type McpToolOverride,
} from '@octocodeai/octocode-shared/mcp-state';
export { openOctocodeDb } from '@octocodeai/octocode-shared/db';
