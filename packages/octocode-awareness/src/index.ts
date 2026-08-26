/**
 * @octocodeai/octocode-awareness — public module API.
 *
 * Import directly — no subprocess required:
 *   import { getMemory, insertMemory, reflect } from '@octocodeai/octocode-awareness';
 */

// DB layer
export {
  AWARENESS_APPLICATION_ID,
  connectDb, connectCachedDb, initDb, memoryHome, resolveDbPath, hasFts, tableColumns,
  replaceMemoryReferences, referenceKind, evictExpiredLocks, checkpointWal,
  getDeliveryFingerprint, setDeliveryFingerprint,
} from './db.js';
export type { DeliveryFingerprintKey } from './db.js';

// Memory operations
export { insertMemory, insertMemoryWithSimilarityGate, getMemory, bumpAccess, lexicalSearch, decayScore, findSimilarMemories, mineWeakness, forgetMemory, storeEmbedding, searchByEmbedding, loadMemoriesByIds } from './memory.js';
export type { GuardedMemoryInsertResult, MineWeaknessResult, MineWeaknessParams, WeaknessCluster } from './memory.js';
export { resolveEmbedCommand, runHostEmbedder } from './embed-host.js';
export type { HostEmbedding } from './embed-host.js';

// Refinements
export { insertRefinement, updateRefinement, getRefinements, deleteRefinement } from './refinements.js';
export type { DeleteRefinementResult, UpdateRefinementResult } from './refinements.js';

// Intents / file locks
export { preFlightIntent, releaseFileLock, fileLock } from './intents.js';

// Advisory file presence + optional sensitive exclusivity
export { startWork, touchWork, endWork, listWork, showWork } from './work.js';

// Collaborative plans and durable plan tasks
export { createPlan, getPlan, listPlans, joinPlan, registerPlanDocument, updatePlanStatus } from './plans.js';
export type { PlanStatus, PlanRecord, PlanDetail, PlanMemberRecord, PlanDocRecord, CreatePlanParams, JoinPlanParams, RegisterPlanDocParams } from './plans.js';
export {
  createTask, getTask, listTasks, listReadyTasks, activeTaskClaimForAgent, addTaskDependency,
  claimTask, heartbeatTaskClaim, submitTask, releaseTaskClaim,
} from './tasks.js';
export type { PlanTaskStatus, PlanTaskRecord, TaskClaimRecord, TaskRunRecord, CreateTaskParams, ClaimTaskResult } from './tasks.js';

// Reflection
export { reflect } from './reflect.js';

// Background operations + smart briefing + harness export
export { pruneStale, notifyGet, sessionCapture, waitForLock, digest, inspectMaintenancePressure, getWorkspaceStatus, exportMemoryDoc, exportHarness } from './maintenance.js';
export type { DigestResult, MaintenancePressure, BriefItem, NotifyGetResult, NotifyGetBriefResult, WorkspaceStatusResult, WorkspaceLockEntry, WaitForLockResult, PruneStaleResult } from './maintenance.js';

// Repo-readable awareness projections
export {
  AWARENESS_QUERY_VIEWS,
  queryAwareness,
  formatAwarenessQueryResult,
  renderAwarenessHtml,
  writeAwarenessView,
} from './repo-context.js';
export type {
  AwarenessQueryFormat,
  AwarenessQueryParams,
  AwarenessQueryResult,
  AwarenessQueryRow,
  AwarenessQuerySection,
  AwarenessQueryView,
  RepoContextInjectParams,
  RepoContextInjectResult,
  RepoContextMode,
} from './repo-context.js';

// Agent-native start packet
export { attendAwareness } from './attend.js';
export type { AttendEvidence, AttendParams, AttendResult } from './attend.js';

// Notifications
export { insertNotification, getNotifications, resolveNotification, pruneNotifications, agentSignal } from './notifications.js';

// Verify gate
export { auditUnverified, markVerified } from './verify.js';
export type {
  AuditUnverifiedResult, AuditUnverifiedParams, UnverifiedIntent, StaleActiveIntent,
  MarkVerifiedResult, MarkVerifiedOk, MarkVerifiedErr, MarkVerifiedParams, VerifyStatus,
} from './verify.js';

// Agent identity registry (ARCH-5)
export { registerAgent, touchAgent, resolveAgentName, resolveAgentNames, listAgents } from './agents.js';

// Pure helpers
export {
  utcNow, parseJsonList, normalizeTags, normalizeReferences,
  normalizeLabel, normalizeNotificationKind, normalizeReflectionOutcome, normalizeFilePath, tagsText, rowToMemory,
  MEMORY_LABELS, MEMORY_LABEL_VALUES, NOTIFICATION_KIND_VALUES, NOTIFICATION_KINDS,
  REFLECTION_OUTCOME_VALUES, REFLECTION_IMPORTANCE,
} from './helpers.js';

