import fs from 'node:fs';
import path from 'node:path';
import { propagateOctocodeEnv, getOctocodeHome } from './env.js';
import {
  DISABLED_BUILTIN_TOOL_NAMES,
  OVERRIDDEN_BUILTIN_TOOL_NAMES,
  OCTOCODE_SUPPORT_TOOL_NAMES,
} from './constants.js';
import { checkForCoreUpdate, readOwnVersion } from './core-update-check.js';
import {
  getAssetPaths,
  readTextIfExists,
  listBundledSkills,
  getInstallSource,
  getAwarenessCLIPath,
} from './assets.js';

// Expose the Awareness CLI path as an env var so agents can invoke it from bash subprocesses.
// Set once at module load — inherited by all bash subprocesses spawned during the session.
process.env.OCTOCODE_AWARENESS_CLI = getAwarenessCLIPath();
import {
  shouldAppendSystemPrompt,
  mergeManagedAppendSystem,
  resolvePromptMode,
  composeSystemPrompt,
  stripProjectContext,
} from './prompt.js';
import {
  parseSetupScope,
  getAppendSystemTarget,
} from './utils.js';
import { registerUniqueTool } from './tools/octocode-tools.js';
import { registerContextTools, resetAutoCompactState } from './tools/context-tools.js';
import { registerCompactionHooks } from './tools/compaction-hooks.js';
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
} from './tools/agent-tools.js';
import { registerWebTool } from './tools/web-tool.js';
import { registerChromeDebugTool } from './tools/chrome-debug-tool.js';
import { registerBrowserAgentTool } from './tools/browser-agent-tool.js';
import { registerSpawnSubagentTool } from './tools/spawn-subagent-tool.js';
import { registerCallTool } from './tools/call-tool.js';
import { registerCallSkill } from './tools/call-skill.js';
import { registerEditTool } from './tools/edit-tool.js';
import { registerWriteTool } from './tools/write-tool.js';
import { registerBashTool } from './tools/bash-tool.js';
import { getCachedMcpCatalogAddendum, handleOctocodeMcpCommand, patchGlobalMcpOctocodeEnv, registerMcpTool, startMcpConfigWatcher, stopAllMcpServers, stopMcpConfigWatchers, warmMcpCatalog } from './tools/mcp-tool.js';
import { getDynamicCapabilitiesAddendum } from './tools/dynamic-catalog.js';
import { renderAvailableSkillsAddendum, renderSkillsDashboard } from './tools/skill-catalog.js';
import { registerPlanTool } from './tools/plan-tool.js';
import { registerAskUserTool } from './tools/ask-user-tool.js';
import { registerMemoryTool } from './tools/memory-tool.js';
import { activePlanScope, renderActivePlanAddendum, getPlan, bumpPlanTurn } from './tools/active-plan.js';
import { getCachedAwarenessStatus, refreshAwarenessPanel, suppressAwarenessPanel, resumeAwarenessPanel } from './tools/awareness-status.js';
import { refreshStatusPanel, suppressStatusPanel, resumeStatusPanel } from './tools/status-panel.js';
import { buildFooterSegments, buildWorkingIndicator, buildWorkingMessage, resolveSystemThemeName, deriveSessionName, OCTOCODE_THEME_DARK, OCTOCODE_THEME_LIGHT, type OctocodeThemeName } from './ui-extras.js';
import { contextGauge, paint } from './tui/palette.js';
import { listCDPSessions, closeAllChromeConnections } from './chrome-connection-cache.js';
import { handleOctocodePlanCommand, OCTOCODE_PLAN_COMMAND_USAGE, OCTOCODE_PLAN_COMMAND_COMPLETIONS } from './tools/plan-tool.js';
import { atomicWriteUtf8, clearAllReadStates, resolveFilePath } from './tools/file-state.js';
import { registerAgentInbox, type AgentInboxRegistration } from './tools/agent-inbox.js';
import { registerCommandPalette } from './tools/command-palette.js';
import { registerOctocodeAutocomplete } from './tools/autocomplete-providers.js';
import { registerOctocodeMessageRenderers } from './tools/custom-messages.js';
import { initCheckpointStore, type CheckpointEngine } from './tools/checkpoints.js';
import { createCheckpointInputHook, registerRewindCommand } from './tools/rewind-command.js';
import { registerDialCommand, restoreDialOnStartup, getActiveDialLevel } from './tools/effort-dial.js';
import { registerAiWatch, markOwnWrite, markBashActivity, stopWatch } from './tools/ai-watch.js';
import { registerExportCommand } from './tools/export-command.js';
import { assertPathAllowed } from './tools/path-guard.js';
import { makeRenderer, truncateToWidth } from './tools/render-helpers.js';
import { renderBannerWithTagline, type BannerTheme } from './branding/banner.js';
import { pickProvider } from './web.js';
import { createHookComposer } from './hook-composer.js';
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
  PiUi,
  OctocodePiExtensionOptions,
  PromptMode,
  SessionShutdownEvent,
  ThinkingLevelEvent,
  SkillInfo,
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
export { getAssetPaths, readTextIfExists, listBundledSkills, getInstallSource, getAwarenessCLIPath } from './assets.js';
export {
  buildSurfaceSpec,
  loadProfile,
  profileToPiArgs,
  resolveAwarenessCli,
} from './surfaces.js';
export type { Profile, SurfaceSpec, SurfaceVerb } from './surfaces.js';
export {
  shouldAppendSystemPrompt,
  renderSystemPromptAddendum,
  renderManagedAppendSystem,
  mergeManagedAppendSystem,
  resolvePromptMode,
  composeSystemPrompt,
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

export function getThinkingStatus(ctx: PiContext | undefined, level?: string): string {
  const model = ctx?.model;
  if (!model) return 'thinking: unknown model';
  if (!model.reasoning)
    return `thinking: off (${model.id ?? 'model'} has reasoning:false)`;
  return `thinking: ${level ?? 'default'} (${model.id ?? 'model'})`;
}

export interface OctocodeMetricsState {
  sessionStartedAt: number;
  activeTurnStartedAt?: number;
  lastTurnMs?: number;
  completedTurns: number;
  /** Whether the working tree was dirty at the last git refresh. Branch comes from Pi footerData. */
  gitDirty?: boolean;
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

function formatContextUsage(ctx: PiContext | undefined): { text: string; percent?: number } {
  const usage = ctx?.getContextUsage?.();
  if (!usage || usage.contextWindow <= 0) return { text: 'ctx n/a' };
  // tokens is null right after compaction ("unknown", per Pi's ContextUsage).
  if (usage.tokens == null) return { text: 'ctx …' };
  const percent = Math.round((usage.tokens / usage.contextWindow) * 100);
  const { bar } = contextGauge(percent, 10);
  return {
    text: `ctx ${bar} ${percent}% (${formatCompactNumber(usage.tokens)}/${formatCompactNumber(usage.contextWindow)})`,
    percent,
  };
}

interface WorkerFooterCounts {
  /** Live workers (starting / running / idle). */
  active: number;
  /** Workers waiting on the lead (normalized [BLOCKED]). */
  blocked: number;
  /** Workers that failed / crashed. */
  failed: number;
}

function workerFooterCounts(): WorkerFooterCounts {
  const counts: WorkerFooterCounts = { active: 0, blocked: 0, failed: 0 };
  try {
    for (const e of listWorkerLedgerEntries()) {
      if (e.status === 'failed' || e.normalizedStatus === 'failed') counts.failed += 1;
      else if (e.normalizedStatus === 'blocked') counts.blocked += 1;
      if (e.status === 'running' || e.status === 'idle' || e.status === 'starting') counts.active += 1;
    }
  } catch {
    return { active: 0, blocked: 0, failed: 0 };
  }
  return counts;
}

function updateOctocodeMetricsUi(ctx: PiContext | undefined, state: OctocodeMetricsState, now = Date.now()): void {
  if (!ctx?.hasUI) return;

  // The consolidated branded footer is the SINGLE metrics surface — context /
  // tokens / turns / timing / agents / git. Plan stays in the below-editor panel.
  // were also pushed to a top `octocode-metrics` status line — removed as
  // on-screen redundancy.)
  const usage = ctx.getContextUsage?.() ?? { tokens: 0, contextWindow: 0 };
  const workers = workerFooterCounts();
  const awarenessAgents = getCachedAwarenessStatus(ctx.cwd ?? process.cwd())?.agentCount ?? 0;
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
    agentDoing,
    awarenessAgents,
    blockedWorkers: workers.blocked,
    failedWorkers: workers.failed,
    dial: getActiveDialLevel(),
    branch: undefined,
    dirty: state.gitDirty ?? false,
  });
  ctx.ui?.setFooter?.((tui: unknown, theme, footerData) => {
    const renderer = makeRenderer((width) => {
      const branch = footerData?.getGitBranch?.();
      const renderedSegments = branch
        ? [...segments, { text: `${branch}${state.gitDirty ? '*' : ''}` }]
        : segments;
      const brand = theme.fg('accent', theme.bold('\u25c6 Octocode'));
      const sep = theme.fg('dim', '  \u00b7  ');
      const body = renderedSegments.map((s) => paint(theme, s.token ?? 'dim', s.text)).join(sep);
      return [truncateToWidth(`${brand}  ${body}`, width)];
    });
    const unsubscribe = footerData?.onBranchChange?.(() => {
      renderer.invalidate();
      (tui as { requestRender?: () => void } | undefined)?.requestRender?.();
    });
    return {
      ...renderer,
      dispose: () => unsubscribe?.(),
    };
  });

  // Live token count beside the working spinner during an active turn.
  if (state.activeTurnStartedAt !== undefined) {
    ctx.ui?.setWorkingMessage?.(buildWorkingMessage({ startedAt: state.activeTurnStartedAt, now }, ctx.ui?.theme));
  }
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

async function runAwarenessLitePreEditLockGate(pi: PiInstance, event: { toolName?: string; input?: Record<string, unknown> }, ctx?: PiContext): Promise<{ block?: boolean; reason?: string } | void> {
  const toolName = String(event.toolName ?? '').toLowerCase();
  if (!LITE_LOCK_GATE_WRITE_TOOLS.has(toolName)) return undefined;
  if (!pi.exec) return undefined;
  const cwd = ctx?.cwd ?? process.cwd();
  const args = [
    getAwarenessCLIPath(),
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
  ];
  const result = await pi.exec(process.execPath, args, { timeout: 5000 });
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
  state.gitDirty = (await execGitSummary(pi, ['status', '--porcelain'], 600)) !== '';
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

const BELOW_EDITOR_WIDGET_DEFAULT = Symbol.for('octocode.pi-extension.belowEditorWidgetDefault');

type PiUiWithWidgetDefault = PiUi & { [BELOW_EDITOR_WIDGET_DEFAULT]?: true };

function preferBelowEditorWidgets(ui: PiUi | undefined): void {
  const target = ui as PiUiWithWidgetDefault | undefined;
  if (!target?.setWidget || target[BELOW_EDITOR_WIDGET_DEFAULT]) return;
  const originalSetWidget = target.setWidget.bind(target);
  target.setWidget = (name, content, opts) =>
    originalSetWidget(name, content, { placement: 'belowEditor', ...opts });
  target[BELOW_EDITOR_WIDGET_DEFAULT] = true;
}

export function applyOctocodeUi(ctx: PiContext | undefined, level?: string, contextTitle?: string): void {
  // setStatus / setHiddenThinkingLabel are TUI-only; guard with hasUI.
  if (!ctx?.hasUI) return;
  const ui = ctx?.ui;
  if (!ui) return;
  preferBelowEditorWidgets(ui);
  const title = deriveSessionName(contextTitle ?? '');
  const windowTitle = title ? `Octocode · ${title}` : 'Octocode';
  const headerTitle = title ? `◆ ${title}` : '◆ Octocode';
  const shortcutsLine = 'Ask → inspect → edit → verify · /octocode dashboard · /octocode-plan tasks · /octocode-agents workers';
  ui.setHiddenThinkingLabel?.('Octocode thinking');
  ui.setTitle?.(windowTitle);
  ui.setHeader?.((_tui: unknown, theme) => makeRenderer((width) => {
    // Named sessions lead with the title; fresh sessions lead with the wordmark banner.
    const head = title
      ? [truncateToWidth(theme.fg('accent', theme.bold(headerTitle)), width)]
      : renderBannerWithTagline(theme as BannerTheme, width);
    return [...head, truncateToWidth(theme.fg('dim', shortcutsLine), width)];
  }));
  const label = ui.theme?.fg ? ui.theme.fg('accent', '◆ Octocode') : '◆ Octocode';
  ui.setStatus?.('octocode', label);
  const thinkingStatus = getThinkingStatus(ctx, level);
  ui.setStatus?.(
    'octocode-thinking',
    ui.theme?.fg ? ui.theme.fg('dim', thinkingStatus) : thinkingStatus,
  );
  // Glyph-only indicator + branded message: Pi renders these side-by-side,
  // so keeping "Octocode" out of the frames avoids "Octocode Octocode …".
  const t = ui.theme;
  ui.setWorkingIndicator?.(buildWorkingIndicator(t));
  // Custom working message shown during agent streaming. The animated frames
  // supply motion; the text is just the branded verb (no time/tokens — those
  // live in the footer). The live ticker replaces this with the animated
  // "Thinking."/".."/"..." label once a turn is active.
  ui.setWorkingMessage?.(buildWorkingMessage(undefined, t));
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

export function logInternalError(
  source: string,
  error: unknown,
  details: Record<string, unknown> = {},
  ctx?: PiContext,
): void {
  try {
    const logPath = getInternalErrorLogPath(ctx?.cwd ?? process.cwd());
    const normalized = normalizeError(error);
    const durationMs = typeof details['durationMs'] === 'number' ? details['durationMs'] : undefined;
    const redactedDetails = Object.keys(details).length > 0 ? safeJson(details) : '';
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      [
        '=== Octocode Pi Extension Error ===',
        `timestamp: ${new Date().toISOString()}`,
        `uptimeMs: ${Math.round(process.uptime() * 1000)}`,
        `source: ${source}`,
        durationMs === undefined ? '' : `durationMs: ${durationMs}`,
        ...formatContextForLog(ctx),
        normalized.name ? `error.name: ${normalized.name}` : '',
        `error.message: ${normalized.message}`,
        normalized.cause ? `error.cause: ${normalized.cause}` : '',
        redactedDetails ? `details: ${redactedDetails}` : '',
        normalized.stack ? `stack:\n${normalized.stack}` : '',
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
    `awareness lite CLI: ${getAwarenessCLIPath(baseDir)} — use via: node $OCTOCODE_AWARENESS_CLI <command> [action] --workspace "$PWD"`,
    `management CLI: npx octocode skill | lsp-server | auth (no bundled CLI — use npx octocode for management tasks)`,
    `disabled/replaced built-ins: overridden: ${OVERRIDDEN_BUILTIN_TOOL_NAMES.join(', ')}${DISABLED_BUILTIN_TOOL_NAMES.length ? `; removed: ${DISABLED_BUILTIN_TOOL_NAMES.join(', ')}` : ''}`,
    `web search: ${searchStatus}`,
    `internal error log: ${getInternalErrorLogPath(process.cwd())}`,
    `package assets: ${paths.baseDir}`,
    `flags: --no-context (suppress AGENTS.md/CLAUDE.md context files for this run)`,
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
      '/octocode-inbox',
      '/octocode-palette',
      '/octocode-rewind',
      '/octocode-dial',
      '/octocode-watch',
      '/octocode-export',
    ],
    skills: listBundledSkills(baseDir),
    cliNote: `management: npx octocode skill | lsp-server | auth (no bundled CLI — use npx octocode for management tasks)`,
    awarenessCliNote: `bundled Awareness Lite CLI at ${getAwarenessCLIPath(baseDir)} — run via: node $OCTOCODE_AWARENESS_CLI <command> [action] --workspace "$PWD"`,
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
    '◆ Octocode dashboard',
    '',
    'Status',
    `${promptOk ? '✓' : '⚠'} system prompt: ${promptOk ? 'found' : 'missing'}`,
    `✓ tools: ${formatOctocodeToolStatus()}`,
    `✓ metrics: ${context.text}`,
    `Awareness Lite: node $OCTOCODE_AWARENESS_CLI <command> [action] --workspace "$PWD" (${awarenessCliPath})`,
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
    '',
    'Skills',
    `${skills.length} bundled: ${skills.join(', ') || '(none)'}`,
    '',
    'Health',
    ...(warnings.length > 0 ? warnings : ['✓ no dashboard warnings']),
    '',
    'Next actions',
    '/octocode-palette · /octocode-now · /octocode-tasks · /octocode-skills · /octocode-agents · /octocode-inbox · /octocode-cron · /octocode-dial · /octocode-watch · /octocode-status',
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
  return [
    `shared tasks: plans ${status.activePlans} · ready ${status.readyTasks} · doing ${status.inProgressTasks}`,
    `verify debt: ${status.verifyTasks} · locks ${status.lockCount} · work ${status.workCount}`,
  ];
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
    'Commands: /octocode-plan · node $OCTOCODE_AWARENESS_CLI status --workspace "$PWD"',
  ].join('\n');
}

export async function formatOctocodeNow(ctx: PiContext | undefined, pi: PiInstance): Promise<string> {
  refreshAwarenessPanel(ctx);
  const repoStatus = await execGitSummary(pi, ['status', '--short', '--branch'], 800);
  return [
    '◆ Octocode now',
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

function renderExtensionHarness(baseDir?: string): string {
  const harness = listExtensionHarness(baseDir);
  return [
    'Octocode Pi extension harness',
    `native tools (${harness.tools.length}): ${harness.tools.join(', ')}`,
    `support tools (${harness.supportTools.length}): ${harness.supportTools.join(', ')}`,
    `builtin overrides: ${harness.overriddenBuiltins.join(', ')}`,
    `builtin removed: ${harness.disabledBuiltins.join(', ')}`,
    harness.passthroughBuiltins.length > 0
      ? `builtin passthrough: ${harness.passthroughBuiltins.join(', ')}`
      : 'builtin passthrough: (none)',
    `extension commands: ${harness.extensionCommands.join(', ')}`,
    `CLI: ${harness.cliNote}`,
    `Awareness CLI: ${harness.awarenessCliNote}`,
    `skills (${harness.skills.length}): ${harness.skills.join(', ')}`,
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

/** @deprecated Use {@link disableBuiltinTools}. Kept for public API stability. */
export const disableBuiltinReadTool = disableBuiltinTools;

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
    `Write the managed Octocode harness block to ${targetPath}?`,
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
  // state is refreshed separately on boundaries. unref()'d so it never keeps the
  // process alive.
  let metricsTicker: ReturnType<typeof setInterval> | undefined;
  const stopMetricsTicker = (): void => {
    if (metricsTicker) {
      clearInterval(metricsTicker);
      metricsTicker = undefined;
    }
  };
  const startMetricsTicker = (ctx: PiContext | undefined): void => {
    stopMetricsTicker();
    metricsTicker = setInterval(() => {
      if (metricsState.activeTurnStartedAt === undefined) {
        stopMetricsTicker();
        return;
      }
      updateOctocodeMetricsUi(ctx, metricsState);
    }, 1000);
    metricsTicker.unref?.();
  };
  const toolStartTimes = new Map<string, number>();
  let providerRequestStartedAt: number | undefined;
  // Agent inbox handle: assigned during tool registration, referenced by the
  // session_shutdown hook — its suppress flag must flip BEFORE
  // cleanupSpawnedAgentsForShutdown() kills workers, or the teardown burst of
  // killed/exit ledger events would spam desktop notifications.
  let agentInbox: AgentInboxRegistration | undefined;
  // Checkpoint engine is created lazily on first use (input hook / rewind
  // command) so sessions that never prompt pay no shadow-git init cost.
  let checkpointEnginePromise: Promise<CheckpointEngine | undefined> | undefined;
  const getCheckpointEngine = (ctx?: PiContext): Promise<CheckpointEngine | undefined> => {
    checkpointEnginePromise ??= initCheckpointStore(ctx?.cwd ?? process.cwd()).catch(() => undefined);
    return checkpointEnginePromise;
  };
  // Latest session cwd for the AI! watcher (registration happens before any ctx exists).
  let latestSessionCwd: string | undefined;
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

    hooks.on('tool_call', 'awareness-lite-lock-gate', async (event: { toolName?: string; input?: Record<string, unknown> }, ctx: PiContext | undefined) => {
      return runAwarenessLitePreEditLockGate(pi, event, ctx);
    });

    const awarenessSkillRoot = existingDirectory(path.join(getAssetPaths().skillsDir, 'octocode-awareness-lite'));
    if (awarenessSkillRoot) process.env.OCTOCODE_SKILL_ROOT = awarenessSkillRoot;

    hooks.on('session_start', 'octocode-session-start', async (_event: unknown, ctx: PiContext | undefined) => {
      // Undo the shutdown-time suppression from a previous session in this process.
      resumeStatusPanel();
      resumeAwarenessPanel();
      // Read-states recorded in a previous session must not satisfy the edit
      // tool's stale-read gate in this one, and the auto-compaction edge
      // trigger must not carry the old session's threshold crossing.
      clearAllReadStates();
      resetAutoCompactState();
      metricsState.sessionStartedAt = Date.now();
      metricsState.activeTurnStartedAt = undefined;
      metricsState.lastTurnMs = undefined;
      metricsState.completedTurns = 0;
      stopMetricsTicker();
      latestSessionCwd = ctx?.cwd;
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
      updateOctocodeMetricsUi(ctx, metricsState);
      // Surface any disk-restored plan / live agents in the below-editor panel right at launch.
      refreshStatusPanel(ctx);
      cronScheduler.start(ctx);
      // Ensure ~/.pi/agent/mcp.json has the correct npm_config_cache env vars so
      // Pi's own MCP client can start octocode-mcp with the darwin native addon.
      patchGlobalMcpOctocodeEnv();
      // Pre-warm the octocode MCP server catalog so the <mcp_cached_catalog> block
      // is ready in the system prompt before the agent's first turn. Fire-and-forget.
      void warmMcpCatalog(ctx);
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
            `Octocode env: loaded ${applied.length} var(s) (${applied.join(', ')}).`,
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
      stopWatch();
      const cleanedAgents = cleanupSpawnedAgentsForShutdown();
      const stoppedMcpServers = stopAllMcpServers();
      const closedChrome = closeAllChromeConnections();
      if (closedChrome > 0) notify(ctx, `Closed ${closedChrome} cached CDP connection(s).`, 'info');
      if (ctx?.hasUI) {
        ctx.ui?.setStatus?.('octocode', undefined);
        ctx.ui?.setStatus?.('octocode-thinking', undefined);
        ctx.ui?.setStatus?.('octocode-metrics', undefined);
        ctx.ui?.setStatus?.('octocode-agents', undefined);
        ctx.ui?.setStatus?.('agent-wait', undefined);
        ctx.ui?.setStatus?.('chrome-debug', undefined);
        ctx.ui?.setStatus?.('octocode-mcp', undefined);
        ctx.ui?.setStatus?.('octocode-plan', undefined);
        ctx.ui?.setWidget?.('octocode-plan', undefined);
        ctx.ui?.setWidget?.('octocode-agents', undefined);
        // The unified below-editor panel is now persistent (it always shows the main
        // agent model), so it no longer self-clears via refreshStatusPanel emptiness —
        // clear it explicitly on shutdown.
        ctx.ui?.setWidget?.('octocode-status-panel', undefined);
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
      updateOctocodeMetricsUi(ctx, metricsState);
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
      const name = deriveSessionName(event.text ?? '');
      if (name) applyOctocodeUi(ctx, pi.getThinkingLevel?.(), name);
      if (sessionAutoNamed) return { action: 'continue' as const };
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
      }, ctx);
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

    hooks.on('before_agent_start', 'octocode-system-prompt', async (event: BeforeAgentStartEvent, ctx: PiContext | undefined) => {
      // Suppress AGENTS.md / CLAUDE.md when --no-context flag is set. Pi builds
      // the prompt BEFORE this hook fires and systemPromptOptions is
      // inspection-only, so the block must be stripped from the assembled
      // prompt text. (octocode-agent sessions also pass --no-context-files to
      // pi, which prevents the block at the source for that path.)
      const noContext = Boolean(pi.getFlag?.('no-context'));
      const piPrompt = noContext ? stripProjectContext(event.systemPrompt) : event.systemPrompt;

      if (cachedSystemPromptText === null) {
        cachedSystemPromptText = readTextIfExists(getAssetPaths().systemPrompt);
      }
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
      // Even with no Octocode addendum to append, a stripped prompt must still
      // be returned or --no-context silently becomes a no-op.
      const stripped = piPrompt !== event.systemPrompt;
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
    const registeredToolNames = new Set<string>();

    registerEditTool(pi, Type);
    registerWriteTool(pi, Type);
    registerBashTool(pi, Type);

    registerWebTool(pi, Type, registeredToolNames, registerUniqueTool);

    if (process.env['OCTOCODE_CHROME_DEBUG'] !== '0') {
      registerChromeDebugTool(pi, Type, registeredToolNames, registerUniqueTool, notify);
      registerBrowserAgentTool(pi, Type, registeredToolNames, registerUniqueTool, notify);
    }

    registerSpawnSubagentTool(pi, Type, registeredToolNames, registerUniqueTool, notify);

    registerCallTool(pi, Type, registeredToolNames, registerUniqueTool);

    registerCallSkill(pi, Type, registeredToolNames, registerUniqueTool);

    registerPlanTool(pi, Type, registeredToolNames, registerUniqueTool);

    registerAskUserTool(pi, Type, registeredToolNames, registerUniqueTool);

    registerMemoryTool(pi, Type, registeredToolNames, registerUniqueTool);

    registerMcpTool(pi, Type, registeredToolNames, registerUniqueTool);

    registerCompactionHooks(pi, notify);
    // Branded conversation cards (compaction checkpoints / awareness handoffs)
    // — must be registered before compaction-hooks emits the first card.
    registerOctocodeMessageRenderers(pi);
    registerContextTools(pi, Type, registeredToolNames, registerUniqueTool, notify);

    if (typeof pi.on === 'function') {
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

    registerAgentTools(pi, Type, registeredToolNames, registerUniqueTool);

    // Worker inbox overlay (/octocode-inbox) + desktop notifications; must come
    // after registerAgentTools so the ledger listener seam exists.
    agentInbox = registerAgentInbox(pi, notify);

    // Re-assert disabled builtins after registration so a concurrent setActiveTools
    // (or Pi defaulting the full builtin set) cannot leave read/grep/find/ls active.
    disableBuiltinTools(pi);
  }

  if (!pi.registerCommand) return;

  pi.registerCommand('octocode', {
    description: 'Show the Octocode dashboard: status, agents, setup, skills, health, and next actions.',
    handler: async (_args, ctx) => {
      notify(ctx, formatOctocodeDashboard(ctx, undefined, formatOctocodeCronSummary(cronScheduler.list())), 'info');
    },
  });

  pi.registerCommand('octocode-now', {
    description: 'Show the Octocode orientation cockpit: model, context, current plan, shared tasks, agents, and git status.',
    handler: async (_args, ctx) => {
      notify(ctx, await formatOctocodeNow(ctx, pi), 'info');
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
      notify(ctx, renderSkillsDashboard(latestAvailableSkills), 'info');
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

  pi.registerCommand('octocode-status', {
    description: 'Show Octocode Pi extension assets, tools, CLI, and bundled skills.',
    handler: async (_args, ctx) => {
      notify(ctx, formatStatus(), 'info');
    },
  });

  pi.registerCommand('octocode-harness', {
    description:
      'List every Octocode Pi extension harness surface: native tools, support tools, extension commands, CLI entry point, and skills.',
    handler: async (_args, ctx) => {
      notify(ctx, renderExtensionHarness(), 'info');
    },
  });

  pi.registerCommand('octocode-plan', {
    description: `Show, complete, start, or clear the active task plan (usage: ${OCTOCODE_PLAN_COMMAND_USAGE}).`,
    getArgumentCompletions: (prefix) => OCTOCODE_PLAN_COMMAND_COMPLETIONS
      .filter((cmd) => cmd.startsWith(prefix))
      .map((cmd) => ({ value: cmd, label: cmd.trim(), description: `/octocode-plan ${cmd}` })),
    handler: async (args, ctx) => { await handleOctocodePlanCommand(args, ctx, notify); },
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
    description: 'Install the Octocode APPEND_SYSTEM.md block into .pi or ~/.pi/agent.',
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
      { name: 'octocode-plan', description: 'Manage the active task plan', takesArgs: true },
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
  registerAiWatch(pi, { cwd: () => latestSessionCwd ?? process.cwd() });
  registerRewindCommand(pi, { getEngine: getCheckpointEngine, notify });
  registerExportCommand(pi);
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Factory: returns the `(pi) => {...}` wiring function Pi invokes as `default(pi)`.
 * `export default createOctocodePiExtension()` preserves the historical single-arg
 * default-export contract exactly; the octocode-agent launcher opts into octocode-first
 * mode (the 'replace' option value is accepted as a back-compat alias for it).
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
