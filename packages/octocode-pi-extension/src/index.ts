import fs from 'node:fs';
import path from 'node:path';
import { propagateOctocodeEnv, getOctocodeHome } from './env.js';
import {
  DISABLED_BUILTIN_TOOL_NAMES,
  OVERRIDDEN_BUILTIN_TOOL_NAMES,
  OCTOCODE_SUPPORT_TOOL_NAMES,
} from './constants.js';
import { keyText } from '@earendil-works/pi-coding-agent';
import { checkForCoreUpdate, readOwnVersion } from './core-update-check.js';
import {
  getAssetPaths,
  readTextIfExists,
  listBundledSkills,
  getInstallSource,
  getAwarenessCLIPath,
  buildAwarenessLiteCommand,
  resolveAwarenessLiteCliPath,
} from './assets.js';

// Expose the Awareness Lite CLI for agents. The env var holds the SCRIPT PATH
// ONLY so the documented `node "$OCTOCODE_AWARENESS_CLI" <command>` invocation
// works in every shell (a "node /path" two-token string breaks under quoting
// and under zsh's no-word-split default). Guarded: a broken/missing install
// must not throw at import time and kill the whole extension load.
try {
  process.env.OCTOCODE_AWARENESS_CLI = resolveAwarenessLiteCliPath();
} catch {
  // Awareness Lite unresolved — leave the env var unset; prompt/status
  // surfaces fall back to the npx form.
}
// Mark this process tree as the Octocode harness so generated agent names
// (workers here, `agent join` rows in Awareness Lite) tag as octo-* even when
// the session was launched from a Claude Code / Cursor terminal whose host
// env vars are inherited. Respect an explicit override.
process.env.OCTOCODE_AGENT_HOST ||= 'octo';
import {
  shouldAppendSystemPrompt,
  mergeManagedAppendSystem,
  resolvePromptMode,
  composeSystemPrompt,
  stripProjectContext,
  stripPiSkillsSection,
} from './prompt.js';
import { registerSkillTool, discoverSkills, formatSkillUsageLines } from './tools/skill-tool.js';
import { writeDiscoveryFile, getDiscoveryFilePath } from './tools/discovery-file.js';
import {
  parseSetupScope,
  getAppendSystemTarget,
  estimateTokens,
} from './utils.js';
import { registerUniqueTool } from './tools/octocode-tools.js';
import { registerContextTools, resetAutoCompactState } from './tools/context-tools.js';
import { registerCompactionHooks, resetCompactionCheckpointDedupe } from './tools/compaction-hooks.js';
import { clearCompactionInFlight, clearCompactionResumeRequest } from './tools/compaction-state.js';
import { resetCompactionResumeSchedule } from './tools/compaction-resume.js';
import {
  cleanupSpawnedAgentsForShutdown,
  formatAgentLedger,
  handleOctocodeAgentsCommand,
  listWorkerLedgerEntries,
  OCTOCODE_AGENTS_COMMAND_COMPLETIONS,
  OCTOCODE_AGENTS_COMMAND_DESCRIPTIONS,
  OCTOCODE_AGENTS_COMMAND_USAGE,
  refreshAgentLedgerUi,
  registerAgentTools,
  setAgentLedgerMetricsRefreshForUi,
  isSubagentProcess,
  pruneDroppableAgentsForSession,
} from './tools/agent-tools.js';
import { registerWebTool } from './tools/web-tool.js';
import { registerChromeDebugTool } from './tools/chrome-debug-tool.js';
import { registerBrowserAgentTool } from './tools/browser-agent-tool.js';
import { registerSpawnSubagentTool } from './tools/spawn-subagent-tool.js';
import { registerCallTool } from './tools/call-tool.js';
import { registerCallSkill } from './tools/call-skill.js';
import { registerEditTool } from './tools/edit-tool.js';
import { registerWriteTool } from './tools/write-tool.js';
import { registerReadImageTool } from './tools/read-image-tool.js';
import { registerCreateImageTool } from './tools/create-image-tool.js';
import { setPeerWipBaseline, peerWipCount, setPeerWipStatusPainter } from './tools/peer-wip.js';
import { registerBashTool } from './tools/bash-tool.js';
import { APPROVAL_CLASSES, PERMISSION_LEVELS, applyStartupPermissionLevel, approvedClasses, cyclePermissionLevel, getPermissionLevel, parsePermissionLevel, resetApprovalStore, revokeAlways, setPermissionLevel, type ApprovalClass } from './tools/approval.js';
import { recordSessionTitle } from './tools/desktop-notify.js';
import { getCachedMcpCatalogAddendum, getCachedMcpCounts, getMcpDiscoverySnapshot, handleOctocodeMcpCommand, mcpCatalogReady, patchGlobalMcpOctocodeEnv, registerMcpTool, startMcpConfigWatcher, stopAllMcpServers, stopMcpConfigWatchers, warmMcpCatalog } from './tools/mcp-tool.js';
import { getDynamicCapabilitiesAddendum } from './tools/dynamic-catalog.js';
import { renderAvailableSkillsAddendum, renderSkillsDashboard } from './tools/skill-catalog.js';
import { registerPlanTool } from './tools/plan-tool.js';
import { registerLocalServerTool } from './tools/local-server-tool.js';
import { registerAskUserTool } from './tools/ask-user-tool.js';
import { registerMemoryTool } from './tools/memory-tool.js';
import { activePlanScope, adoptPlanFromBranch, renderActivePlanAddendum, getPlan, bumpPlanTurn, setPlanEntryAppender, PLAN_ENTRY_TYPE } from './tools/active-plan.js';
import { getCachedAwarenessStatus, refreshAwarenessPanel, suppressAwarenessPanel, resumeAwarenessPanel, clearAwarenessCacheEntry } from './tools/awareness-status.js';
import { refreshStatusPanel, suppressStatusPanel, resumeStatusPanel } from './tools/status-panel.js';
import { buildAgentFooterRows, buildCommandsRow, buildFooterSegments, buildShortcutHintsRow, formatBranchSegment, buildWorkingIndicator, buildWorkingMessage, formatCompact, getFooterDensity, parseFooterDensity, resolveSystemThemeName, setFooterDensity, deriveSessionName, OCTOCODE_THEME_DARK, OCTOCODE_THEME_LIGHT, type OctocodeThemeName, type ShortcutHint, type CommandEntry } from './ui-extras.js';
import { BRAND_DIAMOND, contextGauge, paint, SEP_WIDE } from './tui/palette.js';
import { setUiTickSubscriber } from './tui/ui-ticker.js';
import { FOOTER_LEGEND, PERMISSION_LEVEL_SUMMARY } from './tui/content.js';
import { listCDPSessions, closeAllChromeConnections } from './chrome-connection-cache.js';
import { handleOctocodePlanCommand, OCTOCODE_PLAN_COMMAND_USAGE, OCTOCODE_PLAN_COMMAND_COMPLETIONS } from './tools/plan-tool.js';
import { exitPlanMode, planModeToolGate } from './tools/plan-mode.js';
import { atomicWriteUtf8, clearAllReadStates, resolveFilePath } from './tools/file-state.js';
import { registerAgentInbox, type AgentInboxRegistration } from './tools/agent-inbox.js';
import { getPaletteShortcut, registerCommandPalette } from './tools/command-palette.js';
import { registerOctocodeAutocomplete } from './tools/autocomplete-providers.js';
import { registerOctocodeMessageRenderers } from './tools/custom-messages.js';
import { initCheckpointStore, type CheckpointEngine } from './tools/checkpoints.js';
import { createCheckpointInputHook, registerRewindCommand } from './tools/rewind-command.js';
import { registerDialCommand, restoreDialOnStartup, getActiveDialLevel } from './tools/effort-dial.js';
import { registerAiWatch, isWatchActive, markOwnWrite, markBashActivity, stopWatch } from './tools/ai-watch.js';
import { registerExportCommand } from './tools/export-command.js';
import { assertPathAllowed } from './tools/path-guard.js';
import { makeRenderer, truncateToWidth } from './tools/render-helpers.js';
import { renderBannerWithTagline, type BannerSessionInfo, type BannerTheme } from './branding/banner.js';
import { pickProvider } from './web.js';
import { createHookComposer } from './hook-composer.js';
import { loadProfile, type Profile } from './surfaces.js';
import {
  createOctocodeCronScheduler,
  formatOctocodeCronSummary,
  handleOctocodeCronCommand,
  OCTOCODE_CRON_COMMAND_COMPLETIONS,
  OCTOCODE_CRON_COMMAND_USAGE,
} from './scheduler.js';
import type {
  BeforeAgentStartEvent,
  CommandDefinition,
  PiInstance,
  PiContext,
  PiTheme,
  PiModel,
  OctocodePiExtensionOptions,
  PromptMode,
  SessionShutdownEvent,
  ThinkingLevelEvent,
  SkillInfo,
  NotifyFn,
} from './types.js';

// ─── Re-exports (stable public API) ──────────────────────────────────────────

import type { OctocodeShell, OctocodeShellDeps, ShellRuntime } from './shell/index.js';
export type { OctocodeShell, OctocodeShellDeps, ShellRuntime } from './shell/index.js';

/**
 * Octocode shell entry (Phase C alpha). Lazy: the shell pulls
 * `@earendil-works/pi-tui` at import time, so it must only load when the
 * launcher actually runs the shell (OCTOCODE_SHELL=1).
 */
export async function createOctocodeShell(
  runtime: ShellRuntime,
  deps?: OctocodeShellDeps,
): Promise<OctocodeShell> {
  const m = await import('./shell/index.js');
  return m.createOctocodeShell(runtime, deps);
}

export {
  DISABLED_BUILTIN_TOOL_NAMES,
  OVERRIDDEN_BUILTIN_TOOL_NAMES,
  OCTOCODE_SUPPORT_TOOL_NAMES,
} from './constants.js';
export {
  PACKAGE_NAME,
  SYSTEM_PROMPT_MARKER,
  MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
} from './constants.js';
export { getAssetPaths, readTextIfExists, listBundledSkills, getInstallSource, getAwarenessCLIPath, buildAwarenessLiteCommand } from './assets.js';
export {
  buildSurfaceSpec,
  loadProfile,
  profileToPiArgs,
} from './surfaces.js';
export type { Profile, SurfaceSpec, SurfaceVerb } from './surfaces.js';
export {
  shouldAppendSystemPrompt,
  renderSystemPromptAddendum,
  renderManagedAppendSystem,
  mergeManagedAppendSystem,
  resolvePromptMode,
  composeSystemPrompt,
  stripProjectContext,
  stripPiSkillsSection,
} from './prompt.js';
export {
  splitArgs,
  parseSetupScope,
  getAppendSystemTarget,
  truncateUserVisibleToolOutput,
} from './utils.js';
export { runWebTool, renderWebResult, pickProvider } from './web.js';
export {
  createHookComposer,
  OctocodeHookComposer,
  runHookMiddleware,
} from './hook-composer.js';
export {
  createOctocodeCronScheduler,
  formatOctocodeCronStatus,
  handleOctocodeCronCommand,
  OCTOCODE_CRON_COMMAND_COMPLETIONS,
  OCTOCODE_CRON_COMMAND_USAGE,
} from './scheduler.js';
export type {
  OctocodeCronJobDefinition,
  OctocodeCronJobSnapshot,
  OctocodeCronRunResult,
  OctocodeCronScheduler,
  OctocodeCronSchedulerOptions,
} from './scheduler.js';
export {
  cleanupSpawnedAgentsForShutdown,
  DEFAULT_SPAWN_POLICY,
  evaluateSpawnPolicy,
  OCTOCODE_AGENTS_COMMAND_COMPLETIONS,
  OCTOCODE_AGENTS_COMMAND_DESCRIPTIONS,
  OCTOCODE_AGENTS_COMMAND_USAGE,
  formatAgentLedger,
  formatAgentLedgerDetails,
  handleOctocodeAgentsCommand,
  listWorkerLedgerEntries,
  normalizeWorkerOutput,
  evaluateWorkerRecoveryRisk,
  refreshAgentLedgerUi,
  setAgentProcessFactoryForTests,
  setAgentWorktreeGitRunnerForTests,
} from './tools/agent-tools.js';
export type {
  PromptMode,
  OctocodePiExtensionOptions,
  SkillInfo,
  BuildSystemPromptOptions,
  LedgerEvent,
  SpawnPolicy,
  SpawnPolicyResult,
  WorkerLedgerEntry,
  WorkerLedgerEvent,
  WorkerLedgerEventType,
} from './types.js';

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * The `octocode-thinking` status text. Pi already renders `model: <id>` in the
 * same status row, so this never repeats the model id — it only carries the
 * thinking level (or its absence).
 */
export function getThinkingStatus(ctx: PiContext | undefined, level?: string): string {
  const model = ctx?.model;
  // Return empty string when the model doesn't support reasoning or no level is set;
  // the chip is hidden when empty, so it never shows 'thinking' permanently at idle.
  if (!model?.reasoning) return '';
  return level ?? '';
}

export interface OctocodeMetricsState {
  sessionStartedAt: number;
  activeTurnStartedAt?: number;
  lastTurnMs?: number;
  completedTurns: number;
  /** Whether the working tree was dirty at the last git refresh. Branch comes from Pi footerData. */
  gitDirty?: boolean;
  /** Changed-file count from the same porcelain probe (0 when clean). */
  gitDirtyFiles?: number;
  /**
   * Context usage sampled by updateOctocodeMetricsUi (turn/tool events + the 1s
   * ticker). The footer reads THIS, never ctx.getContextUsage() at render time:
   * pi rebuilds the whole session branch per call (agent-session.js
   * getContextUsage → sessionManager.getBranch()), and the footer renders on
   * every streamed token — that was O(session) work per frame.
   */
  usage?: { tokens: number; contextWindow: number };
}

function formatContextUsage(ctx: PiContext | undefined): { text: string; percent?: number } {
  const usage = ctx?.getContextUsage?.();
  // One placeholder for every "not measurable yet" case — n/a-style variants read as defects.
  if (!usage || usage.contextWindow <= 0) return { text: 'ctx …' };
  // tokens is null right after compaction ("unknown", per Pi's ContextUsage).
  if (usage.tokens == null) return { text: 'ctx …' };
  const percent = Math.round((usage.tokens / usage.contextWindow) * 100);
  const { bar } = contextGauge(percent, 10);
  return {
    // formatCompact from ui-extras — the footer's formatter, so /octocode-now
    // and the toolbar abbreviate numbers identically ("45M", "1.2k").
    text: `ctx ${bar} ${percent}% (${formatCompact(usage.tokens)}/${formatCompact(usage.contextWindow)})`,
    percent,
  };
}

interface WorkerFooterCounts {
  /** All worker records still tracked in this session. */
  total: number;
  /** Live workers (starting / running / idle). */
  active: number;
  /** Workers waiting on the lead (normalized [BLOCKED]). */
  blocked: number;
  /** Workers that failed / crashed. */
  failed: number;
}