// Shared agent-tool operation runner
export { runAwarenessToolOperation } from './tool-operations.js';
export type {
  AwarenessToolOperation,
  AwarenessToolOperationContext,
  AwarenessToolOperationResult,
} from './tool-operations.js';

// Git scope
export { detectGit, fillScope, canonicalizePath, normalizeWorkspacePath } from './git.js';

// Audit log (edit_log + harness_log)
export { sha256Hex, insertEditLog, queryEditLog, insertHarnessLog, queryHarnessLog } from './audit.js';

// Doc staleness detection (edit_log-derived — no new tables)
export { mineDocStaleness, proposeDocRefresh } from './docs.js';

// Skill reference catalog (docs list|show)
export { listSkillDocs, showSkillDoc } from './docs-catalog.js';
export type { DocCatalogEntry, DocCatalogListResult, DocCatalogShowResult } from './docs-catalog.js';

// Sessions
export { insertSession, endSession, getSession, listSessions, getOrCreateSession } from './sessions.js';

// Types
export type {
  AgentIdentity, RegisterAgentParams, ListAgentsResult, EmbeddingSearchResult,
  MemoryRecord, RefinementRecord, FileLock,
  InsertMemoryParams, InsertMemoryResult,
  GetMemoryParams, GetMemoryResult,
  InsertRefinementParams, InsertRefinementResult,
  GetRefinementsParams, GetRefinementsResult,
  PreFlightRunParams, PreFlightRunResult, PreFlightRunSuccess, PreFlightRunConflict,
  ReleaseFileLockParams, ReleaseFileLockResult, FileLockParams, FileLockResult, FileLockStatusEntry, SimpleFileLock,
  ReflectParams, ReflectResult,
  Scope, ScopePartial,
  MemoryState, LockType, RunStatus, RunOrigin, WorkSource,
  RefinementQuality, RefinementState, ReflectionOutcome,
  StartWorkParams, StartWorkResult, TouchWorkParams, EndWorkParams,
  WorkMutationResult, ListWorkParams, ListWorkResult,
  WorkRunRecord, WorkFileRecord, WorkPresence, WorkPeer, WorkConflict,
  // New types
  ForgetMemoryParams, ForgetMemoryResult,
  WaitForLockParams,
  PruneStaleParams,
  DeleteRefinementParams,
  InsertNotificationParams, InsertNotificationResult,
  GetNotificationsParams, GetNotificationsResult,
  ResolveNotificationParams, ResolveNotificationResult,
  PruneNotificationsParams, PruneNotificationsResult,
  AgentSignalAction, AgentSignalParams, AgentSignalRecord, AgentSignalResult,
  NotificationRecord, NotificationKind, NotificationStatus,
  ExportHarnessParams, ExportHarnessResult,
  MemoryReferenceRow,
  DocStalenessTarget, DocStalenessParams, DocStalenessEntry, DocStalenessResult,
  ProposeDocRefreshParams,
  InsertSessionParams, EndSessionParams, SessionRow,
} from './types.js';

// Agent-neutral shared coordination surface. Public consumers import the package
// root; the implementation directory is not a separate product or API tier.
export {
  AwarenessStore,
  openAwarenessStore as openAwareness,
  execCli,
  runCli,
  dispatchAwarenessCommand,
  AWARENESS_COMMANDS,
  getCommandGroup,
  defaultDbPath,
  runPreEditLockGate,
  checkLockConflicts,
  extractHookTargetPaths,
  installHostHooks,
  EXTERNAL_AGENT_AWARENESS_PROMPT,
  getExternalAgentAwarenessGuide,
  formatExternalAgentCoordinationContext,
  readExternalAwarenessStatus,
  executeExternalMemoryAction,
  EXTERNAL_MEMORY_ACTIONS,
  EXTERNAL_MEMORY_RECALL_MODES,
  validateExternalMemoryParams,
  completeExternalPlanTask,
  finalizeExternalPlan,
  projectExternalPlan,
  detectAgentHost,
  generateAgentName,
} from './coordination/index.js';
export type {
  AwarenessCommandOutcome,
  AwarenessCommandRequest,
  CommandAction,
  CommandGroup,
  CommandParam,
  CommandParamType,
  HookHost,
  InstallHost,
  LockConflict,
  PreEditHookOptions,
  PreEditHookResult,
  ExternalAwarenessStatus,
  ExternalAwarenessTaskActivity,
  ExternalMemoryAction,
  ExternalMemoryParams,
  ExternalMemoryRecallMode,
  ExternalMemoryResult,
  ExternalMemoryReviewCandidate,
  ObservedCheckReceipt,
  ExternalPlanCompletionResult,
  ExternalPlanProjectionInput,
  ExternalPlanProjectionResult,
  ExternalPlanProjectionStep,
  ExternalPlanScope,
  AgentHost,
} from './coordination/index.js';
