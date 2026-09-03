/**
 * Legacy published subpath retained only for the Awareness-owned worker
 * lifecycle projection. Agent control state, paths, permissions, and MCP/skill
 * overrides are owned by `@octocodeai/octocode-shared` and are deliberately not
 * re-exported from Awareness.
 *
 * New consumers should import these lifecycle symbols from the package root.
 */
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