function workerFooterCounts(): WorkerFooterCounts {
  const counts: WorkerFooterCounts = { total: 0, active: 0, blocked: 0, failed: 0 };
  try {
    for (const e of listWorkerLedgerEntries()) {
      counts.total += 1;
      // Buckets are mutually exclusive: a blocked-or-done idle worker must not
      // ALSO count as "live" — the footer would overstate active work and
      // disagree with the ledger's own status display.
      const live = e.status === 'running' || e.status === 'idle' || e.status === 'starting';
      if (e.status === 'failed' || e.normalizedStatus === 'failed') counts.failed += 1;
      // "Blocked" is an attention flag for a worker the lead can still unblock;
      // an exited process that last said [BLOCKED] is not actionable.
      else if (e.normalizedStatus === 'blocked' && live) counts.blocked += 1;
      else if (live && e.normalizedStatus !== 'done') counts.active += 1;
    }
  } catch {
    return { total: 0, active: 0, blocked: 0, failed: 0 };
  }
  return counts;
}

/**
 * Per-turn Octocode harness prompt overhead snapshot, set from before_agent_start
 * (where the prompt parts are already assembled) and read by the module-scoped
 * footer refresher. Zero extra work — reuses strings already built each turn.
 */
interface HarnessOverheadSnapshot { totalChars: number; sysChars: number; mcpChars: number; dynamicChars: number; mcpServers: number; mcpTools: number; skills: number }
let harnessOverhead: HarnessOverheadSnapshot | undefined;
export function setHarnessOverhead(snapshot: HarnessOverheadSnapshot | undefined): void {
  harnessOverhead = snapshot;
}

/**
 * Resolve the highest-value keyboard shortcuts for the footer hint row. Keys
 * come from the live keybinding config via `keyText` (so remaps are honored),
 * falling back to pi's documented defaults when the host hasn't initialized or
 * bound an action. The permission-cycle key is the Octocode-registered shortcut
 * (`OCTOCODE_PERMISSIONS_KEY`, default ctrl+shift+a), not a pi keybinding id.
 */
/**
 * All custom /octocode-* slash commands shown in the footer discovery row,
 * listed by their suffix (the "octocode-" prefix is stripped for brevity).
 * Ordered by everyday usefulness so truncation at narrow widths drops the
 * least-used commands from the right end.
 */
// Commands discovery row — each entry carries a one-word description and a
// semantic color token. Colors are LCI-aligned (spread across the hue circle)
// so categories read at a glance; ordering is by everyday usefulness so
// truncation at narrow widths drops the least-used commands from the right.
const OCTOCODE_FOOTER_COMMANDS: readonly CommandEntry[] = [
  // ── Inspect / live state ─────────────────────────────────────────────────
  { name: 'harness',     desc: 'inspect',  token: 'symbol'   }, // sky  — inventory/knowledge
  { name: 'now',         desc: 'snapshot', token: 'brand'    }, // purple — current moment
  { name: 'status',      desc: 'dash',     token: 'link'     }, // lavender — observability
  // ── Goal / task management ────────────────────────────────────────────────
  { name: 'plan',        desc: 'goal',     token: 'link'     }, // lavender — goal navigation
  { name: 'tasks',       desc: 'backlog',  token: 'link'     }, // lavender — task list
  // ── Agent coordination ────────────────────────────────────────────────────
  { name: 'agents',      desc: 'workers',  token: 'brandAlt' }, // teal  — live workers
  { name: 'cron',        desc: 'jobs',     token: 'dim'      }, // faint — passive scheduled
  // ── Connections ───────────────────────────────────────────────────────────
  { name: 'mcp',         desc: 'servers',  token: 'path'     }, // sky  — server connections
  { name: 'chrome',      desc: 'browser',  token: 'path'     }, // sky  — devtools/browser
  // ── Controls / access ─────────────────────────────────────────────────────
  { name: 'dial',        desc: 'effort',   token: 'warning'  }, // amber — effort controls
  { name: 'watch',       desc: 'ai!',      token: 'brandAlt' }, // teal  — live monitoring
  { name: 'permissions', desc: 'access',   token: 'warning'  }, // amber — security/access
  // ── Appearance / identity ─────────────────────────────────────────────────
  { name: 'theme',       desc: 'style',    token: 'brand'    }, // purple — styling
  { name: 'profile',     desc: 'identity', token: 'brand'    }, // purple — identity
  // ── Output / history ──────────────────────────────────────────────────────
  { name: 'rewind',      desc: 'undo',     token: 'dim'      }, // faint — restore history
  { name: 'export',      desc: 'html',     token: 'symbol'   }, // sky   — branded output
  // ── Capabilities / config ─────────────────────────────────────────────────
  { name: 'skills',      desc: 'catalog',  token: 'symbol'   }, // sky   — capabilities
  { name: 'setup',       desc: 'config',   token: 'dim'      }, // faint — one-time setup
];

function octocodeShortcutHints(): ShortcutHint[] {
  const kt = (id: string, fallback: string): string => {
    try {
      return keyText(id as Parameters<typeof keyText>[0]) || fallback;
    } catch {
      return fallback;
    }
  };
  const permissionsKey = process.env['OCTOCODE_PERMISSIONS_KEY'] || 'ctrl+shift+a';
  // All keys share the same dim token so they read as a uniform tier of
  // "press this" chrome; label tokens are semantic per-action so the action
  // words carry their own meaning at a glance.
  return [
    { key: kt('app.thinking.cycle', 'shift+tab'), label: 'think',   token: 'link',    keyToken: 'dim' },
    { key: permissionsKey,                        label: 'perm',    token: 'warning', keyToken: 'dim' },
    { key: kt('app.model.select', 'ctrl+l'),      label: 'model',   token: 'brand',   keyToken: 'dim' },
    { key: kt('app.tools.expand', 'ctrl+o'),      label: 'tools',   token: 'symbol',  keyToken: 'dim' },
    { key: getPaletteShortcut() ?? '',            label: 'palette', token: 'link',    keyToken: 'dim' },
    { key: kt('app.interrupt', 'esc'),            label: 'stop',    token: 'error',   keyToken: 'dim' },
  ];
}

// Footer registration is idempotent per session context. Pi's documented
// contract (docs/tui.md "Custom Footer": setFooter ONCE + tui.requestRender for
// live updates) — the previous code re-called setFooter on every 1s ticker and
// every agent-ledger event during a turn, which churned the whole footer
// component and leaked a new onBranchChange subscription per call. That churn
// showed up as message-area flicker and scroll jumps mid-turn. Now the factory
// reads live state at render time; updateOctocodeMetricsUi only asks Pi to
// repaint. Keyed by ctx (WeakMap/WeakSet) so a new session re-registers and old
// contexts are GC'd; session_start deletes the entry so the current session
// always re-registers with its own tui/theme.
const footerRegisteredCtxs = new WeakSet<object>();
const footerRequestRenderByCtx = new WeakMap<object, () => void>();

function buildOctocodeFooterLines(
  ctx: PiContext,
  state: OctocodeMetricsState,
  width: number,
  theme: PiTheme,
  footerData: { getGitBranch?: () => string | null | undefined } | undefined,
): string[] {
  // now is read at render time so the active-turn duration ticks live without
  // re-registering the footer.
  const now = Date.now();
  const usage = state.usage ?? { tokens: 0, contextWindow: 0 };
  const workers = workerFooterCounts();
  const cachedAwareness = getCachedAwarenessStatus(ctx.cwd ?? process.cwd());
  const activeEntry = listWorkerLedgerEntries().find(
    (e) => e.status === 'running' || e.status === 'starting' || e.status === 'idle',
  );
  const agentDoing = activeEntry ? (activeEntry.deltaSummary ?? activeEntry.name) : undefined;
  const segments = buildFooterSegments({
    tokens: usage?.tokens ?? 0,
    contextWindow: usage?.contextWindow ?? 0,
    completedTurns: state.completedTurns,
    activeTurnMs: state.activeTurnStartedAt !== undefined ? now - state.activeTurnStartedAt : undefined,
    lastTurnMs: state.lastTurnMs,
    sessionMs: now - state.sessionStartedAt,
    activeWorkers: workers.active,
    workerTotal: workers.total,
    agentDoing,
    awarenessAgents: cachedAwareness?.agentCount ?? 0,
    awarenessUnread: cachedAwareness?.unreadInbox ?? 0,
    peerDirty: peerWipCount(),
    blockedWorkers: workers.blocked,
    failedWorkers: workers.failed,
    dial: getActiveDialLevel(),
    permissionLevel: getPermissionLevel(),
    approvedClassCount: approvedClasses().length,
    overhead: harnessOverhead,
    branch: undefined,
    dirty: state.gitDirty ?? false,
    dirtyFiles: state.gitDirtyFiles,
  });
  const branch = footerData?.getGitBranch?.();
  const renderedSegments = branch
    ? [...segments, { text: formatBranchSegment(branch, state.gitDirty ?? false, state.gitDirtyFiles) }]
    : segments;
  // Static brand mark — no motion in the footer. Pi repaints the footer on every
  // streamed token; any time-varying bytes here (the old wordmark wave / glow)
  // changed the frame between repaints and read as flicker + scroll churn.
  const brand = paint(theme, 'brand', theme.bold(`${BRAND_DIAMOND} Octocode`));
  const sep = paint(theme, 'dim', SEP_WIDE);
  const body = renderedSegments
    .map((s) => {
      const painted = paint(theme, s.token ?? 'dim', s.text);
      return s.attention ? theme.bold(painted) : painted;
    })
    .join(sep);
  const lines = [truncateToWidth(`${brand}  ${body}`, width)];
  // One row per subagent (name · state · elapsed · communication/tool activity),
  // so workers stay visible in the footer itself at every density. Compact mode
  // trims top metric segments, not the live worker rows the operator asked for.
  const { rows, overflow } = buildAgentFooterRows(listWorkerLedgerEntries(), now);
  for (const r of rows) {
    const stateWord = paint(theme, r.token, r.state);
    const parts = [
      `${paint(theme, 'dim', '  ')}${paint(theme, 'muted', r.label)}`,
      r.attention ? theme.bold(stateWord) : stateWord,
      paint(theme, 'dim', r.elapsed),
      ...(r.doing ? [paint(theme, 'dim', `now: ${r.doing}`)] : []),
    ];
    lines.push(truncateToWidth(parts.join(sep), width));
  }
  if (overflow > 0) lines.push(truncateToWidth(paint(theme, 'dim', `  … ${overflow} more agents — /octocode-agents`), width));
  // Keyboard shortcuts row + commands discovery row. Hidden at compact density.
  if (getFooterDensity() !== 'compact') {
    const hints = buildShortcutHintsRow(octocodeShortcutHints(), theme);
    if (hints) lines.push(truncateToWidth(`${paint(theme, 'dim', 'keys')} ${hints}`, width));
    const cmds = buildCommandsRow(OCTOCODE_FOOTER_COMMANDS, theme);
    if (cmds) lines.push(truncateToWidth(`${paint(theme, 'dim', 'cmds')} ${cmds}`, width));
  }
  return lines;
}

function updateOctocodeMetricsUi(ctx: PiContext | undefined, state: OctocodeMetricsState, _now = Date.now()): void {
  if (!ctx?.hasUI) return;
  // Sample once per update (event or 1s tick); the render closure only reads.
  try {
    const u = ctx.getContextUsage?.();
    if (u) state.usage = { tokens: u.tokens ?? 0, contextWindow: u.contextWindow ?? 0 };
  } catch { /* keep the last sample */ }

  // The consolidated branded footer is the SINGLE metrics surface — context /
  // tokens / turns / timing / agents / git. Plan stays in the below-editor panel.
  if (!footerRegisteredCtxs.has(ctx)) {
    footerRegisteredCtxs.add(ctx);
    ctx.ui?.setFooter?.((tui: unknown, theme, footerData) => {
      footerRequestRenderByCtx.set(ctx, () => (tui as { requestRender?: () => void } | undefined)?.requestRender?.());
      const renderer = makeRenderer((width) => buildOctocodeFooterLines(ctx, state, width, theme, footerData));
      const unsubscribe = footerData?.onBranchChange?.(() => {
        renderer.invalidate();
        footerRequestRenderByCtx.get(ctx)?.();
      });
      return {
        ...renderer,
        dispose: () => unsubscribe?.(),
      };
    });
  }
  // Live update: repaint the already-registered footer with fresh state instead
  // of re-registering it (which is what caused the flicker).
  footerRequestRenderByCtx.get(ctx)?.();
}
const REPO_STATE_TRIGGER = /\b(repo|git|status|staged|unstaged|changes?|diff|commit|branch|dirty|modified|working tree|worktree)\b/i;

async function execGitSummary(pi: PiInstance, args: string[], timeout = 1200): Promise<string> {
  if (!pi.exec) return '';
  try {
    const result = await pi.exec('git', args, { timeout });
    if (result.code !== 0) return '';
    return result.stdout.trim();
  } catch {
    return '';
  }
}

const LITE_LOCK_GATE_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'multiedit',
  'notebookedit',
  'notebook_edit',
  'apply_patch',
  'applypatch',
]);

function getAwarenessLiteAgentId(ctx?: PiContext): string {
  if (process.env.OCTOCODE_AGENT_ID) return process.env.OCTOCODE_AGENT_ID;
  const sessionId = ctx?.sessionManager?.getSessionId?.()
    ?? (ctx?.sessionManager?.getSessionFile?.() ? path.basename(ctx.sessionManager.getSessionFile()!) : undefined);
  const agentId = `pi:${sessionId || process.pid}`;
  process.env.OCTOCODE_AGENT_ID = agentId;
  return agentId;
}

/**
 * Fire-and-forget Awareness Lite registry presence. Join at session_start with
 * the session-stable agent id — Lite generates a funny host-tagged name
 * (octo-* here, since the harness sets OCTOCODE_AGENT_HOST) so peers in other
 * runners (clawde-*, cursea-*) see WHO is active in the shared workspace.
 * Leave at shutdown so the registry doesn't accumulate stale ACTIVE rows.
 * Best-effort: never blocks the session and never throws.
 */
function updateAwarenessLiteRegistry(action: 'join' | 'leave', pi: PiInstance, ctx?: PiContext): void {
  if (!pi.exec) return;
  const cwd = ctx?.cwd ?? process.cwd();
  try {
    const args = ['agent', action, '--agent-id', getAwarenessLiteAgentId(ctx), '--workspace', cwd];
    if (action === 'join') args.push('--role', 'lead');
    const spec = buildAwarenessLiteCommand(args);
    void pi.exec(spec.cmd, spec.args, { timeout: 5000 }).catch(() => { /* presence is advisory */ });
  } catch { /* Awareness Lite unresolved — skip */ }
}

