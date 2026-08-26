export { execCli,installHostHooks,isCliEntrypoint,runCli,type InstallHost } from './cli.js';
export {
bytesToEmbedding,cosineSimilarity,
embeddingToBytes,isEmbeddingEnabled,
resolveEmbedCommand,
runHostEmbedder,type HostEmbedding
} from './embed.js';
export {
checkLockConflicts,
extractHookTargetPaths,runPreEditLockGate,type HookHost,type LockConflict,type PreEditHookOptions,type PreEditHookResult
} from './hooks.js';
// The single shared command→library mapping. The CLI and embedding hosts both
// dispatch through this, so there is
// no second param-shaping layer that can drift from the parser.
export {
dispatchAwarenessCommand,type AwarenessCommandOutcome,type AwarenessCommandRequest
} from './dispatch.js';
// Machine-readable command contract — the source of truth hosts import to
// generate typed, discriminated tool schemas + CLI arg-vectors (see commands-spec.ts).
export {
AWARENESS_COMMANDS,
getCommandGroup,type CommandAction,type CommandGroup,type CommandParam,
type CommandParamType
} from './commands-spec.js';
export { defaultDbPath } from './coordination-shared.js';
export { EXTERNAL_AGENT_AWARENESS_PROMPT, formatExternalAgentCoordinationContext, getExternalAgentAwarenessGuide } from './external-policy.js';
export {
  readExternalAwarenessStatus,
  type ExternalAwarenessStatus,
  type ExternalAwarenessTaskActivity,
} from './external-status.js';
export {
  executeExternalMemoryAction,
  EXTERNAL_MEMORY_ACTIONS,
  EXTERNAL_MEMORY_RECALL_MODES,
  validateExternalMemoryParams,
  type ExternalMemoryAction,
  type ExternalMemoryParams,
  type ExternalMemoryRecallMode,
  type ExternalMemoryResult,
  type ExternalMemoryReviewCandidate,
} from './external-memory.js';
export {
  completeExternalPlanTask,
  finalizeExternalPlan,
  projectExternalPlan,
  type ObservedCheckReceipt,
  type ExternalPlanCompletionResult,
  type ExternalPlanProjectionInput,
  type ExternalPlanProjectionResult,
  type ExternalPlanProjectionStep,
  type ExternalPlanScope,
} from './external-plan.js';

// Coordination-entity types live once in @octocodeai/octocode-shared/entities.
// Imported for local use (method signatures, Row mappers below) and re-exported
// so Awareness's public type surface is unchanged.
export type { AgentRecord,AgentStatus,CheckAudit,CheckStatus,HandoffNote,LiteMessage,Lock,LockWaitResult,MemoryItem,Plan,PlanGraphResult,PlanStatus,PruneResult,SourceStep,Task,TaskStatus,WorkPresence } from '@octocodeai/octocode-shared/entities';
export { detectAgentHost,generateAgentName,type AgentHost } from './agent-naming.js';
export type { AwarenessOptions,AwarenessSchema } from './coordination-shared.js';
export { AwarenessStore, openAwarenessStore } from './open.js';
