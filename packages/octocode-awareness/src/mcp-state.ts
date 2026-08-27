/**
 * Published bridge for runtime capability enablement state (MCP + skills).
 *
 * Awareness owns the zero-runtime-dependency SQLite package boundary; the
 * implementation remains in octocode-shared so the schema and precedence rules
 * have one source.
 */
export {
  MCP_GLOBAL_SCOPE,
  getMcpEnablement,
  getSkillEnablement,
  listMcpOverrides,
  listSkillOverrides,
  normalizeSkillKey,
  setMcpServerEnabled,
  setMcpToolEnabled,
  setSkillEnabled,
  type McpServerOverride,
  type McpToolOverride,
  type SkillOverride,
} from '@octocodeai/octocode-shared/mcp-state';
export { openOctocodeDb } from '@octocodeai/octocode-shared/db';
