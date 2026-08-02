import fs from 'node:fs';
import path from 'node:path';
import { propagateOctocodeEnv, getOctocodeHome } from './env.js';
import {
  DISABLED_BUILTIN_TOOL_NAMES,
  OVERRIDDEN_BUILTIN_TOOL_NAMES,
  OCTOCODE_SUPPORT_TOOL_NAMES,
} from './constants.js';
import { wirePiAwarenessHooks } from '@octocodeai/octocode-awareness';
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
} from './prompt.js';
import {
  parseSetupScope,
  getAppendSystemTarget,
} from './utils.js';
import { registerUniqueTool } from './tools/octocode-tools.js';
import { registerContextTools } from './tools/context-tools.js';
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
import { registerEditTool } from './tools/edit-tool.js';
import { registerWriteTool } from './tools/write-tool.js';
import { registerBashTool } from './tools/bash-tool.js';
import { getCachedMcpCatalogAddendum, handleOctocodeMcpCommand, patchGlobalMcpOctocodeEnv, registerMcpTool, stopAllMcpServers, warmMcpCatalog } from './tools/mcp-tool.js';
import { atomicWriteUtf8 } from './tools/file-state.js';
import { assertPathAllowed } from './tools/path-guard.js';
import { makeRenderer, truncateToWidth } from './tools/render-helpers.js';
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
  OctocodePiExtensionOptions,
  PromptMode,
  SessionShutdownEvent,
  ThinkingLevelEvent,
} from './types.js';