async function runAwarenessLitePreEditLockGate(pi: PiInstance, event: { toolName?: string; input?: Record<string, unknown> }, ctx?: PiContext): Promise<{ block?: boolean; reason?: string } | void> {
  const toolName = String(event.toolName ?? '').toLowerCase();
  if (!LITE_LOCK_GATE_WRITE_TOOLS.has(toolName)) return undefined;
  if (!pi.exec) return undefined;
  const cwd = ctx?.cwd ?? process.cwd();
  const spec = buildAwarenessLiteCommand([
    'hooks',
    'pre-edit',
    '--host',
    'pi',
    '--workspace',
    cwd,
    '--agent-id',
    getAwarenessLiteAgentId(ctx),
    '--event-json',
    JSON.stringify(event),
  ]);
  // Fail-OPEN on infra errors: if pi.exec rejects (spawn failure), a bare
  // throw would surface as { block: true } via runHookMiddleware and block the
  // user's edit with an internal hook message. Only a deliberate exit code 2
  // may block.
  let result: { code?: number | null; stdout: string; stderr: string };
  try {
    result = await pi.exec(spec.cmd, spec.args, { timeout: 5000 });
  } catch (err) {
    notify(ctx, `Awareness Lite lock gate skipped: ${err instanceof Error ? err.message : String(err)}`, 'warning');
    return undefined;
  }
  if (result.code === 2) {
    let reason = result.stdout.trim() || 'Awareness Lite lock conflict.';
    try {
      const parsed = JSON.parse(result.stdout) as { message?: string };
      reason = parsed.message ?? reason;
    } catch { /* stdout was not JSON */ }
    return { block: true, reason };
  }
  if (result.code && result.code !== 0) {
    notify(ctx, `Awareness Lite lock gate skipped: ${result.stderr || result.stdout || `exit ${result.code}`}`.trim(), 'warning');
  }
  return undefined;
}

/**
 * Refresh the footer's dirty marker on turn/session boundaries. Pi's footerData
 * provider owns branch detection/watching, so this keeps our extra `*` marker
 * without duplicating branch probes.
 */
async function refreshFooterDirtyState(pi: PiInstance, state: OctocodeMetricsState): Promise<void> {
  const porcelain = await execGitSummary(pi, ['status', '--porcelain'], 600);
  state.gitDirty = porcelain !== '';
  state.gitDirtyFiles = porcelain === '' ? 0 : porcelain.split('\n').filter((l) => l.trim()).length;
}

async function buildRepoStateHint(pi: PiInstance, event: { text: string; source?: string; streamingBehavior?: string }): Promise<string> {
  if (event.source === 'extension') return '';
  if (event.streamingBehavior === 'steer') return '';
  if (!REPO_STATE_TRIGGER.test(event.text)) return '';
  const status = await execGitSummary(pi, ['status', '--short', '--branch']);
  if (!status) return '';
  const [lastCommit, stagedStat, unstagedStat] = await Promise.all([
    execGitSummary(pi, ['log', '-1', '--oneline', '--decorate'], 800),
    execGitSummary(pi, ['diff', '--staged', '--stat'], 800),
    execGitSummary(pi, ['diff', '--stat'], 800),
  ]);
  return [
    '<repo_state>',
    'Auto-captured lightweight Git state. Treat as a hint; re-run git/status checks before edits or final claims.',
    '```',
    status,
    lastCommit ? `\nlast commit: ${lastCommit}` : '',
    stagedStat ? `\nstaged diffstat:\n${stagedStat}` : '',
    unstagedStat ? `\nunstaged diffstat:\n${unstagedStat}` : '',
    '```',
    '</repo_state>',
  ].filter(Boolean).join('\n');
}

/** CustomEntry type for the fresh-session banner card. */
export const OCTOCODE_BANNER_ENTRY_TYPE = 'octocode-banner';

/**
 * Per-context guard: setWorkingIndicator / setWorkingMessage / setHiddenThinkingLabel
 * never change within a session, so we only apply them once to avoid the micro-flicker
 * that repeated calls (model_select, thinking_level_select, input) would produce.
 */
const workingUiInitCtxs = new WeakSet<object>();

export function applyOctocodeUi(ctx: PiContext | undefined, level?: string, contextTitle?: string): void {
  // setStatus / setHiddenThinkingLabel are TUI-only; guard with hasUI.
  if (!ctx?.hasUI) return;
  const ui = ctx?.ui;
  if (!ui) return;
  const title = deriveSessionName(contextTitle ?? '');
  const windowTitle = title ? `Octocode · ${title}` : 'Octocode';
  // The session name lives in the TERMINAL title only. It used to also be a
  // pi header line (`◆ <title>`) at the very top of the TUI content — any change
  // to line 0 is "above the viewport" for pi-tui's differential renderer, which
  // then full-redraws and CLEARS SCROLLBACK (tui-main-screen.js: firstChanged <
  // viewportTop → fullRender(true)). With the name re-derived on every prompt,
  // that wiped the scrollback on every message. The transcript banner card
  // already carries the brand; nothing Octocode-owned renders above the chat.
  ui.setTitle?.(windowTitle);
  // Title flashes (desktop-notify) restore to the live harness title, not a constant.
  recordSessionTitle(windowTitle);
  const label = paint(ui.theme, 'brand', '◆ Octocode');
  ui.setStatus?.('octocode', label);
  // Thinking-level chip: only show the level string (e.g. 'medium') when the model
  // supports reasoning. Empty → chip is hidden. The chip becomes 'thinking…' while
  // a turn is active (turn_start hook), and restores here on every level/model change.
  const thinkingStatus = getThinkingStatus(ctx, level);
  ui.setStatus?.('octocode-thinking', thinkingStatus ? paint(ui.theme, 'dim', thinkingStatus) : undefined);
  // One-time per context: working indicator frames, branded message, and the hidden
  // thinking label. These never change within a session; re-applying them on every
  // model/thinking/input event would cause unnecessary redraws and micro-flicker.
  if (!workingUiInitCtxs.has(ctx)) {
    workingUiInitCtxs.add(ctx);
    ui.setHiddenThinkingLabel?.('Octocode thinking');
    // Glyph-only indicator + branded message: Pi renders these side-by-side,
    // so keeping "Octocode" out of the frames avoids "Octocode Octocode …".
    const t = ui.theme;
    ui.setWorkingIndicator?.(buildWorkingIndicator(t));
    // Custom working message: the animated frames supply ALL motion; the text
    // is the static branded verb. No elapsed time, no dot cycling — a second
    // cadence at a different phase reads as jitter, not liveliness.
    ui.setWorkingMessage?.(buildWorkingMessage(t));
  }
}

export function getInternalErrorLogPath(cwd = process.cwd()): string {
  return path.join(cwd, '.octocode', 'logs', 'error.txt');
}

function normalizeError(error: unknown): { name?: string; message: string; stack?: string; cause?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause === undefined ? undefined : String(error.cause),
    };
  }
  return { message: String(error) };
}

function redactForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, '$1=[REDACTED]');
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 6) return '[MaxDepth]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactForLog(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (/authorization|cookie|set-cookie|token|secret|password|api[_-]?key|access[_-]?key|credential/i.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactForLog(item, depth + 1, seen);
    }
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactForLog(value), null, 2);
  } catch {
    return String(value);
  }
}

function formatContextForLog(ctx: PiContext | undefined): string[] {
  const usage = ctx?.getContextUsage?.();
  return [
    `cwd: ${ctx?.cwd ?? process.cwd()}`,
    ctx?.mode ? `mode: ${ctx.mode}` : '',
    ctx?.model?.id ? `model: ${ctx.model.id}` : '',
    ctx?.model ? `modelReasoning: ${String(ctx.model.reasoning)}` : '',
    usage && usage.tokens != null ? `context: ${usage.tokens}/${usage.contextWindow} (${Math.round((usage.tokens / usage.contextWindow) * 100)}%)` : usage ? 'context: unknown (post-compaction)' : '',
  ].filter(Boolean);
}

export interface InternalErrorLogOptions {
  severity?: 'error' | 'warning';
  stack?: boolean;
}

export function logInternalError(
  source: string,
  error: unknown,
  details: Record<string, unknown> = {},
  ctx?: PiContext,
  options: InternalErrorLogOptions = {},
): void {
  try {
    const severity = options.severity ?? 'error';
    const includeStack = options.stack ?? severity === 'error';
    const logPath = getInternalErrorLogPath(ctx?.cwd ?? process.cwd());
    const normalized = normalizeError(error);
    const durationMs = typeof details['durationMs'] === 'number' ? details['durationMs'] : undefined;
    const redactedDetails = Object.keys(details).length > 0 ? safeJson(details) : '';
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      [
        severity === 'warning' ? '=== Octocode Pi Extension Warning ===' : '=== Octocode Pi Extension Error ===',
        `timestamp: ${new Date().toISOString()}`,
        `uptimeMs: ${Math.round(process.uptime() * 1000)}`,
        `source: ${source}`,
        `severity: ${severity}`,
        durationMs === undefined ? '' : `durationMs: ${durationMs}`,
        ...formatContextForLog(ctx),
        normalized.name ? `error.name: ${normalized.name}` : '',
        `error.message: ${normalized.message}`,
        normalized.cause ? `error.cause: ${normalized.cause}` : '',
        redactedDetails ? `details: ${redactedDetails}` : '',
        includeStack && normalized.stack ? `stack:\n${normalized.stack}` : '',
        '---',
      ].filter(Boolean).join('\n') + '\n',
    );
  } catch {
    // Logging must never become the reason the extension fails.
  }
}

function notify(ctx: PiContext | undefined, message: string, level = 'info'): void {
  if (level === 'error') {
    logInternalError('notify', new Error(message), { mode: ctx?.mode }, ctx);
  }

  if (ctx?.ui?.notify) {
    ctx.ui.notify(message, level);
    return;
  }

  const log = level === 'error' ? console.error : level === 'warning' ? console.warn : console.info;
  log(`[octocode:${level}] ${message}`);
}

async function confirm(
  ctx: PiContext | undefined,
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx?.ui?.confirm) return false;
  return Boolean(await ctx.ui.confirm(title, message));
}

// ─── Status / harness ────────────────────────────────────────────────────────

function formatOctocodeToolStatus(): string {
  return `MCP research (octocode server) · ${OCTOCODE_SUPPORT_TOOL_NAMES.length} support · ${OVERRIDDEN_BUILTIN_TOOL_NAMES.length} guarded built-ins · ${DISABLED_BUILTIN_TOOL_NAMES.length} replaced`;
}

function formatToolCapabilitySummary(): string {
  return [
    `research: GitHub/local/LSP/npm via MCPTool (octocode server)`,
    `support: ${OCTOCODE_SUPPORT_TOOL_NAMES.join(', ')}`,
    `guarded mutations: ${OVERRIDDEN_BUILTIN_TOOL_NAMES.join(', ')}`,
    `replaced weak built-ins: ${DISABLED_BUILTIN_TOOL_NAMES.join(', ')}`,
  ].join('\n');
}

export function formatStatus(baseDir?: string): string {
  const paths = getAssetPaths(baseDir);
  const skills = listBundledSkills(baseDir);
  const promptStatus = fs.existsSync(paths.systemPrompt) ? 'found' : 'missing';

  const searchProvider = pickProvider({});
  const searchKeys = ['TAVILY_API_KEY', 'TAVILY_API_TOKEN', 'SERPER_API_KEY'].filter(
    (k) => process.env[k],
  );
  const searchStatus = `${searchProvider}${searchKeys.length ? ` (keys: ${searchKeys.join(', ')})` : ' (no key — DuckDuckGo fallback)'}`;

  return [
    'Octocode Pi extension',
    `system prompt: ${promptStatus}`,
    `skills: ${skills.length}${skills.length > 0 ? ` (${skills.join(', ')})` : ''}`,
    `octocode tools: ${formatOctocodeToolStatus()}`,
    `awareness lite CLI: ${getAwarenessCLIPath(baseDir)} — user CLI: npx @octocodeai/octocode-awareness-lite <command> [action] --workspace "$PWD"`,
    `management CLI: npx octocode skill | lsp-server | auth (no bundled CLI — use npx octocode for management tasks)`,
    `disabled/replaced built-ins: overridden: ${OVERRIDDEN_BUILTIN_TOOL_NAMES.join(', ')}${DISABLED_BUILTIN_TOOL_NAMES.length ? `; removed: ${DISABLED_BUILTIN_TOOL_NAMES.join(', ')}` : ''}`,
    `web search: ${searchStatus}`,
    `internal error log: ${getInternalErrorLogPath(process.cwd())}`,
    `package assets: ${paths.baseDir}`,
    `flags: --no-context (suppress project context files for this run)`,
  ].join('\n');
}

/**
 * Approximate per-turn prompt cost of each Octocode system-prompt addition.
 * Compaction is budget: this makes the "helpful default prompt inventory"
 * (static prompt, MCP catalog, skills, dynamic capabilities, active plan)
 * visible so oversized blocks can be spotted. ~4 chars/token heuristic.
 */
export function formatPromptBudget(parts: Array<{ label: string; text: string }>): string {
  const est = (chars: number): string => `${chars} chars (~${estimateTokens(chars)} tokens)`;
  const lines = parts.map((part) =>
    `- ${part.label}: ${part.text.trim().length === 0 ? '(empty)' : est(part.text.length)}`,
  );
  const total = parts.reduce((sum, part) => sum + part.text.length, 0);
  return [
    'Prompt budget (per-turn Octocode system-prompt additions; ~4 chars/token):',
    ...lines,
    `- total: ${est(total)}`,
  ].join('\n');
}

export interface ExtensionHarness {
  tools: string[];
  supportTools: string[];
  overriddenBuiltins: string[];
  disabledBuiltins: string[];
  passthroughBuiltins: string[];
  extensionCommands: string[];
  skills: string[];
  cliNote: string;
  awarenessCliNote: string;
}

export function listExtensionHarness(baseDir?: string): ExtensionHarness {
  return {
    tools: [], // research tools served via MCPTool → octocode MCP server
    supportTools: [...OCTOCODE_SUPPORT_TOOL_NAMES],
    overriddenBuiltins: [...OVERRIDDEN_BUILTIN_TOOL_NAMES],
    disabledBuiltins: [...DISABLED_BUILTIN_TOOL_NAMES],
    passthroughBuiltins: [],
    extensionCommands: [
      '/octocode',
      '/octocode-status',
      '/octocode-harness',
      '/octocode-now',
      '/octocode-tasks',
      '/octocode-skills',
      '/octocode-agents',
      '/octocode-cron',
      '/cron',
      '/octocode-mcp',
      '/mcp',
      '/octocode-setup',
      '/octocode-skills-update',
      '/octocode-plan',
      '/octocode-theme',
      '/octocode-chrome',
      '/octocode-footer',
      '/octocode-permissions',
      '/octocode-profile',
      '/octocode-inbox',
      '/octocode-palette',
      '/octocode-rewind',
      '/octocode-dial',
      '/octocode-watch',
      '/octocode-export',
    ],
    skills: listBundledSkills(baseDir),
    cliNote: `management: npx octocode skill | lsp-server | auth (no bundled CLI — use npx octocode for management tasks)`,
    awarenessCliNote: `Awareness Lite CLI: ${getAwarenessCLIPath(baseDir)}; user CLI: npx @octocodeai/octocode-awareness-lite <command> [action] --workspace "$PWD"`,
  };
}

