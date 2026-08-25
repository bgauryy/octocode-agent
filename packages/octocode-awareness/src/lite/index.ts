export { execCli,installHostHooks,isCliEntrypoint,runCli,type InstallHost } from './cli.js';
export {
bytesToEmbedding,cosineSimilarity,
embeddingToBytes,isEmbeddingEnabled,
resolveEmbedCommand,
runHostEmbedder,type HostEmbedding
} from './embed.js';
export {
checkLiteLockConflicts,
extractHookTargetPaths,runPreEditLockGate,type HookHost,type LockConflict,type PreEditHookOptions,type PreEditHookResult
} from './hooks.js';
// The single shared command→library mapping. The CLI and embedding hosts (e.g.
// the Pi extension's first-class tools) both dispatch through this, so there is
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

// Coordination-entity types live once in @octocodeai/octocode-shared/entities.
// Imported for local use (method signatures, Row mappers below) and re-exported
// so Lite's public type surface is unchanged.
export type { AgentRecord,AgentStatus,CheckAudit,CheckStatus,HandoffNote,LiteMessage,Lock,LockWaitResult,MemoryItem,Plan,PlanGraphResult,PlanStatus,PruneResult,SourceStep,Task,TaskStatus,WorkPresence } from '@octocodeai/octocode-shared/entities';
export { detectAgentHost,generateAgentName,type AgentHost } from './agent-naming.js';
export type { AwarenessLiteOptions,LiteSchema } from './lite-shared.js';
import { LiteMigration } from './lite-migration.js';
import type { AwarenessLiteOptions } from './lite-shared.js';
export class AwarenessLite extends LiteMigration {}
export function openAwarenessLite(options: AwarenessLiteOptions = {}): AwarenessLite {
  return new AwarenessLite(options);
}