// ─── Re-exports (stable public API) ──────────────────────────────────────────

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
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function formatContextUsage(ctx: PiContext | undefined): { text: string; percent?: number } {
  const usage = ctx?.getContextUsage?.();
  if (!usage || usage.contextWindow <= 0) return { text: 'ctx n/a' };
  const percent = Math.round((usage.tokens / usage.contextWindow) * 100);
  const filled = Math.max(0, Math.min(10, Math.floor(percent / 10)));
  const bar = `${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  return {
    text: `ctx ${bar} ${percent}% (${formatCompactNumber(usage.tokens)}/${formatCompactNumber(usage.contextWindow)})`,
    percent,
  };
}

export function formatOctocodeMetrics(ctx: PiContext | undefined, state: OctocodeMetricsState, now = Date.now()): string {
  const context = formatContextUsage(ctx).text;
  const active = state.activeTurnStartedAt !== undefined ? `active ${formatDuration(now - state.activeTurnStartedAt)}` : `last ${formatDuration(state.lastTurnMs)}`;
  return `${context} · turns ${state.completedTurns} · ${active} · session ${formatDuration(now - state.sessionStartedAt)}`;
}

function updateOctocodeMetricsUi(ctx: PiContext | undefined, state: OctocodeMetricsState): void {
  if (!ctx?.hasUI) return;
  const metrics = formatOctocodeMetrics(ctx, state);
  ctx.ui?.setStatus?.('octocode-metrics', ctx.ui.theme?.fg('dim', metrics) ?? metrics);
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

export function applyOctocodeUi(ctx: PiContext | undefined, level?: string): void {
  // setStatus / setHiddenThinkingLabel are TUI-only; guard with hasUI.
  if (!ctx?.hasUI) return;
  const ui = ctx?.ui;
  if (!ui) return;
  ui.setHiddenThinkingLabel?.('Octocode thinking');
  ui.setTitle?.('Octocode Agent');
  ui.setHeader?.((_tui: unknown, theme) => makeRenderer((width) => [
    truncateToWidth(theme.fg('accent', theme.bold('◆ Octocode Terminal Agent')), width),
    truncateToWidth(theme.fg('dim', 'research · edit/write/bash guard · browser · agents · mcp · skills · session jobs'), width),
    truncateToWidth(theme.fg('muted', 'Try /octocode · /octocode-agents · /octocode-cron · /compact'), width),
  ]));
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
  ui.setWorkingIndicator?.({
    // Use only 'accent' and 'dim' — the two colors confirmed safe in this extension.
    frames: t
      ? [
          t.fg('accent', '✦'),
          t.fg('dim', '✧'),
          t.fg('accent', '✶'),
          t.fg('dim', '✧'),
        ]
      : ['✦', '✧', '✶', '✧'],
    intervalMs: 220,
  });
  // Custom working message shown during agent streaming.
  ui.setWorkingMessage?.('◆ Octocode thinking…');
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
    usage ? `context: ${usage.tokens}/${usage.contextWindow} (${Math.round((usage.tokens / usage.contextWindow) * 100)}%)` : '',
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
    `awareness CLI: ${getAwarenessCLIPath(baseDir)} — use via: node $OCTOCODE_AWARENESS_CLI <noun> <verb> --compact`,
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
      '/octocode-agents',
      '/octocode-cron',
      '/cron',
      '/octocode-mcp',
      '/mcp',
      '/octocode-setup',
      '/octocode-skills-update',
    ],
    skills: listBundledSkills(baseDir),
    cliNote: `management: npx octocode skill | lsp-server | auth (no bundled CLI — use npx octocode for management tasks)`,
    awarenessCliNote: `bundled Awareness CLI at ${getAwarenessCLIPath(baseDir)} — run via: node $OCTOCODE_AWARENESS_CLI <noun> <verb> --compact`,
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
    `Awareness: node $OCTOCODE_AWARENESS_CLI <noun> <verb> --compact (${awarenessCliPath})`,
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
    '/octocode-agents · /octocode-cron · /octocode-status · /octocode-harness · /octocode-setup · /octocode-skills-update',
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
  const cronScheduler = createOctocodeCronScheduler({ pi });
  const metricsState: OctocodeMetricsState = {
    sessionStartedAt: Date.now(),
    completedTurns: 0,
  };
  const toolStartTimes = new Map<string, number>();
  let providerRequestStartedAt: number | undefined;

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

    const awarenessSkillRoot = existingDirectory(path.join(getAssetPaths().skillsDir, 'octocode-awareness'));
    if (awarenessSkillRoot) process.env.OCTOCODE_SKILL_ROOT = awarenessSkillRoot;
    try {
      wirePiAwarenessHooks(pi as Parameters<typeof wirePiAwarenessHooks>[0], { skillRoot: awarenessSkillRoot });
    } catch (error) {
      logInternalError('awareness-hooks', error, { skillRoot: awarenessSkillRoot }, undefined);
      console.warn(`[octocode-pi-extension] Awareness hook wiring failed: ${(error as Error)?.message ?? String(error)}`);
    }

    hooks.on('session_start', 'octocode-session-start', async (_event: unknown, ctx: PiContext | undefined) => {
      metricsState.sessionStartedAt = Date.now();
      metricsState.activeTurnStartedAt = undefined;
      metricsState.lastTurnMs = undefined;
      metricsState.completedTurns = 0;
      applyOctocodeUi(ctx, pi.getThinkingLevel?.());
      updateOctocodeMetricsUi(ctx, metricsState);
      cronScheduler.start(ctx);
      // Ensure ~/.pi/agent/mcp.json has the correct npm_config_cache env vars so
      // Pi's own MCP client can start octocode-mcp with the darwin native addon.
      patchGlobalMcpOctocodeEnv();
      // Pre-warm the octocode MCP server catalog so the <mcp_cached_catalog> block
      // is ready in the system prompt before the agent's first turn. Fire-and-forget.
      void warmMcpCatalog(ctx);
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
      const cleanedAgents = cleanupSpawnedAgentsForShutdown();
      const stoppedMcpServers = stopAllMcpServers();
      if (ctx?.hasUI) {
        ctx.ui?.setStatus?.('octocode', '');
        ctx.ui?.setStatus?.('octocode-thinking', '');
        ctx.ui?.setStatus?.('octocode-metrics', undefined);
        ctx.ui?.setStatus?.('octocode-agents', undefined);
        ctx.ui?.setStatus?.('agent-wait', undefined);
        ctx.ui?.setStatus?.('chrome-debug', undefined);
        ctx.ui?.setStatus?.('octocode-mcp', undefined);
        ctx.ui?.setWidget?.('octocode-agents', undefined);
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

    hooks.on('input', 'octocode-repo-state-hint', async (event: { text: string; images?: unknown[]; source?: string; streamingBehavior?: string }) => {
      const repoState = await buildRepoStateHint(pi, event);
      if (!repoState) return { action: 'continue' as const };
      return {
        action: 'transform' as const,
        text: `${event.text}\n\n${repoState}`,
        images: event.images,
      };
    });

    hooks.on('tool_execution_start', 'octocode-tool-error-timing', async (event: { toolCallId?: string; toolName?: string }) => {
      const key = event.toolCallId ?? event.toolName;
      if (key) toolStartTimes.set(key, Date.now());
    });

    hooks.on('tool_execution_end', 'octocode-tool-error-log', async (event: { toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean }, ctx: PiContext | undefined) => {
      const key = event.toolCallId ?? event.toolName;
      const startedAt = key ? toolStartTimes.get(key) : undefined;
      if (key) toolStartTimes.delete(key);
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
      // Suppress AGENTS.md / CLAUDE.md when --no-context flag is set.
      // For octocode-agent sessions the launcher already passes --no-context-files
      // to pi, so contextFiles is empty before this handler fires — this guard
      // is a belt-and-suspenders for direct pi usage.
      if (pi.getFlag?.('no-context') && event.systemPromptOptions?.contextFiles) {
        event.systemPromptOptions.contextFiles = [];
      }

      if (cachedSystemPromptText === null) {
        cachedSystemPromptText = readTextIfExists(getAssetPaths().systemPrompt);
      }
      const mcpCatalog = getCachedMcpCatalogAddendum(ctx);
      const prompt = [cachedSystemPromptText, mcpCatalog].filter((part) => part.trim().length > 0).join('\n\n');
      if (!shouldAppendSystemPrompt(event.systemPrompt, prompt)) {
        return;
      }
      if (prompt.trim().length === 0) return;
      return {
        systemPrompt: composeSystemPrompt({
          piSystemPrompt: event.systemPrompt,
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

    registerMcpTool(pi, Type, registeredToolNames, registerUniqueTool);

    registerCompactionHooks(pi, notify);
    registerContextTools(pi, Type, registeredToolNames, registerUniqueTool, notify);

    if (typeof pi.on === 'function') {
      pi.on('turn_start', async (_event: unknown, ctx: PiContext) => {
        metricsState.activeTurnStartedAt = Date.now();
        updateOctocodeMetricsUi(ctx, metricsState);
      });
      pi.on('turn_end', async (_event: unknown, ctx: PiContext) => {
        const now = Date.now();
        if (metricsState.activeTurnStartedAt !== undefined) {
          metricsState.lastTurnMs = now - metricsState.activeTurnStartedAt;
          metricsState.activeTurnStartedAt = undefined;
        }
        metricsState.completedTurns += 1;
        updateOctocodeMetricsUi(ctx, metricsState);
      });
    }

    registerAgentTools(pi, Type, registeredToolNames, registerUniqueTool);

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