export function formatOctocodeDashboard(ctx?: PiContext, baseDir?: string, sessionJobs?: string): string {
  const paths = getAssetPaths(baseDir);
  const skills = listBundledSkills(baseDir);
  const context = formatContextUsage(ctx);
  const promptOk = fs.existsSync(paths.systemPrompt);
  const awarenessCliPath = getAwarenessCLIPath(baseDir);
  const searchProvider = pickProvider({});
  const warnings = [
    context.percent !== undefined && context.percent >= 90 ? `⚠ context above 90% (${context.percent}%) — consider compacting soon` : '',
    promptOk ? '' : `⚠ missing system prompt at ${paths.systemPrompt}`,
    searchProvider === 'duckduckgo' ? '⚠ web search using DuckDuckGo fallback; add Tavily/Serper for stronger results' : '',
  ].filter(Boolean);

  return [
    '◆ Octocode dashboard — extension health & setup (live work: /octocode-now)',
    '',
    'Status',
    `${promptOk ? '✓' : '⚠'} system prompt: ${promptOk ? 'found' : 'missing'}`,
    `✓ tools: ${formatOctocodeToolStatus()}`,
    `✓ metrics: ${context.text}`,
    `Awareness Lite: ${awarenessCliPath} (user CLI: npx @octocodeai/octocode-awareness-lite <command> [action] --workspace "$PWD")`,
    `Management: npx octocode skill | lsp-server | auth`,
    '',
    'Agents',
    formatAgentLedger(),
    `ledger entries: ${listWorkerLedgerEntries().length} · details: /octocode-agents list`,
    '',
    'Tools',
    formatToolCapabilitySummary(),
    '',
    'Session jobs',
    sessionJobs ?? 'No session jobs scheduled — use /octocode-cron to schedule repeating tasks.',
    '',
    'Setup',
    `project APPEND_SYSTEM: ${getAppendSystemTarget('project', ctx?.cwd ?? process.cwd())}`,
    `global APPEND_SYSTEM: ${getAppendSystemTarget('global', ctx?.cwd ?? process.cwd())}`,
    'APPEND_SYSTEM is for plain-Pi sessions — not needed when this extension is loaded (prompt injected at runtime).',
    '',
    'Skills',
    `${skills.length} bundled: ${skills.join(', ') || '(none)'}`,
    '',
    'Health',
    ...(warnings.length > 0 ? warnings : ['✓ no dashboard warnings']),
    '',
    'Next actions',
    `/octocode-palette${getPaletteShortcut() ? ` (${getPaletteShortcut()})` : ''} · /octocode-now · /octocode-tasks · /octocode-skills · /octocode-agents · /octocode-inbox · /octocode-cron · /octocode-dial · /octocode-watch · /octocode-status`,
    '/octocode-permissions (approval gate) · /octocode-footer legend (toolbar decoder)',
  ].join('\n');
}

function formatModelLine(ctx?: PiContext): string {
  const model = ctx?.model;
  if (!model?.id) return 'model: unknown';
  const provider = model.provider ? `${model.provider}/` : '';
  const thinking = model.reasoning ? ' · reasoning' : '';
  return `model: ${provider}${model.id}${thinking}`;
}

function formatPlanLines(ctx?: PiContext): string[] {
  const steps = getPlan(activePlanScope(ctx));
  if (steps.length === 0) return ['local plan: none — use plan(set) for multi-step work'];
  const done = steps.filter((s) => s.status === 'done').length;
  const current = steps.find((s) => s.status === 'doing') ?? steps.find((s) => s.status !== 'done');
  return [
    `local plan: ${done}/${steps.length} done`,
    current ? `now: ${current.activeForm && current.status === 'doing' ? current.activeForm : current.text}` : 'now: all steps done — verify, then clear',
  ];
}

function formatAwarenessLines(ctx?: PiContext): string[] {
  const cwd = ctx?.cwd ?? process.cwd();
  const status = getCachedAwarenessStatus(cwd);
  if (!status) return ['shared tasks: no cached Awareness Lite status yet — refresh queued; run /octocode-now again'];
  const lines = [
    `shared tasks: plans ${status.activePlans} · ready ${status.readyTasks} · doing ${status.inProgressTasks}`,
    `verify debt: ${status.verifyTasks} · locks ${status.lockCount} · work ${status.workCount}`,
  ];
  // Surface inter-agent communication only when there is any — non-rigid, no empty noise.
  const comms: string[] = [];
  if (status.unreadInbox && status.unreadInbox > 0) {
    comms.push(status.lastInbound
      ? `✉ ${status.unreadInbox} unread (from ${status.lastInbound.from}: ${status.lastInbound.preview})`
      : `✉ ${status.unreadInbox} unread`);
  }
  if (status.messageCount > 0) {
    comms.push(status.lastMessage
      ? `peer-msgs ${status.messageCount} (last ${status.lastMessage.from}→${status.lastMessage.to}: ${status.lastMessage.preview})`
      : `peer-msgs ${status.messageCount}`);
  }
  if (comms.length) lines.push(`agent comms: ${comms.join(' · ')}`);
  return lines;
}

