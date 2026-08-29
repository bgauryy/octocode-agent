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
export { closeOctocodeDb } from '@octocodeai/octocode-shared/db';
export { octocodeDbPath } from '@octocodeai/octocode-shared/paths';
export { recordSession } from '@octocodeai/octocode-shared/schema';
export { ensurePrivateDirectory, hardenPrivateFile, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from '@octocodeai/octocode-shared/permissions';
export {
  appendWorkerLifecycleEvent,
  listWorkerLifecycleEvents,
  MAX_WORKER_LIFECYCLE_PAYLOAD_BYTES,
  MAX_WORKER_LIFECYCLE_REPLAY_LIMIT,
  type AppendWorkerLifecycleEventResult,
  type ListWorkerLifecycleEventsOptions,
  type StoredWorkerLifecycleEvent,
  type WorkerLifecycleEventInput,
  type WorkerLifecycleJsonValue,
  type WorkerLifecycleRedaction,
} from './worker-lifecycle-ledger.js';