function compactRepoStatus(status: string): string[] {
  const lines = status.split('\n').filter(Boolean);
  if (lines.length === 0) return ['git: clean or unavailable'];
  const shown = lines.slice(0, 8);
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more dirty entries`);
  return shown;
}

export function formatOctocodeTasks(ctx?: PiContext): string {
  return [
    '◆ Octocode tasks',
    '',
    'Local session plan',
    ...formatPlanLines(ctx),
    '',
    'Shared Awareness work',
    ...formatAwarenessLines(ctx),
    '',
    'Rule of thumb',
    'Use plan(...) for your current solo breakdown; use Awareness Lite plan/task/work when state must survive sessions or coordinate agents.',
    'Commands: /octocode-plan · npx @octocodeai/octocode-awareness-lite status --workspace "$PWD"',
  ].join('\n');
}

export async function formatOctocodeNow(ctx: PiContext | undefined, pi: PiInstance): Promise<string> {
  refreshAwarenessPanel(ctx);
  const repoStatus = await execGitSummary(pi, ['status', '--short', '--branch'], 800);
  return [
    '◆ Octocode now — live work cockpit (extension health: /octocode)',
    '',
    'Orientation',
    formatModelLine(ctx),
    formatContextUsage(ctx).text,
    `mode: ${ctx?.mode ?? 'unknown'} · cwd: ${ctx?.cwd ?? process.cwd()}`,
    '',
    'Current work',
    ...formatPlanLines(ctx),
    '',
    'Shared work',
    ...formatAwarenessLines(ctx),
    '',
    'Agents',
    formatAgentLedger(),
    '',
    'Repository',
    ...compactRepoStatus(repoStatus),
    '',
    'Next actions',
    '/octocode-tasks · /octocode-skills · /octocode-agents · /octocode-mcp status · /octocode-cron',
  ].join('\n');
}

// ─── Built-in tool disable ────────────────────────────────────────────────────

/**
 * Remove Pi builtins that Octocode replaces with superior tools
 * (`read`/`grep`/`find`/`ls`). Idempotent. Prefer calling after tool
 * registration and again on `session_start` so later `setActiveTools` resets
 * cannot silently re-enable the weak builtins.
 */
export function disableBuiltinTools(pi: PiInstance): boolean {
  if (!pi.getActiveTools || !pi.setActiveTools) return false;
  try {
    const activeTools = pi.getActiveTools();
    if (!Array.isArray(activeTools)) return false;
    const disabled = new Set<string>(DISABLED_BUILTIN_TOOL_NAMES);
    const nextTools = activeTools.filter((toolName) => !disabled.has(toolName));
    if (nextTools.length === activeTools.length) return false;
    pi.setActiveTools(nextTools);
    return true;
  } catch (error) {
    // Swallow all errors from getActiveTools/setActiveTools — the Pi API shape can
    // change across versions and races during initialization must never prevent the
    // extension from loading. Log unexpected errors for diagnostics but never rethrow.
    const msg = String((error as Error)?.message ?? error);
    if (!msg.includes('Extension runtime not initialized')) {
      console.warn('[octocode-pi-extension] disableBuiltinTools non-critical error:', msg);
    }
    return false;
  }
}

function profileFilePath(): string {
  return path.join(getOctocodeHome(process.env), 'profiles.json');
}

function listProfileNames(): string[] {
  try {
    const file = profileFilePath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.keys(parsed).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function splitProfileToolList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function profileApproveToPermission(profile: Profile): 'strict' | 'default' | 'relaxed' | undefined {
  if (profile.approve === 'always') return 'relaxed';
  if (profile.approve === 'never') return 'strict';
  if (profile.approve === 'ask') return 'default';
  return undefined;
}

function resolveProfileModel(profileModel: string, ctx: PiContext | undefined): PiModel {
  const slash = profileModel.indexOf('/');
  const explicitProvider = slash > 0 ? profileModel.slice(0, slash) : undefined;
  const modelId = slash > 0 ? profileModel.slice(slash + 1) : profileModel;
  const provider = explicitProvider ?? ctx?.model?.provider;
  const registryMatch = provider ? ctx?.modelRegistry?.find(provider, modelId) : undefined;
  return registryMatch ?? { id: modelId, provider };
}

async function applyRuntimeProfile(pi: PiInstance, ctx: PiContext | undefined, name: string, profile: Profile): Promise<{ lines: string[]; warnings: string[] }> {
  const lines: string[] = [];
  const warnings: string[] = [];

  if (profile.model) {
    if (typeof pi.setModel !== 'function') {
      warnings.push('model unchanged: host does not support setModel');
    } else {
      const model = resolveProfileModel(profile.model, ctx);
      const ok = await pi.setModel(model);
      if (ok) lines.push(`model: ${model.provider ? `${model.provider}/` : ''}${model.id ?? profile.model}`);
      else warnings.push(`model unchanged: ${profile.model} was not accepted by Pi`);
    }
  }

  const includeTools = splitProfileToolList(profile.tools);
  const excludeTools = new Set(splitProfileToolList(profile.excludeTools));
  if (includeTools.length > 0 || excludeTools.size > 0) {
    if (!pi.getActiveTools || !pi.setActiveTools) {
      warnings.push('tools unchanged: host does not support active tool scoping');
    } else {
      const baseTools = includeTools.length > 0 ? includeTools : pi.getActiveTools();
      const scoped = baseTools.filter((tool) => !excludeTools.has(tool));
      pi.setActiveTools(scoped);
      disableBuiltinTools(pi);
      lines.push(`tools: ${pi.getActiveTools?.().join(', ') ?? scoped.join(', ')}`);
    }
  }

  const permission = profileApproveToPermission(profile);
  if (permission) {
    setPermissionLevel(permission);
    lines.push(`permissions: ${permission} (${profile.approve})`);
  }

  if (lines.length === 0 && warnings.length === 0) lines.push(`profile ${name}: no live-applicable fields`);
  return { lines, warnings };
}

// ─── APPEND_SYSTEM installer ──────────────────────────────────────────────────

async function installAppendSystem(args: string, ctx: PiContext | undefined): Promise<void> {
  const paths = getAssetPaths();
  const prompt = readTextIfExists(paths.systemPrompt);
  if (prompt.trim().length === 0) {
    notify(ctx, `Missing Octocode system prompt at ${paths.systemPrompt}`, 'error');
    return;
  }
  const scope = parseSetupScope(args);
  const targetPath = getAppendSystemTarget(scope, ctx?.cwd ?? process.cwd());
  if (!ctx?.hasUI) {
    notify(ctx, '/octocode-setup requires an interactive session to confirm. Run from the Pi UI.', 'error');
    return;
  }
  const ok = await confirm(
    ctx,
    'Install Octocode APPEND_SYSTEM.md?',
    `Write the managed Octocode harness block to ${targetPath}? ` +
      'Note: sessions running this extension already inject the prompt at runtime (marker-guarded, no double append) — install only for plain-Pi sessions without the extension.',
  );
  if (!ok) {
    notify(ctx, 'Octocode setup cancelled.', 'info');
    return;
  }
  const existing = readTextIfExists(targetPath);
  const nextContent = mergeManagedAppendSystem(existing, prompt);
  try {
    assertPathAllowed(targetPath, ctx?.cwd ?? process.cwd(), 'octocode setup');
    await atomicWriteUtf8(targetPath, nextContent);
    notify(ctx, `Octocode APPEND_SYSTEM.md installed at ${targetPath}`, 'info');
  } catch (error) {
    notify(
      ctx,
      `Failed to write ${targetPath}: ${(error as Error)?.message ?? String(error)}`,
      'error',
    );
  }
}

function existingDirectory(filePath: string): string | null {
  return fs.existsSync(filePath) ? filePath : null;
}

// ─── Pi wiring ────────────────────────────────────────────────────────────────

type TypeBoxBuilder = (typeof import('typebox'))['Type'];

interface SupportToolRegistrationArgs {
  pi: PiInstance;
  Type: TypeBoxBuilder;
  registeredToolNames: Set<string>;
  notify: NotifyFn;
  getLatestAvailableSkills: () => SkillInfo[] | undefined;
}

function registerSupportToolPhase({ pi, Type, registeredToolNames, notify, getLatestAvailableSkills }: SupportToolRegistrationArgs): void {
  registerEditTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerWriteTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerBashTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerReadImageTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerCreateImageTool(pi, Type, registeredToolNames, registerUniqueTool);

  registerWebTool(pi, Type, registeredToolNames, registerUniqueTool);

  if (process.env['OCTOCODE_CHROME_DEBUG'] !== '0') {
    registerChromeDebugTool(pi, Type, registeredToolNames, registerUniqueTool, notify);
    registerBrowserAgentTool(pi, Type, registeredToolNames, registerUniqueTool, notify);
  }

  registerSpawnSubagentTool(pi, Type, registeredToolNames, registerUniqueTool, notify);
  registerCallTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerCallSkill(pi, Type, registeredToolNames, registerUniqueTool);

  // Octocode-owned skill loading (replaces Pi's read-based flow, which is
  // stripped from the prompt): skill({action:"load"|"list"}).
  registerSkillTool(pi, Type, registeredToolNames, registerUniqueTool, getLatestAvailableSkills);

  registerPlanTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerLocalServerTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerAskUserTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerMemoryTool(pi, Type, registeredToolNames, registerUniqueTool);
  registerMcpTool(pi, Type, registeredToolNames, registerUniqueTool);
}

interface RuntimeUiRegistrationArgs {
  pi: PiInstance;
  Type: TypeBoxBuilder;
  registeredToolNames: Set<string>;
  notify: NotifyFn;
}

function registerRuntimeUiPhase({ pi, Type, registeredToolNames, notify }: RuntimeUiRegistrationArgs): void {
  registerCompactionHooks(pi, notify);
  // Branded conversation cards (compaction checkpoints / awareness handoffs)
  // — must be registered before compaction-hooks emits the first card.
  registerOctocodeMessageRenderers(pi);
  // Fresh-session banner card: a durable TUI-only transcript entry (never in
  // LLM context) — the wordmark scrolls past like a splash instead of
  // occupying the header, and re-renders on resume where it originally sat.
  pi.registerEntryRenderer?.(OCTOCODE_BANNER_ENTRY_TYPE, (entry, _options, theme) => {
    // Read the session-info snapshot stamped into the entry at append time so
    // the banner shows startup model/thinking without any time-varying bytes.
    const data = entry as { model?: string; provider?: string; thinking?: string } | undefined;
    const sessionInfo: BannerSessionInfo | undefined =
      data?.model || data?.provider || data?.thinking
        ? { model: data.model, provider: data.provider, thinking: data.thinking }
        : undefined;
    return makeRenderer((width) =>
      renderBannerWithTagline(theme as BannerTheme, width, readOwnVersion(getAssetPaths().baseDir), sessionInfo),
    );
  });
  registerContextTools(pi, Type, registeredToolNames, registerUniqueTool, notify);
}

interface TurnMetricsRegistrationArgs {
  pi: PiInstance;
  metricsState: OctocodeMetricsState;
  startMetricsTicker: (ctx: PiContext | undefined) => void;
  stopMetricsTicker: () => void;
  toolStartTimes: Map<string, number>;
}

function registerTurnMetricsPhase({ pi, metricsState, startMetricsTicker, stopMetricsTicker, toolStartTimes }: TurnMetricsRegistrationArgs): void {
  if (typeof pi.on !== 'function') return;
  pi.on('turn_start', async (_event: unknown, ctx: PiContext) => {
    metricsState.activeTurnStartedAt = Date.now();
    updateOctocodeMetricsUi(ctx, metricsState);
    startMetricsTicker(ctx); // live `active`/`session` durations during the turn
  });
  pi.on('turn_end', async (_event: unknown, ctx: PiContext) => {
    stopMetricsTicker();
    // Evict timing entries for tools whose tool_execution_end never fired
    // (aborted turns) — the map otherwise grows for the session lifetime.
    toolStartTimes.clear();
    const now = Date.now();
    if (metricsState.activeTurnStartedAt !== undefined) {
      metricsState.lastTurnMs = now - metricsState.activeTurnStartedAt;
      metricsState.activeTurnStartedAt = undefined;
    }
    metricsState.completedTurns += 1;
    await refreshFooterDirtyState(pi, metricsState); // dirty state may have changed this turn; branch comes from Pi footerData
    updateOctocodeMetricsUi(ctx, metricsState);
  });
}

interface WorkerToolRegistrationArgs {
  pi: PiInstance;
  Type: TypeBoxBuilder;
  registeredToolNames: Set<string>;
  notify: NotifyFn;
  metricsState: OctocodeMetricsState;
}

function registerWorkerToolPhase({ pi, Type, registeredToolNames, notify, metricsState }: WorkerToolRegistrationArgs): AgentInboxRegistration {
  setAgentLedgerMetricsRefreshForUi((ctx) => updateOctocodeMetricsUi(ctx, metricsState));
  registerAgentTools(pi, Type, registeredToolNames, registerUniqueTool);

  // Worker inbox overlay (/octocode-inbox) + desktop notifications; must come
  // after registerAgentTools so the ledger listener seam exists.
  return registerAgentInbox(pi, notify);
}

async function wireOctocodePiExtension(
  pi: PiInstance,
  opts: { promptMode: PromptMode },
): Promise<void> {
  const { promptMode } = opts;
  // Cache the system prompt text: the file doesn't change during a session, so
  // reading it once (lazily on the first before_agent_start) avoids a sync disk
  // read on every turn start across long sessions.
  // Trade-off: if the system prompt file is updated mid-session (e.g. after
  // /octocode-skills-update), the stale cached text persists until session reload.
  // This is intentional — prompt updates take effect on the next Pi session.
  let cachedSystemPromptText: string | null = null;
  let latestAvailableSkills: SkillInfo[] | undefined;
  const cronScheduler = createOctocodeCronScheduler({ pi });
  const metricsState: OctocodeMetricsState = {
    sessionStartedAt: Date.now(),
    completedTurns: 0,
  };
  // Live footer ticker: while a turn is active, re-render the footer every second
  // so `active`/`session` durations advance (they are otherwise only refreshed on
  // turn/session events). Reads are in-memory only (no git/disk per tick); git
  // state is refreshed separately on boundaries. Runs on the shared ui-ticker
  // clock so this and the agent-ledger refresh never double-render the footer
  // from two out-of-phase timers.
  const METRICS_TICK_KEY = 'octocode-metrics';
  const stopMetricsTicker = (): void => setUiTickSubscriber(METRICS_TICK_KEY, undefined);
  // No self-stop guard needed: every site that clears activeTurnStartedAt
  // (turn_end, session_start, session_shutdown) also calls stopMetricsTicker, so
  // the ticker is never left subscribed against an inactive turn.
  const startMetricsTicker = (ctx: PiContext | undefined): void =>
    setUiTickSubscriber(METRICS_TICK_KEY, () => updateOctocodeMetricsUi(ctx, metricsState));
  const toolStartTimes = new Map<string, number>();
  let providerRequestStartedAt: number | undefined;
  // Agent inbox handle: assigned during tool registration, referenced by the
  // session_shutdown hook — its suppress flag must flip BEFORE
  // cleanupSpawnedAgentsForShutdown() kills workers, or the teardown burst of
  // killed/exit ledger events would spam desktop notifications.
  let agentInbox: AgentInboxRegistration | undefined;
  // Model-callable tool names, shared between registration (uniqueness check)
  // and the discovery-file inventory. Builtin overrides register through the
  // same helper as support tools, so no manual pre-seeding is needed.
  const registeredToolNames = new Set<string>();
  // Checkpoint engine is created lazily on first use (input hook / rewind
  // command) so sessions that never prompt pay no shadow-git init cost.
  let checkpointEnginePromise: Promise<CheckpointEngine | undefined> | undefined;
  const getCheckpointEngine = (ctx?: PiContext): Promise<CheckpointEngine | undefined> => {
    checkpointEnginePromise ??= initCheckpointStore(ctx?.cwd ?? process.cwd()).catch(() => undefined);
    return checkpointEnginePromise;
  };
  // Latest session cwd for the AI! watcher (registration happens before any ctx exists).
  let latestSessionCwd: string | undefined;
  let latestSessionUi: PiContext['ui'] | undefined;
  // Feed the watch-mode loop guards: our own edit/write tools and bash runs
  // cause fs events that must not loop back into the agent as AI! prompts.
  const suppressWatchForTool = (event: { toolName?: string; args?: unknown }, ctx: PiContext | undefined): void => {
    const name = event.toolName ?? '';
    if (name === 'bash') {
      markBashActivity();
      return;
    }
    if (name !== 'edit' && name !== 'write') return;
    const args = event.args as { path?: unknown } | undefined;
    if (typeof args?.path === 'string' && args.path.length > 0) {
      markOwnWrite(resolveFilePath(args.path, ctx?.cwd ?? process.cwd()));
    }
  };

  // Register --no-context CLI flag before any session starts so Pi can parse it.
  // default:false → context files load normally (octocode-agent launcher already
  // passes --no-context-files at the pi CLI level for its own sessions).
  // Pass --no-context to suppress AGENTS.md / CLAUDE.md for any single run.
  pi.registerFlag?.('no-context', {
    description: 'Suppress AGENTS.md / CLAUDE.md context files from the system prompt',
    type: 'boolean',
    default: false,
  });

  // Best-effort early disable so weak builtins are absent immediately on load.
  // Real Pi runtimes also re-run this in session_start and after tool registration
  // — the calls are idempotent.
  disableBuiltinTools(pi);

  if (typeof (pi as { on?: unknown }).on === 'function') {
    const hooks = createHookComposer(pi, {
      onError: (error, event, middleware, args) => {
        const ctx = args[1] as PiContext | undefined;
        logInternalError('hook', error, { event, middleware }, ctx);
        notify(ctx, `Octocode hook ${event}/${middleware} failed: ${(error as Error)?.message ?? String(error)}`, 'warning');
      },
    });

    hooks.on('resources_discover', 'bundled-skills', async () => {
      const paths = getAssetPaths();
      const skillPath = existingDirectory(paths.skillsDir);
      return skillPath ? { skillPaths: [skillPath] } : {};
    });

    hooks.on('tool_call', 'octocode-plan-mode-gate', async (event: { toolName?: string }) => planModeToolGate(event.toolName));

    hooks.on('tool_call', 'awareness-lite-lock-gate', async (event: { toolName?: string; input?: Record<string, unknown> }, ctx: PiContext | undefined) => {
      return runAwarenessLitePreEditLockGate(pi, event, ctx);
    });

    // Snapshot every plan mutation into a session CustomEntry (state channel —
    // never rendered, never in LLM context) so /fork and /tree roll plan state
    // back with the conversation instead of leaking the forked-from plan.
    setPlanEntryAppender((steps, rfcPath, decisions) => pi.appendEntry?.(PLAN_ENTRY_TYPE, { version: 1, steps, ...(rfcPath ? { rfcPath } : {}), ...(decisions && decisions.length ? { decisions } : {}) }));

    hooks.on('session_tree', 'octocode-plan-tree-sync', async (_event: unknown, ctx: PiContext | undefined) => {
      // /tree navigation moved the leaf — re-adopt the plan snapshot that was
      // current on the new branch, and re-render the panel with it.
      adoptPlanFromBranch(activePlanScope(ctx), ctx?.sessionManager?.getBranch?.() ?? []);
      refreshStatusPanel(ctx);
    });

    hooks.on('session_start', 'octocode-session-start', async (_event: unknown, ctx: PiContext | undefined) => {
      exitPlanMode(ctx); // a new session never inherits a pending plan gate
      // Undo the shutdown-time suppression from a previous session in this process.
      resumeStatusPanel();
      resumeAwarenessPanel();
      // Re-register the footer for THIS session's ctx/tui/theme (idempotent
      // registration is keyed by ctx; deleting here forces exactly one
      // re-registration per session, e.g. after /new or a theme change).
      if (ctx) footerRegisteredCtxs.delete(ctx);
      setAgentLedgerMetricsRefreshForUi((ctx) => updateOctocodeMetricsUi(ctx, metricsState));
      // Read-states recorded in a previous session must not satisfy the edit
      // tool's stale-read gate in this one, and the auto-compaction edge
      // trigger must not carry the old session's threshold crossing.
      clearAllReadStates();
      resetAutoCompactState();
      // Snapshot the working tree's pre-session dirty set so edit/write can warn
      // before co-mingling changes into peer/user uncommitted work.
      if (ctx?.cwd) {
        const baselineCwd = ctx.cwd;
        // Wire the peer-WIP chip painter BEFORE the async baseline call so it is
        // already registered when setPeerWipBaseline fires its statusPainter callback
        // (the .then() fires as a microtask, but await points above this block could
        // let it race — wiring first eliminates the race entirely).
        if (ctx.hasUI) {
          setPeerWipStatusPainter((count) => {
            ctx.ui?.setStatus?.(
              'octocode-peer-wip',
              count > 0 ? paint(ctx.ui.theme, 'warning', `⚑ ${count} pre-existing dirty`) : undefined,
            );
          });
        }
        void execGitSummary(pi, ['status', '--porcelain'], 800).then((porc) => setPeerWipBaseline(baselineCwd, porc));
      }
      // A new session inherits no compaction state from a previous one in this
      // process: clear the in-flight/resume singletons (TTL is only a backstop),
      // the cross-session checkpoint-card dedupe key, and re-init the checkpoint
      // engine for this session's cwd (it may differ after /new or /resume).
      clearCompactionInFlight();
      clearCompactionResumeRequest();
      resetCompactionResumeSchedule();
      resetCompactionCheckpointDedupe();
      // Sensitive-action "always allow" consent is session-scoped: a new session
      // must re-earn it, never inherit a prior session's approvals.
      resetApprovalStore();
      // Operator/CI can pin the session's starting level (strict|default|relaxed).
      applyStartupPermissionLevel();
      // One banner card per FRESH session. "Fresh" = no conversation yet: the
      // branch is NEVER empty at session_start (pi already appended
      // model_change / thinking_level_change entries), so test for the absence
      // of `message` entries — and of a prior banner, so /resume never doubles it.
      const sessionBranch = (ctx?.sessionManager?.getBranch?.() ?? []) as Array<{ type?: string; customType?: string }>;
      const hasConversation = sessionBranch.some((e) => e?.type === 'message');
      const hasBannerEntry = sessionBranch.some(
        (e) => e?.type === 'custom' && e?.customType === OCTOCODE_BANNER_ENTRY_TYPE,
      );
      if (ctx?.hasUI && typeof pi.registerEntryRenderer === 'function' && !hasConversation && !hasBannerEntry) {
        pi.appendEntry?.(OCTOCODE_BANNER_ENTRY_TYPE, {
          model: ctx?.model?.id,
          provider: ctx?.model?.provider,
          thinking: pi.getThinkingLevel?.(),
        });
      }
      // Force a fresh Awareness poll: never paint a prior session's cached status for this cwd.
      if (ctx?.cwd) clearAwarenessCacheEntry(ctx.cwd);
      checkpointEnginePromise = undefined;
      // Drop dead worker records so the agent ledger reflects only this session.
      pruneDroppableAgentsForSession();
      metricsState.sessionStartedAt = Date.now();
      metricsState.activeTurnStartedAt = undefined;
      metricsState.lastTurnMs = undefined;
      metricsState.completedTurns = 0;
      stopMetricsTicker();
      latestSessionCwd = ctx?.cwd;
      latestSessionUi = ctx?.ui;
      // Branch-correct plan state: adopt the newest octocode-plan snapshot on
      // this session's branch (pi copies entries up to the fork point, so a
      // fork restores exactly the plan that existed there; branches without a
      // snapshot leave disk state alone for back-compat).
      adoptPlanFromBranch(activePlanScope(ctx), ctx?.sessionManager?.getBranch?.() ?? []);
      // Re-apply the persisted effort dial (thinking level + worker cap) before
      // the footer renders so `◉ <level>` is correct from the first frame.
      await restoreDialOnStartup(pi, ctx);
      // Editor autocomplete for @worker/@skill and #plan-step mentions. The
      // registration is internally once-per-process (pi has no removal API).
      if (ctx?.ui) {
        registerOctocodeAutocomplete(ctx.ui, {
          listWorkers: () => listWorkerLedgerEntries(),
          getPlanSteps: () => getPlan(activePlanScope(ctx)),
          listSkills: () => latestAvailableSkills ?? [],
        });
      }
      // Trim shadow-git checkpoint history in the background (keeps 30).
      void getCheckpointEngine(ctx).then((engine) => engine?.prune());
      await refreshFooterDirtyState(pi, metricsState);
      applyOctocodeUi(ctx, pi.getThinkingLevel?.());
      // Seed the footer's prompt-overhead segment before the first turn so the
      // toolbar carries its full data from frame one; before_agent_start
      // refreshes it with the exact per-turn parts (skills, active plan).
      if (cachedSystemPromptText === null) {
        cachedSystemPromptText = readTextIfExists(getAssetPaths().systemPrompt);
      }
      const startupMcpCatalog = getCachedMcpCatalogAddendum(ctx);
      const startupDynamicCatalog = getDynamicCapabilitiesAddendum();
      const startupMcpCounts = getCachedMcpCounts(ctx);
      setHarnessOverhead({
        totalChars: (cachedSystemPromptText?.length ?? 0) + startupMcpCatalog.length + startupDynamicCatalog.length,
        sysChars: cachedSystemPromptText?.length ?? 0,
        mcpChars: startupMcpCatalog.length,
        dynamicChars: startupDynamicCatalog.length,
        mcpServers: startupMcpCounts.servers,
        mcpTools: startupMcpCounts.tools,
        skills: latestAvailableSkills?.length ?? 0,
      });
      updateOctocodeMetricsUi(ctx, metricsState);
      // Surface any disk-restored plan / live agents in the below-editor panel right at launch.
      refreshStatusPanel(ctx);
      // AI Watch: if OCTOCODE_WATCH=1 auto-started the watcher before this TUI
      // session existed, paint the persistent chip now that we have a UI context.
      // /octocode-watch on|off already paints via the setStatus dep for manual toggles.
      if (ctx?.hasUI && isWatchActive()) {
        latestSessionUi?.setStatus?.('octocode-watch', 'watch: on');
      }
      cronScheduler.start(ctx);
      // Announce this session in the shared Awareness Lite agent registry with
      // its generated host-tagged name (fire-and-forget; peers see it via
      // `agent list` and can `message send` to it).
      updateAwarenessLiteRegistry('join', pi, ctx);
      // Ensure ~/.pi/agent/mcp.json has the correct npm_config_cache env vars so
      // Pi's own MCP client can start octocode-mcp with the darwin native addon.
      patchGlobalMcpOctocodeEnv();
      // Full MCP discovery at init: connect every configured server and cache its
      // instructions, tools, and exact input schemas for the <mcp_catalog> block.
      // Fire-and-forget here; before_agent_start awaits it (bounded) so turn 1's
      // system prompt already carries the catalog. Once discovery lands, write
      // the machine-readable inventory (.octocode/discovery.json): all skills +
      // full MCP configuration + native tool surface, for users/peer agents.
      void warmMcpCatalog(ctx).then(() => writeDiscoveryFile(ctx, {
        skills: discoverSkills(ctx?.cwd ?? process.cwd(), latestAvailableSkills),
        nativeTools: [...registeredToolNames],
        // harnessOverhead is already set by setHarnessOverhead() above (same
        // session_start block) so it's always available when this .then() fires.
        overhead: harnessOverhead ?? undefined,
      }));
      // Check for a newer @octocodeai/pi-extension on npm — fire-and-forget, never
      // awaited before the session becomes usable, matching how Pi checks its own
      // version and installed packages (interactive-mode.js#run). Interactive-only:
      // Pi's own checks never run in print/rpc mode either, and ctx.hasUI is false
      // there, so this also skips the npm-view subprocess entirely for scripted use.
      if (ctx?.hasUI) {
        void checkForCoreUpdate(readOwnVersion(getAssetPaths().baseDir)).then((update) => {
          if (!update) return;
          notify(
            ctx,
            `@octocodeai/pi-extension ${update.latestVersion} is available (current: ${update.currentVersion}). Run: octocode-agent update core`,
            'info',
          );
        });
      }
      // Watch mcp.json (global + project) for external edits and hot-reload: drop stale
      // connections + cache and notify the user — no agent restart needed.
      try {
        const watched = startMcpConfigWatcher(ctx, notify);
        if (watched > 0) notify(ctx, `Octocode watching mcp.json for live changes (add/remove/edit apply without restart).`, 'info');
      } catch (error) {
        notify(ctx, `Octocode MCP config watcher failed to start: ${(error as Error)?.message ?? String(error)}`, 'warning');
      }
      // Disable weak built-ins (read/grep/find/ls) in favor of Octocode locals.
      try {
        if (disableBuiltinTools(pi)) {
          notify(
            ctx,
            `Octocode disabled Pi built-ins (${DISABLED_BUILTIN_TOOL_NAMES.join(', ')}); use MCPTool({action:'call',server:'octocode',tool:'...'}) for research. Overrides: ${OVERRIDDEN_BUILTIN_TOOL_NAMES.join(', ')}.`,
            'info',
          );
        }
      } catch (error) {
        notify(
          ctx,
          `Octocode could not disable Pi built-ins: ${(error as Error)?.message ?? String(error)}`,
          'warning',
        );
      }
      try {
        const trusted = ctx?.isProjectTrusted
          ? Boolean(await ctx.isProjectTrusted())
          : false;
        const { applied, skippedProtected } = propagateOctocodeEnv({
          home: getOctocodeHome(),
          cwd: ctx?.cwd ?? process.cwd(),
          trusted,
        });
        if (applied.length > 0) {
          notify(
            ctx,
            `Octocode env: ${applied.join(', ')}`,
            'info',
          );
        }
        if (skippedProtected.length > 0) {
          notify(
            ctx,
            `Octocode env: skipped protected key(s): ${skippedProtected.join(', ')}.`,
            'warning',
          );
        }
      } catch (error) {
        notify(
          ctx,
          `Octocode env load failed: ${(error as Error)?.message ?? String(error)}`,
          'warning',
        );
      }
    });

    // Clean up status labels and spawned workers when the session tears down
    // so they don't leak across /new, /resume, /fork, reload, or quit.
    hooks.on('session_shutdown', 'octocode-session-shutdown', async (_event: SessionShutdownEvent, ctx: PiContext | undefined) => {
      // Best-effort registry departure so peers stop seeing a stale ACTIVE row.
      updateAwarenessLiteRegistry('leave', pi, ctx);
      cronScheduler.stop();
      stopMcpConfigWatchers();
      // Stop the per-second metrics interval (it would otherwise keep firing
      // against the replaced session's stale ctx) and suppress the panels so
      // late async callbacks cannot resurrect widgets after the clears below.
      stopMetricsTicker();
      metricsState.activeTurnStartedAt = undefined;
      suppressStatusPanel();
      suppressAwarenessPanel();
      // Order matters: suppress inbox/desktop notifications BEFORE killing the
      // spawned workers, so the teardown burst of killed/exit ledger events is
      // ignored instead of flashing OSC 9 notifications at the user.
      agentInbox?.shutdown();
      setAgentLedgerMetricsRefreshForUi(undefined);
      stopWatch();
      const cleanedAgents = cleanupSpawnedAgentsForShutdown();
      const stoppedMcpServers = stopAllMcpServers();
      const closedChrome = closeAllChromeConnections();
      if (closedChrome > 0) notify(ctx, `Closed ${closedChrome} cached CDP connection(s).`, 'info');
      if (ctx?.hasUI) {
        ctx.ui?.setStatus?.('octocode', undefined);
        ctx.ui?.setStatus?.('octocode-thinking', undefined);
        ctx.ui?.setStatus?.('agent-wait', undefined);
        ctx.ui?.setStatus?.('chrome-debug', undefined);
        ctx.ui?.setStatus?.('octocode-mcp', undefined);
        ctx.ui?.setStatus?.('octocode-peer-wip', undefined);
        ctx.ui?.setStatus?.('octocode-watch', undefined);
        // Detach the peer-WIP painter and drop the UI ref so async post-session
        // callbacks (e.g. a slow git status) cannot repaint chips after shutdown.
        setPeerWipStatusPainter(undefined);
        latestSessionUi = undefined;
        // Clear the agents ledger status synchronously too; cleanupSpawnedAgentsForShutdown
        // hides the ledger but only defers this clear to later worker-close callbacks.
        ctx.ui?.setStatus?.('octocode-agents', undefined);
        // The unified below-editor panel is now persistent (it always shows the main
        // agent model), so it no longer self-clears via refreshStatusPanel emptiness —
        // clear it explicitly on shutdown.
        ctx.ui?.setWidget?.('octocode-status-panel', undefined);
        ctx.ui?.setFooter?.(undefined);
        footerRegisteredCtxs.delete(ctx);
        ctx.ui?.setWorkingMessage?.(undefined);
        ctx.ui?.setWorkingVisible?.(false);
        if (cleanedAgents > 0) {
          ctx.ui?.notify?.(`Octocode closed ${cleanedAgents} spawned subagent(s).`, 'info');
        }
        if (stoppedMcpServers > 0) {
          ctx.ui?.notify?.(`Octocode stopped ${stoppedMcpServers} MCP server(s).`, 'info');
        }
      }
    });

    hooks.on('model_select', 'octocode-model-select', async (_event: unknown, ctx: PiContext | undefined) => {
      // thinking_level_select fires before model_select when the model change
      // clamps the thinking level, so pi.getThinkingLevel() is already updated.
      applyOctocodeUi(ctx, pi.getThinkingLevel?.());
      // refreshAgentLedgerUi refreshes the footer metrics too (via the wired
      // refresher), so calling updateOctocodeMetricsUi here built the footer
      // twice per model switch.
      refreshAgentLedgerUi(ctx);
    });

    hooks.on('thinking_level_select', 'octocode-thinking-select', async (event: ThinkingLevelEvent, ctx: PiContext | undefined) => {
      applyOctocodeUi(ctx, event.level);
      updateOctocodeMetricsUi(ctx, metricsState);
    });

    let sessionAutoNamed = false;
    hooks.on('input', 'octocode-session-autoname', async (event: { text: string; source?: string; streamingBehavior?: string }, ctx: PiContext | undefined) => {
      // Name the session from the first real user prompt so /resume, the session
      // picker, and the terminal title are readable. Skip steering/extension input.
      if (event.source === 'extension' || event.streamingBehavior === 'steer') return { action: 'continue' as const };
      if (sessionAutoNamed) return { action: 'continue' as const };
      const name = deriveSessionName(event.text ?? '');
      if (name) applyOctocodeUi(ctx, pi.getThinkingLevel?.(), name);
      sessionAutoNamed = true;
      try {
        if (!pi.getSessionName?.() && name) pi.setSessionName?.(name);
      } catch { /* naming is best-effort */ }
      return { action: 'continue' as const };
    });

    hooks.on('input', 'octocode-repo-state-hint', async (event: { text: string; images?: unknown[]; source?: string; streamingBehavior?: string }) => {
      const repoState = await buildRepoStateHint(pi, event);
      if (!repoState) return { action: 'continue' as const };
      return {
        action: 'transform' as const,
        text: `${event.text}\n\n${repoState}`,
        images: event.images,
      };
    });

    // Auto-snapshot the working tree (shadow git) before each real user prompt
    // so /octocode-rewind can restore files. Fire-and-forget inside the hook —
    // it never blocks input. The hook's { action: 'continue' } result is
    // swallowed: the composer merges middleware results by object spread, so
    // returning it here would clobber another input middleware's transform.
    const checkpointInputHook = createCheckpointInputHook({ getEngine: getCheckpointEngine });
    hooks.on('input', 'octocode-checkpoint-snapshot', async (event: { text: string; source?: string; streamingBehavior?: string }, ctx: PiContext | undefined) => {
      await checkpointInputHook(event, ctx);
      return undefined;
    });

    hooks.on('tool_execution_start', 'octocode-tool-error-timing', async (event: { toolCallId?: string; toolName?: string; args?: unknown }, ctx: PiContext | undefined) => {
      const key = event.toolCallId ?? event.toolName;
      if (key) toolStartTimes.set(key, Date.now());
      suppressWatchForTool(event, ctx);
    });

    hooks.on('tool_execution_end', 'octocode-tool-error-log', async (event: { toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean }, ctx: PiContext | undefined) => {
      const key = event.toolCallId ?? event.toolName;
      const startedAt = key ? toolStartTimes.get(key) : undefined;
      if (key) toolStartTimes.delete(key);
      // Re-open the bash suppression window at completion too: a long-running
      // bash command's fs churn lands at the end of the call, not the start.
      if (event.toolName === 'bash') markBashActivity();
      if (!event.isError) return;
      logInternalError('tool_execution_end', new Error(`Tool ${event.toolName ?? 'unknown'} failed`), {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
        result: event.result,
      }, ctx, { severity: 'warning', stack: false });
    });

    hooks.on('before_provider_request', 'octocode-provider-error-timing', async () => {
      providerRequestStartedAt = Date.now();
    });

    hooks.on('after_provider_response', 'octocode-provider-error-log', async (event: { status?: number; headers?: Record<string, string> }, ctx: PiContext | undefined) => {
      const status = Number(event.status);
      const durationMs = providerRequestStartedAt === undefined ? undefined : Date.now() - providerRequestStartedAt;
      providerRequestStartedAt = undefined;
      if (!Number.isFinite(status) || status < 400) return;
      logInternalError('after_provider_response', new Error(`Provider response HTTP ${status}`), {
        status,
        durationMs,
        headers: event.headers,
      }, ctx);
    });

    // Warn-once guards: the strip regexes depend on Pi's exact wording/tags, so a
    // Pi upgrade could make them silently no-op. If a strip is requested but the
    // target markers are still present afterwards, surface it once instead of
    // shipping a double catalog / leaked context in silence.
    let warnedContextDrift = false;
    let warnedSkillsDrift = false;
    hooks.on('before_agent_start', 'octocode-system-prompt', async (event: BeforeAgentStartEvent, ctx: PiContext | undefined) => {
      // Suppress AGENTS.md / CLAUDE.md when --no-context flag is set. Pi builds
      // the prompt BEFORE this hook fires and systemPromptOptions is
      // inspection-only, so the block must be stripped from the assembled
      // prompt text. (octocode-agent sessions also pass --no-context-files to
      // pi, which prevents the block at the source for that path.)
      const noContext = Boolean(pi.getFlag?.('no-context'));
      let piPrompt = event.systemPrompt;
      if (noContext) {
        piPrompt = stripProjectContext(event.systemPrompt);
        if (!warnedContextDrift && piPrompt.includes('<project_context>')) {
          warnedContextDrift = true;
          console.warn('[octocode-pi-extension] --no-context set but <project_context> remains after strip — Pi prompt format may have changed; update stripProjectContext.');
        }
      }

      // Workers that load this extension need Octocode tools, not the full main-agent
      // prompt layered over their typed or caller-provided --append-system-prompt file.
      // NOTE: subagents intentionally skip stripPiSkillsSection below — their prompt is
      // assembled from their own typed/append config, not the main-agent skill flow.
      if (isSubagentProcess()) {
        return piPrompt !== event.systemPrompt ? { systemPrompt: piPrompt } : undefined;
      }

      // Octocode owns the model-facing skill flow (the `skill` tool + the
      // <available_skills> addendum) — deterministically drop Pi's read-based
      // skills section so the model never sees two catalogs or a `read`
      // instruction for a tool this harness removes.
      piPrompt = stripPiSkillsSection(piPrompt);
      if (!warnedSkillsDrift && piPrompt.includes('The following skills provide specialized instructions')) {
        warnedSkillsDrift = true;
        console.warn('[octocode-pi-extension] Pi skills section still present after strip — Pi prompt wording may have changed; update stripPiSkillsSection (the model may see two skill catalogs).');
      }
      const stripped = piPrompt !== event.systemPrompt;

      if (cachedSystemPromptText === null) {
        cachedSystemPromptText = readTextIfExists(getAssetPaths().systemPrompt);
      }
      // Bounded wait for the init-time MCP discovery: the <mcp_catalog> block must
      // be in the FIRST turn's prompt — a catalog that first appears later changes
      // the prompt prefix and busts the provider prompt cache. No-op (cache hit)
      // on every subsequent turn.
      await mcpCatalogReady(ctx);
      const mcpCatalog = getCachedMcpCatalogAddendum(ctx);
      // Live projection of the agent's self-created dynamic tools/skills. Rebuilt every
      // turn from the on-disk registries (no cache/watcher), so it always reflects the
      // latest callTool/callSkill state; empty string when there are none.
      const dynamicCatalog = getDynamicCapabilitiesAddendum();
      // Live projection of Pi-discovered skill names/descriptions. Rebuilt every
      // turn from systemPromptOptions so it survives compaction and reflects
      // skills added/removed by Pi discovery without a watcher.
      latestAvailableSkills = event.systemPromptOptions?.skills;
      const availableSkills = renderAvailableSkillsAddendum(latestAvailableSkills);
      // Compaction-durable task breakdown: re-injected every turn so a plan survives compaction.
      // Bump the staleness counter once per turn first so an idle plan surfaces a nudge.
      const planScope = activePlanScope(ctx);
      bumpPlanTurn(planScope);
      const activePlan = renderActivePlanAddendum(planScope);
      // Live Awareness panel (shared plans/tasks/verify-debt) under the input; async+throttled, never blocks.
      refreshAwarenessPanel(ctx);
      // Render the unified below-editor status panel every turn, independent of awareness, so a
      // persisted plan (or active agents) is always visible under the input if it exists.
      refreshStatusPanel(ctx);
      const prompt = [cachedSystemPromptText, mcpCatalog, dynamicCatalog, availableSkills, activePlan].filter((part) => part.trim().length > 0).join('\n\n');
      // Snapshot the per-turn harness overhead for the toolbar segment. Reuses the
      // strings already built above plus the cached MCP counts — no extra work.
      const mcpCounts = getCachedMcpCounts(ctx);
      setHarnessOverhead({
        totalChars: (cachedSystemPromptText?.length ?? 0) + mcpCatalog.length + dynamicCatalog.length + availableSkills.length + activePlan.length,
        sysChars: cachedSystemPromptText?.length ?? 0,
        mcpChars: mcpCatalog.length,
        dynamicChars: dynamicCatalog.length + availableSkills.length + activePlan.length,
        mcpServers: mcpCounts.servers,
        mcpTools: mcpCounts.tools,
        skills: latestAvailableSkills?.length ?? 0,
      });
      // Even with no Octocode addendum to append, a stripped prompt must still
      // be returned or --no-context silently becomes a no-op.
      if (prompt.trim().length === 0 || !shouldAppendSystemPrompt(piPrompt, prompt)) {
        return stripped ? { systemPrompt: piPrompt } : undefined;
      }
      return {
        systemPrompt: composeSystemPrompt({
          piSystemPrompt: piPrompt,
          octocodePrompt: prompt,
          promptMode,
        }),
      };
    });
  }

  if (pi.registerTool) {
    const { Type } = await import('typebox');

    registerSupportToolPhase({
      pi,
      Type,
      registeredToolNames,
      notify,
      getLatestAvailableSkills: () => latestAvailableSkills,
    });
    registerRuntimeUiPhase({ pi, Type, registeredToolNames, notify });
    registerTurnMetricsPhase({ pi, metricsState, startMetricsTicker, stopMetricsTicker, toolStartTimes });
    agentInbox = registerWorkerToolPhase({ pi, Type, registeredToolNames, notify, metricsState });

    // ── Thinking indicator: bracket the full agent turn ──────────────────────────
    // Registered AFTER all phase hooks so these sit at the END of the turn_start
    // and turn_end handler arrays, never displacing earlier handlers (e.g. the
    // auto-compact handler that tests access via handlers.get('turn_end')![0]).
    // Uses pi.on directly (hooks is defined in the sibling if-block above).
    // Pi auto-shows its working row only during model streaming. Explicitly calling
    // setWorkingVisible(true) on turn_start keeps "Thinking…" visible through tool
    // execution gaps too, so the user always knows the agent is working.
    if (typeof pi.on === 'function') {
      pi.on('turn_start', (_event: unknown, ctx: PiContext | undefined) => {
        if (!ctx?.hasUI) return;
        const ui = ctx.ui;
        if (!ui) return;
        // Keep the working row visible for the full turn, not just during streaming.
        ui.setWorkingVisible?.(true);
        // Swap the status chip to an active indicator so it's clear the agent is busy.
        ui.setStatus?.('octocode-thinking', paint(ui.theme, 'brand', 'thinking…'));
      });
      pi.on('turn_end', (_event: unknown, ctx: PiContext | undefined) => {
        if (!ctx?.hasUI) return;
        const ui = ctx.ui;
        if (!ui) return;
        // Hide the working row when the turn (including all tool calls) is complete.
        ui.setWorkingVisible?.(false);
        // Restore the quiet thinking-level chip (or clear it if unsupported).
        const level = pi.getThinkingLevel?.();
        const status = getThinkingStatus(ctx, level);
        ui.setStatus?.('octocode-thinking', status ? paint(ui.theme, 'dim', status) : undefined);
      });
    }

    // Re-assert disabled builtins after registration so a concurrent setActiveTools
    // (or Pi defaulting the full builtin set) cannot leave read/grep/find/ls active.
    disableBuiltinTools(pi);
  }

  if (!pi.registerCommand) return;

  pi.registerCommand('octocode', {
    description: 'Extension health & setup dashboard: status, tools, setup, skills, health. For live work state use /octocode-now.',
    handler: async (_args, ctx) => {
      notify(ctx, formatOctocodeDashboard(ctx, undefined, formatOctocodeCronSummary(cronScheduler.list())), 'info');
    },
  });

  pi.registerCommand('octocode-now', {
    description: 'Live work cockpit: model, context, permissions, current plan, shared tasks, agents, and git status. For extension health use /octocode.',
    handler: async (_args, ctx) => {
      const level = getPermissionLevel();
      const grants = approvedClasses();
      const permLine = `permissions: ${level} (${PERMISSION_LEVEL_SUMMARY[level]})${grants.length > 0 ? ` · always-allowed: ${grants.join(', ')}` : ''}`;
      notify(ctx, `${await formatOctocodeNow(ctx, pi)}\n${permLine}`, 'info');
    },
  });

  // ─── /octocode-harness — full skill/MCP/tool/prompt inventory ────────────────

  pi.registerCommand('octocode-harness', {
    description: 'Harness inventory: all skills and MCP servers (with sources and tool names), native tools, and prompt overhead breakdown.',
    handler: async (_args, ctx) => {
      const overhead = harnessOverhead;
      const skills = discoverSkills(ctx?.cwd ?? process.cwd(), latestAvailableSkills);
      const mcpSnap = await getMcpDiscoverySnapshot(ctx);
      const tools = [...registeredToolNames].sort((a, b) => a.localeCompare(b));

      // Compact char/token formatters.
      const fc = (n: number): string => n >= 1000 ? `~${(Math.round(n / 100) / 10).toFixed(1)}k` : `${n}`;
      const ft = (chars: number): string => fc(Math.round(chars / 4));

      const lines: string[] = ['Octocode Harness  @octocodeai/pi-extension'];

      // Model / session
      const modelId = (ctx as { model?: { id?: string; provider?: string } } | undefined)?.model;
      if (modelId?.id || pi.getThinkingLevel?.()) {
        const parts = [
          ...(modelId?.id ? [modelId.id] : []),
          ...(modelId?.provider ? [modelId.provider] : []),
          ...(pi.getThinkingLevel?.() ? [`thinking ${pi.getThinkingLevel?.()}`] : []),
        ];
        lines.push('', `Model    ${parts.join(' · ')}`);
      }

      // Prompt overhead
      if (overhead) {
        lines.push(
          '',
          `Prompt   ${ft(overhead.totalChars)} tokens  (${fc(overhead.totalChars)} chars)`,
          `  system   ${fc(overhead.sysChars).padEnd(8)} chars   system prompt + Pi addendum`,
          `  mcp      ${fc(overhead.mcpChars).padEnd(8)} chars   ${overhead.mcpServers} server${overhead.mcpServers !== 1 ? 's' : ''} · ${overhead.mcpTools} tool${overhead.mcpTools !== 1 ? 's' : ''}`,
          `  dynamic  ${fc(overhead.dynamicChars).padEnd(8)} chars   ${overhead.skills} skills · plan · capabilities`,
        );
      }

      // Native tools
      lines.push('', `Native tools  (${tools.length})`);
      // Wrap long tool lists at ~90 chars per line for readability.
      const toolText = tools.join(' · ');
      if (toolText.length <= 88) {
        lines.push(`  ${toolText}`);
      } else {
        // Split into ~90-char chunks at · boundaries.
        const chunks: string[] = [];
        let current = '';
        for (const t of tools) {
          const next = current ? `${current} · ${t}` : t;
          if (next.length > 88 && current) { chunks.push(current); current = t; }
          else { current = next; }
        }
        if (current) chunks.push(current);
        for (const chunk of chunks) lines.push(`  ${chunk}`);
      }

      // Skills
      lines.push('', `Skills  (${skills.length})   ←  load: skill({action:"load", name:"…"})`);
      for (const skill of skills) {
        const descTrunc = skill.description
          ? `  ${skill.description.length > 64 ? `${skill.description.slice(0, 63)}…` : skill.description}`
          : '';
        lines.push(`  ${skill.name.padEnd(32)}[${skill.source}]${descTrunc}`);
      }

      // MCP servers
      lines.push('', `MCP servers  (${mcpSnap.servers.length})`);
      if (mcpSnap.servers.length === 0) {
        lines.push('  (none configured — add via MCPTool action:"add")');
      }
      for (const server of mcpSnap.servers) {
        const tc = server.toolCount !== undefined ? `  (${server.toolCount} tools)` : '';
        lines.push(`  ${server.name}   cmd: ${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}${tc}`);
        if (server.tools?.length) {
          const names = server.tools.map((t) => t.name);
          // Show up to ~8 tool names, then "+ N more".
          const MAX_SHOW = 8;
          const shown = names.slice(0, MAX_SHOW).join(', ');
          const rest = names.length > MAX_SHOW ? `  + ${names.length - MAX_SHOW} more` : '';
          lines.push(`    ${shown}${rest}`);
        }
      }

      // Builtin tool policy (overrides, removed, passthrough)
      const harness = listExtensionHarness();
      if (harness.overriddenBuiltins.length || harness.disabledBuiltins.length) {
        lines.push('', 'Builtin tool policy');
        if (harness.overriddenBuiltins.length)
          lines.push(`  overridden   ${harness.overriddenBuiltins.join(', ')}`);
        if (harness.disabledBuiltins.length)
          lines.push(`  removed      ${harness.disabledBuiltins.join(', ')}`);
        if (harness.passthroughBuiltins.length)
          lines.push(`  passthrough  ${harness.passthroughBuiltins.join(', ')}`);
      }

      // Discovery file pointer
      const discoveryPath = getDiscoveryFilePath(ctx?.cwd ?? process.cwd());
      lines.push('', `Full inventory  ${discoveryPath}`);

      notify(ctx, lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('octocode-profile', {
    description: 'Apply a named Octocode profile from ~/.octocode/profiles.json to this live Pi session: model, tools/excludeTools, and approve mode.',
    getArgumentCompletions: (prefix: string) => listProfileNames()
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ value: name, label: name, description: `/octocode-profile ${name}` })),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        const names = listProfileNames();
        notify(ctx, names.length > 0
          ? `Available profiles: ${names.join(', ')}\nUsage: /octocode-profile <name>`
          : `No profiles found at ${profileFilePath()}. Usage: /octocode-profile <name>`, 'info');
        return;
      }
      const profile = loadProfile(name, getOctocodeHome(process.env));
      if (!profile) {
        notify(ctx, `Profile "${name}" not found in ${profileFilePath()}.`, 'warning');
        return;
      }
      const { lines, warnings } = await applyRuntimeProfile(pi, ctx, name, profile);
      const warningText = warnings.length > 0 ? `\nWarnings:\n- ${warnings.join('\n- ')}` : '';
      notify(ctx, `Applied profile "${name}" live:\n- ${lines.join('\n- ')}${warningText}`, warnings.length > 0 ? 'warning' : 'info');
    },
  });

  pi.registerCommand('octocode-tasks', {
    description: 'Show local plan and shared Awareness task/verification state with guidance on which surface to use.',
    handler: async (_args, ctx) => {
      refreshAwarenessPanel(ctx);
      notify(ctx, formatOctocodeTasks(ctx), 'info');
    },
  });

  pi.registerCommand('octocode-skills', {
    description: 'Show Pi-discovered skills and how to load or install them.',
    handler: async (_args, ctx) => {
      const discoveryPath = getDiscoveryFilePath(ctx?.cwd ?? process.cwd());
      notify(ctx, renderSkillsDashboard(latestAvailableSkills, {
        usageLines: formatSkillUsageLines(),
        discoveryPath: fs.existsSync(discoveryPath) ? discoveryPath : undefined,
      }), 'info');
    },
  });

  pi.registerCommand('octocode-chrome', {
    description: 'List or close reused CDP connections: /octocode-chrome [list|close].',
    getArgumentCompletions: (prefix: string) => ['list', 'close']
      .filter((s) => s.startsWith(prefix))
      .map((s) => ({ value: s, label: s, description: `octocode-chrome ${s}` })),
    handler: async (args, ctx) => {
      const arg = String(args ?? '').trim().toLowerCase() || 'list';
      if (arg === 'close') {
        const n = closeAllChromeConnections();
        notify(ctx, `Closed ${n} cached CDP connection(s).`, 'info');
        return;
      }
      const sessions = listCDPSessions();
      if (sessions.length === 0) { notify(ctx, 'No cached CDP connections.', 'info'); return; }
      const lines = sessions.map((s) =>
        `• :${s.port} ${s.mode} target=${s.targetId.slice(0, 8)} uses=${s.uses} idle=${Math.round(s.idleMs / 1000)}s ${s.closed ? '(closed)' : ''} ${s.url}`,
      );
      notify(ctx, `Cached CDP connections (${sessions.length}):\n${lines.join('\n')}`, 'info');
    },
  });

  pi.registerCommand('octocode-theme', {
    description: 'Apply an Octocode theme: /octocode-theme [sync|dark|light]. sync follows the system appearance (macOS) or terminal background (COLORFGBG).',
    getArgumentCompletions: (prefix: string) => ['sync', 'dark', 'light']
      .filter((s) => s.startsWith(prefix))
      .map((s) => ({ value: s, label: s, description: `octocode-${s === 'sync' ? 'dark|light (auto)' : s}` })),
    handler: async (args, ctx) => {
      const arg = String(args ?? '').trim().toLowerCase() || 'sync';
      let themeName: OctocodeThemeName | null;
      if (arg === 'dark') themeName = OCTOCODE_THEME_DARK;
      else if (arg === 'light') themeName = OCTOCODE_THEME_LIGHT;
      else {
        // sync: cross-platform detection. macOS via AppleInterfaceStyle; other
        // platforms via the terminal's COLORFGBG background code. Undetectable
        // (e.g. Linux without COLORFGBG) => keep the current theme, don't force light.
        let appleInterfaceStyle = '';
        if (process.platform === 'darwin' && pi.exec) {
          try {
            const r = await pi.exec('defaults', ['read', '-g', 'AppleInterfaceStyle'], { timeout: 1500 });
            if (r?.code === 0) appleInterfaceStyle = r.stdout.trim();
          } catch { /* key unset in light mode */ }
        }
        themeName = resolveSystemThemeName({
          platform: process.platform,
          appleInterfaceStyle,
          colorfgbg: process.env['COLORFGBG'],
        });
        if (!themeName) {
          notify(ctx, 'Could not detect system appearance on this platform. Use /octocode-theme dark|light.', 'warning');
          return;
        }
      }
      const result = ctx.ui?.setTheme?.(themeName);
      if (result && result.success === false) notify(ctx, `Could not apply ${themeName}: ${result.error ?? 'unknown error'}`, 'error');
      else notify(ctx, `Applied ${themeName}.`, 'info');
    },
  });

  pi.registerCommand('octocode-footer', {
    description: 'Set footer density (compact | default | full) or show the segment legend (legend).',
    getArgumentCompletions: (prefix: string) => (['compact', 'default', 'full', 'legend'] as const)
      .filter((mode) => mode.startsWith(prefix))
      .map((mode) => ({ value: mode, label: mode, description: `/octocode-footer ${mode}` })),
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === 'legend') {
        // The footer vocabulary is terse by design — this is its decoder ring.
        notify(ctx, `Footer legend:\n${FOOTER_LEGEND.map(([seg, meaning]) => `  ${seg} — ${meaning}`).join('\n')}`, 'info');
        return;
      }
      if (requested.length > 0) {
        const density = parseFooterDensity(requested);
        if (!density) {
          notify(ctx, `Unknown footer density "${requested}". Usage: /octocode-footer [compact|default|full|legend]`, 'warning');
          return;
        }
        setFooterDensity(density);
        updateOctocodeMetricsUi(ctx, metricsState);
      }
      notify(ctx, `Footer density: ${getFooterDensity()} · /octocode-footer legend explains each segment`, 'info');
    },
  });

  // shift+tab (Claude Code's mode-cycle key) maps to pi's RESERVED
  // app.thinking.cycle — extension shortcuts on reserved keys are silently
  // skipped at resolution, so the default must be an unbound key. Users who
  // remap app.thinking.cycle in keybindings.json can set
  // OCTOCODE_PERMISSIONS_KEY=shift+tab and it will win the key.
  const permissionsKey = process.env['OCTOCODE_PERMISSIONS_KEY'] || 'ctrl+shift+a';

  pi.registerCommand('octocode-permissions', {
    description: 'Session approval controls: show the permission level and always-allowed classes, set the level (strict|default|relaxed), or revoke remembered approvals.',
    getArgumentCompletions: (prefix: string) => [
      ...PERMISSION_LEVELS.map((level) => ({ value: `level ${level}`, label: `level ${level}`, description: `/octocode-permissions level ${level}` })),
      { value: 'revoke all', label: 'revoke all', description: 'forget every always-allow' },
      ...APPROVAL_CLASSES.map((cls) => ({ value: `revoke ${cls}`, label: `revoke ${cls}`, description: `re-prompt for ${cls}` })),
    ].filter((item) => item.value.startsWith(prefix)),
    handler: async (args, ctx) => {
      const [verb, value] = args.trim().split(/\s+/);
      if (verb === 'level') {
        const level = parsePermissionLevel(value);
        if (!level) {
          notify(ctx, `Unknown level "${value ?? ''}". Usage: /octocode-permissions level [strict|default|relaxed]`, 'warning');
          return;
        }
        setPermissionLevel(level);
      } else if (verb === 'revoke') {
        if (value === 'all') {
          approvedClasses().forEach(revokeAlways);
        } else if ((APPROVAL_CLASSES as readonly string[]).includes(value ?? '')) {
          revokeAlways(value as ApprovalClass);
        } else {
          notify(ctx, `Unknown class "${value ?? ''}". Usage: /octocode-permissions revoke [all|${APPROVAL_CLASSES.join('|')}]`, 'warning');
          return;
        }
      } else if (verb) {
        notify(ctx, 'Usage: /octocode-permissions [level strict|default|relaxed] [revoke all|<class>]', 'warning');
        return;
      }
      const remembered = approvedClasses();
      const rememberedStr = remembered.length > 0 ? remembered.join(', ') : 'none';
      const level = getPermissionLevel();
      notify(ctx, `Permission level: ${level} (${PERMISSION_LEVEL_SUMMARY[level]}) · always-allowed this session: ${rememberedStr} · ${permissionsKey} cycles the level`, 'info');
    },
  });

  // Cycle the permission level from the keyboard (Claude Code muscle memory —
  // its shift+tab; see the reserved-key note above for why ours defaults to
  // ctrl+shift+a). Best-effort like the palette shortcut: host rejection
  // degrades to command-only (/octocode-permissions).
  try {
    if (typeof pi.registerShortcut === 'function') {
      pi.registerShortcut(permissionsKey, {
        description: 'Cycle the Octocode permission level (default → relaxed → strict)',
        handler: async (ctx: PiContext | undefined) => {
          const level = cyclePermissionLevel();
          updateOctocodeMetricsUi(ctx, metricsState);
          notify(ctx, `Permissions: ${level} — ${PERMISSION_LEVEL_SUMMARY[level]}`, level === 'relaxed' ? 'warning' : 'info');
        },
      });
    }
  } catch {
    // Restricted built-in on that key — the slash command still covers it.
  }

  pi.registerCommand('octocode-status', {
    description: 'Show Octocode Pi extension assets, tools, CLI, bundled skills, and per-turn prompt budget.',
    handler: async (_args, ctx) => {
      const budget = formatPromptBudget([
        { label: 'static system prompt', text: readTextIfExists(getAssetPaths().systemPrompt) },
        { label: 'mcp catalog', text: getCachedMcpCatalogAddendum(ctx) },
        { label: 'dynamic capabilities', text: getDynamicCapabilitiesAddendum() },
        { label: 'available skills', text: renderAvailableSkillsAddendum(latestAvailableSkills) },
        { label: 'active plan', text: renderActivePlanAddendum(activePlanScope(ctx)) },
      ]);
      notify(ctx, `${formatStatus()}\n\n${budget}`, 'info');
    },
  });

  // octocode-harness is registered earlier with the full inventory view.

  pi.registerCommand('octocode-plan', {
    description: `Plan mode (new <goal>), or show/complete/start/remove/clear the active task plan (usage: ${OCTOCODE_PLAN_COMMAND_USAGE}).`,
    getArgumentCompletions: (prefix) => OCTOCODE_PLAN_COMMAND_COMPLETIONS
      .filter((cmd) => cmd.startsWith(prefix))
      .map((cmd) => ({ value: cmd, label: cmd.trim(), description: `/octocode-plan ${cmd}` })),
    handler: async (args, ctx) => {
      const send = typeof pi.sendUserMessage === 'function'
        ? (text: string) => pi.sendUserMessage!(text, { deliverAs: 'followUp' })
        : undefined;
      await handleOctocodePlanCommand(args, ctx, notify, send);
    },
  });
  pi.registerCommand('octocode-agents', {
    description: `Show, refresh, inspect, prune, hide, or kill Octocode spawned worker agents (usage: ${OCTOCODE_AGENTS_COMMAND_USAGE}).`,
    getArgumentCompletions: (prefix: string) => {
      return OCTOCODE_AGENTS_COMMAND_COMPLETIONS
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s.trim(), description: OCTOCODE_AGENTS_COMMAND_DESCRIPTIONS[s] }));
    },
    handler: async (args, ctx) => {
      await handleOctocodeAgentsCommand(args, ctx);
    },
  });

  const cronCommand: CommandDefinition = {
    description: `List, check, or cancel Octocode session jobs (usage: ${OCTOCODE_CRON_COMMAND_USAGE}).`,
    getArgumentCompletions: (prefix: string) => {
      return OCTOCODE_CRON_COMMAND_COMPLETIONS
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s, description: `/octocode-cron ${s}` }));
    },
    handler: async (args, ctx) => {
      await handleOctocodeCronCommand(args, ctx, cronScheduler, notify);
    },
  };
  pi.registerCommand('octocode-cron', cronCommand);
  pi.registerCommand('cron', {
    ...cronCommand,
    description: `Alias for /octocode-cron — list, check, or cancel Octocode session jobs (usage: ${OCTOCODE_CRON_COMMAND_USAGE}).`,
  });

  const mcpCommand: CommandDefinition = {
    description: 'Inspect/manage configured MCP servers (usage: /octocode-mcp [status|config|list|stop] [server]). Config: .pi/agent/mcp.json or ~/.pi/agent/mcp.json.',
    getArgumentCompletions: (prefix: string) => {
      return ['status', 'config', 'list', 'stop']
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s, description: `/octocode-mcp ${s}` }));
    },
    handler: async (args, ctx) => {
      await handleOctocodeMcpCommand(args, ctx, notify);
    },
  };
  pi.registerCommand('octocode-mcp', mcpCommand);
  pi.registerCommand('mcp', {
    ...mcpCommand,
    description: `Alias for /octocode-mcp — ${mcpCommand.description}`,
  });

  pi.registerCommand('octocode-setup', {
    description:
      'Install the Octocode APPEND_SYSTEM.md block into .pi or ~/.pi/agent. ' +
      'Only needed for plain-Pi sessions that do not load this extension — when the extension is active, the system prompt is injected at runtime (marker-guarded) and setup is optional.',
    getArgumentCompletions: (prefix: string) => {
      return ['project', 'global']
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({
          value: s,
          label: s,
          description: s === 'project' ? 'Install in project .pi/' : 'Install in ~/.pi/agent/',
        }));
    },
    handler: async (args, ctx) => {
      await installAppendSystem(args, ctx);
    },
  });

  pi.registerCommand('octocode-skills-update', {
    description: 'Update this Pi package, then reload Pi resources.',
    handler: async (_args, ctx) => {
      if (!ctx?.hasUI) {
        notify(ctx, '/octocode-skills-update requires an interactive session to confirm. Run from the Pi UI.', 'error');
        return;
      }
      const source = getInstallSource();
      const cmdStr = `pi update ${source}`;
      const ok = await confirm(ctx, 'Update Octocode Pi package?', `Execute: ${cmdStr}`);
      if (!ok) {
        notify(ctx, 'Command cancelled.', 'info');
        return;
      }
      pi.sendUserMessage(cmdStr, { deliverAs: 'followUp' });
      if (ctx?.reload) await ctx.reload();
    },
  });

  // ─── Modern-TUI feature commands (palette / dial / watch / rewind / export) ──

  // Palette: no-arg commands are auto-discovered via pi.getCommands(); list here
  // only the arg-taking ones (they get an editor prefill instead of a dispatch).
  registerCommandPalette(pi, {
    commands: [
      { name: 'octocode-harness', description: 'Harness inventory: skills, MCPs, tools, prompt overhead' },
      { name: 'octocode-plan', description: 'Plan mode (new <goal>) / manage the active task plan', takesArgs: true },
      { name: 'octocode-agents', description: 'Inspect spawned worker agents', takesArgs: true },
      { name: 'octocode-cron', description: 'Manage Octocode session jobs', takesArgs: true },
      { name: 'octocode-mcp', description: 'Inspect or manage MCP servers', takesArgs: true },
      { name: 'octocode-theme', description: 'Switch the Octocode theme', takesArgs: true },
      { name: 'octocode-chrome', description: 'List or close CDP connections', takesArgs: true },
      { name: 'octocode-dial', description: 'Set the effort dial level', takesArgs: true },
      { name: 'octocode-watch', description: 'Toggle AI! comment watch mode', takesArgs: true },
      { name: 'octocode-rewind', description: 'Restore a file checkpoint', takesArgs: true },
      { name: 'octocode-export', description: 'Brand a session HTML export', takesArgs: true },
    ],
  });
  registerDialCommand(pi);
  registerAiWatch(pi, {
    cwd: () => latestSessionCwd ?? process.cwd(),
    // Paint/clear the 'watch: on' chip on every startWatch/stopWatch transition.
    setStatus: (text) => latestSessionUi?.setStatus?.('octocode-watch', text),
  });
  registerRewindCommand(pi, { getEngine: getCheckpointEngine, notify });
  registerExportCommand(pi);
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Factory: returns the `(pi) => {...}` wiring function Pi invokes as `default(pi)`.
 * `export default createOctocodePiExtension()` preserves the historical single-arg
 * default-export contract exactly; the octocode-agent launcher opts into octocode-first
 * mode.
 */
export function createOctocodePiExtension(
  options: OctocodePiExtensionOptions = {},
): (pi: PiInstance) => Promise<void> {
  const promptMode = resolvePromptMode(options.promptMode);
  return async function octocodePiExtension(pi: PiInstance): Promise<void> {
    return wireOctocodePiExtension(pi, { promptMode });
  };
}

// Default export preserves the historical single-arg contract: Pi calls `default(pi)`.
export default createOctocodePiExtension();
