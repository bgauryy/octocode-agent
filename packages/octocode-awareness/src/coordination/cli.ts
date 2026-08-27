#!/usr/bin/env node
import { existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AWARENESS_COMMANDS } from './commands-spec.js';
import { dispatchAwarenessCommand,type AwarenessCommandRequest } from './dispatch.js';
import {
  EXTERNAL_AGENT_AWARENESS_PROMPT,
  EXTERNAL_AGENT_AWARENESS_INSTRUCTIONS,
  formatExternalAgentAwarenessInstructions,
  getExternalAgentAwarenessGuide,
} from './external-policy.js';
import { runPreEditLockGate,type HookHost } from './hooks.js';
import { isEmbeddingEnabled,openAwarenessStore } from './index.js';

export type InstallHost = 'claude' | 'codex' | 'cursor';

interface ParsedArgs {
  command?: string;
  action?: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, maybeAction, ...tail] = argv;
  const action = maybeAction?.startsWith('--') ? undefined : maybeAction;
  const rest = action ? tail : [maybeAction, ...tail].filter((arg): arg is string => Boolean(arg));
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      index += 1;
    }
  }
  return { command, action, flags };
}

function getFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  if (typeof value === 'string') return value;
  return undefined;
}

function requireFlag(flags: Map<string, string | true>, name: string): string {
  const value = getFlag(flags, name);
  if (!value?.trim()) throw new Error(`--${name} is required`);
  return value;
}

function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * multipliers[unit]!;
}

function getDurationFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const value = getFlag(flags, name);
  return value ? parseDurationMs(value) : undefined;
}

function requireDurationFlag(flags: Map<string, string | true>, name: string): number {
  return parseDurationMs(requireFlag(flags, name));
}

/**
 * Output sink for `print`. Defaults to real stdout so the `bin` behaves exactly
 * as before; `runCli`/`execCli` swap it so an in-process host can capture the same JSON a
 * spawned `cli.js` would have written, without a child process.
 */
let currentWriter: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); };

function print(value: unknown): void {
  currentWriter(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `octocode-awareness <command> [action]\n\nCommands:\n  guide                 print canonical external-agent usage policy\n  instructions export   emit reusable prompt or AGENTS.md instructions\n  status [--stale-after]\n  schema [commands|list|command --name <noun>] entities and command shapes\n  plan create|list|show|done|abandon\n  task add|list|ready|show|depend|claim|heartbeat|release|done|reopen\n  lock acquire|wait|prune|release|list\n  work start|touch|list|show|end manual advisory file presence\n  handoff add|list|clear manual notes for later agents\n  agent join|touch|leave|list [--stale-after]\n  message send|list|read|prune\n  check audit|mark      verify-gate receipt flow\n  memory store|store-verified|recall|recall-verified|evaluate|list|reindex|forget|prune\n  memory recall --semantic  cosine recall via OCTOCODE_EMBED_CMD (falls back to lexical)\n  hooks pre-edit        JSON lock-conflict gate; exits 2 when another agent owns a lock\n  hooks install         writes the optional pre-edit hook for claude|codex|cursor; use --dry-run first\n\nInstruction export:\n  instructions export [--format prompt|agents-md|json]\n  agents-md includes stable markers for idempotent replacement; output is stdout only\n\nHook install:\n  hooks install --host claude|cursor|codex --project-dir <repo> [--cli <path>] [--dry-run]\n  writes .claude/settings.json, .cursor/hooks.json, or .codex/hooks.json\n\nGlobal flags:\n  --workspace <path>  Workspace root, default cwd\n  --db <path>         SQLite database path`;
}
function hasHelpFlag(parsed: ParsedArgs): boolean {
  return parsed.command === 'help' || parsed.command === '--help' || parsed.action === 'help' || parsed.action === '--help' || parsed.flags.has('help');
}

const GLOBAL_FLAGS = ['workspace', 'db', 'help'] as const;
const CLI_ONLY_ACTION_FLAGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  guide: { '': ['json'] },
  instructions: { export: ['format'] },
  schema: { '': [], commands: [], list: [], command: ['name'] },
  hooks: {
    install: ['host', 'project-dir', 'cli', 'dry-run'],
    'pre-edit': ['host', 'agent-id', 'event-json'],
  },
  memory: {
    store: ['label', 'text', 'tags'],
    'store-verified': ['label', 'text', 'source-digest', 'scope', 'verified-at', 'valid-until', 'importance', 'tags'],
    recall: ['query', 'label', 'limit', 'semantic', 'min-similarity'],
    'recall-verified': ['query', 'label', 'source-digest', 'scope', 'mode', 'limit', 'now', 'min-similarity'],
    evaluate: ['corpus-json', 'now', 'limit', 'min-similarity'],
    list: ['limit'],
    reindex: ['force', 'limit'],
    forget: ['memory-id'],
    prune: ['older-than', 'label', 'confirm'],
  },
  lock: { prune: ['confirm'], wait: ['retry-interval'] },
  task: { list: ['agent-id'] },
  work: { list: ['file', 'agent-id'] },
  agent: { join: ['meta'], touch: ['agent-id', 'status'] },
  message: {
    list: ['agent-id', 'topic', 'include-read', 'limit'],
    prune: ['older-than', 'read-only', 'confirm'],
  },
};

function validateFlags(parsed: ParsedArgs): void {
  if (!parsed.command) return;
  const action = parsed.action ?? '';
  const group = AWARENESS_COMMANDS.find((candidate) => candidate.cli === parsed.command);
  const commandAction = group?.actions.find((candidate) => candidate.action === action)
    ?? (group?.singleton && !action ? group.actions[0] : undefined);
  const cliOnlyFlags = CLI_ONLY_ACTION_FLAGS[parsed.command]?.[action];
  // Preserve each command's own unknown-command/action error when no canonical
  // action contract exists. Known actions are strict and accept only their
  // declared params, host-injected agent id, CLI-only params, and globals.
  if (!commandAction && !cliOnlyFlags) return;
  const allowed = new Set<string>(GLOBAL_FLAGS);
  for (const param of commandAction?.params ?? []) allowed.add(param.flag);
  if (commandAction?.needsAgentId) allowed.add(commandAction.agentIdFlag ?? 'agent-id');
  for (const flag of cliOnlyFlags ?? []) allowed.add(flag);
  for (const flag of parsed.flags.keys()) {
    if (!allowed.has(flag)) throw new Error(`unknown flag: --${flag}`);
  }
}

function readJsonInput(flags: Map<string, string | true>): unknown {
  const raw = getFlag(flags, 'event-json') ?? readFileSync(0, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

function defaultHookAgentId(host: string): string {
  return process.env.OCTOCODE_AGENT_ID || `${host || 'hook'}:${process.pid}`;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Translate the CLI's parsed flags into the neutral, tool-facing `params` dict
 * that `dispatchAwarenessCommand` consumes. This is the CLI's ONLY awareness
 * responsibility beyond argv parsing: the command→library-method mapping lives
 * once in `dispatch.ts`, so the CLI never names an `AwarenessStore` method or its
 * param shape. Over-reading a flag an action ignores is harmless — the
 * dispatcher only uses the keys each action needs. Duration flags are converted
 * to integer milliseconds here (the parser's job); the dispatcher receives ms.
 */
function buildCommandParams(parsed: ParsedArgs): Record<string, unknown> {
  const f = parsed.flags;
  const s = (name: string) => getFlag(f, name);
  const d = (name: string) => getDurationFlag(f, name);
  const has = (name: string) => f.has(name);
  const isPrune = parsed.action === 'prune';

  switch (parsed.command) {
    case 'status':
      return { staleAfterMs: d('stale-after') };
    case 'schema':
      return { name: s('name') };
    case 'plan':
      return { title: s('title'), goal: s('goal'), planId: s('plan-id'), force: has('force'), agentId: s('agent-id'), reason: s('reason') };
    case 'task':
      return {
        planId: s('plan-id'), title: s('title'), file: s('file'), paths: s('path'),
        dependsOn: s('depends-on'), reasoning: s('reasoning'), acceptance: s('acceptance'),
        checkCommand: s('check'), priority: s('priority'), status: s('status'),
        agentId: s('agent-id'), limit: s('limit'), taskId: s('task-id'),
        leaseSeconds: s('lease'), blockedReason: s('blocked-reason'),
        reason: s('reason'), // task reopen uses --reason (distinct from add's --reasoning)
      };
    case 'lock':
      return {
        file: s('file'), agentId: s('agent-id'), reason: s('reason'), ttlSeconds: s('ttl'),
        waitMs: d('wait'), retryIntervalMs: d('retry-interval'),
        dryRun: isPrune ? !has('confirm') : undefined,
      };
    case 'work':
      return { file: s('file'), agentId: s('agent-id'), reason: s('reason'), ttlSeconds: s('ttl') };
    case 'handoff':
      return { agentId: s('agent-id'), summary: s('summary'), files: s('file'), includeCleared: has('include-cleared'), handoffId: s('handoff-id') };
    case 'check':
      return { agentId: s('agent-id'), planId: s('plan-id'), minAgeMs: d('min-age'), taskId: s('task-id'), message: s('message'), status: s('status') };
    case 'message':
      return {
        agentId: parsed.action === 'send' ? s('from') : s('agent-id'),
        to: s('to'), topic: s('topic'), text: s('text'), files: s('file'),
        includeRead: has('include-read'), limit: s('limit'), messageId: s('message-id'),
        readOnly: has('read-only'),
        olderThanMs: isPrune ? requireDurationFlag(f, 'older-than') : undefined,
        dryRun: isPrune ? !has('confirm') : undefined,
      };
    case 'agent':
      return { agentId: s('agent-id'), name: s('name'), role: s('role'), metadata: s('meta'), status: s('status'), includeLeft: has('include-left'), staleAfterMs: d('stale-after') };
    case 'memory':
      return {
        label: s('label'), text: s('text'), tags: s('tags'), query: s('query'), limit: s('limit'),
        semantic: has('semantic'), minSimilarity: s('min-similarity'),
        sourceDigest: s('source-digest'), scope: s('scope'), verifiedAt: s('verified-at'), validUntil: s('valid-until'),
        importance: s('importance'), mode: s('mode'), now: s('now'), corpusJson: s('corpus-json'),
        force: has('force'), memoryId: s('memory-id'),
        olderThanMs: isPrune ? requireDurationFlag(f, 'older-than') : undefined,
        dryRun: isPrune ? !has('confirm') : undefined,
      };
    default:
      return {};
  }
}

export function installHostHooks(params: { host: InstallHost; projectDir: string; cliPath: string; dryRun: boolean }): { ok: boolean; host: InstallHost; settingsPath: string; resultingSettings: unknown; command: string; dryRun: boolean } {
  const settingsByHost: Record<InstallHost, { dir: string; file: string; matcher: string }> = {
    claude: { dir: '.claude', file: 'settings.json', matcher: '^(?:Write|Edit|MultiEdit|NotebookEdit)$' },
    codex: { dir: '.codex', file: 'hooks.json', matcher: '^(?:apply_patch|Write|Edit)$' },
    cursor: { dir: '.cursor', file: 'hooks.json', matcher: '^(?:Write|Edit|StrReplace|Delete|MultiEdit|NotebookEdit|apply_patch|ApplyPatch)$' },
  };
  const spec = settingsByHost[params.host];
  const settingsPath = resolve(params.projectDir, spec.dir, spec.file);
  const current = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown> : {};
  const hooks = current.hooks && typeof current.hooks === 'object' ? current.hooks as Record<string, unknown[]> : {};
  const command = `${quoteShell(process.execPath)} ${quoteShell(resolve(params.cliPath))} hooks pre-edit --host ${params.host} --workspace ${quoteShell(resolve(params.projectDir))}`;
  const entry = {
    matcher: spec.matcher,
    hooks: [{ type: 'command', command, timeout: 5 }],
  };
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  hooks.PreToolUse = [
    ...existing.filter((candidate) => !JSON.stringify(candidate).includes('octocode-awareness') && !JSON.stringify(candidate).includes(' hooks pre-edit ')),
    entry,
  ];
  const resultingSettings = { ...current, hooks };
  if (!params.dryRun) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(resultingSettings, null, 2) + '\n');
  }
  return { ok: true, host: params.host, settingsPath, resultingSettings, command, dryRun: params.dryRun };
}

export function runCli(argv: string[], io: { write?: (chunk: string) => void } = {}): number {
  const previousWriter = currentWriter;
  if (io.write) currentWriter = io.write;
  try {
    return runCliInner(argv, io.write ?? previousWriter);
  } finally {
    currentWriter = previousWriter;
  }
}

function runCliInner(argv: string[], write: (chunk: string) => void): number {
  const parsed = parseArgs(argv);
  if (!parsed.command || hasHelpFlag(parsed)) {
    write(`${usage()}\n`);
    return 0;
  }
  validateFlags(parsed);

  if (parsed.command === 'guide') {
    if (parsed.action) throw new Error('guide does not accept an action');
    if (parsed.flags.has('json')) print(getExternalAgentAwarenessGuide());
    else write(`${EXTERNAL_AGENT_AWARENESS_PROMPT}\n`);
    return 0;
  }

  if (parsed.command === 'instructions') {
    if (parsed.action !== 'export') throw new Error('instructions action must be export');
    const format = getFlag(parsed.flags, 'format') ?? 'prompt';
    if (!['prompt', 'agents-md', 'json'].includes(format)) {
      throw new Error('instructions export --format must be prompt, agents-md, or json');
    }
    if (format === 'json') print({ format: 'prompt', instructions: EXTERNAL_AGENT_AWARENESS_INSTRUCTIONS });
    else write(`${formatExternalAgentAwarenessInstructions(format === 'agents-md' ? 'agents-md' : 'prompt')}\n`);
    return 0;
  }

  // `hooks` is host integration (stdin + filesystem), not a coordination
  // command, so it does not route through the shared dispatcher.
  if (parsed.command === 'hooks') {
    switch (parsed.action) {
      case 'install': {
        const host = (getFlag(parsed.flags, 'host') ?? 'claude') as InstallHost;
        if (!['claude', 'codex', 'cursor'].includes(host)) throw new Error('hooks install --host must be claude, codex, or cursor');
        print(installHostHooks({
          host,
          projectDir: getFlag(parsed.flags, 'project-dir') ?? process.cwd(),
          cliPath: getFlag(parsed.flags, 'cli') ?? process.argv[1]!,
          dryRun: parsed.flags.has('dry-run'),
        }));
        return 0;
      }
      case 'pre-edit': {
        const result = runPreEditLockGate({
          workspace: getFlag(parsed.flags, 'workspace'),
          dbPath: getFlag(parsed.flags, 'db'),
          agentId: getFlag(parsed.flags, 'agent-id') ?? defaultHookAgentId(getFlag(parsed.flags, 'host') ?? 'generic'),
          host: (getFlag(parsed.flags, 'host') ?? 'generic') as HookHost,
          event: readJsonInput(parsed.flags),
        });
        print(result);
        return result.blocked ? 2 : 0;
      }
      default:
        throw new Error('hooks action must be install or pre-edit');
    }
  }

  const aw = openAwarenessStore({
    workspace: getFlag(parsed.flags, 'workspace'),
    dbPath: getFlag(parsed.flags, 'db'),
  });

  try {
    // CLI-only UX affordance: warn (but do not fail) when semantic recall is
    // requested without an embedder configured; the library falls back to lexical.
    if (parsed.command === 'memory' && parsed.action === 'recall'
      && parsed.flags.has('semantic') && !isEmbeddingEnabled()) {
      process.stderr.write('warning: --semantic requested but OCTOCODE_EMBED_CMD is unset; using lexical recall\n');
    }

    const request: AwarenessCommandRequest = {
      command: parsed.command,
      action: parsed.action,
      params: buildCommandParams(parsed),
    };
    const { result, exitCode } = dispatchAwarenessCommand(aw, request);
    print(result);
    return exitCode;
  } finally {
    aw.close();
  }
}

/**
 * Run a CLI command vector IN-PROCESS and capture what the `bin` would have
 * printed, so a host can embed Awareness as a library and reuse the exact
 * same JSON contract it built its argv for — no `node cli.js` child process.
 * Never throws: argument/usage errors are mapped to `{ code: 1, stderr }`,
 * mirroring the bin's non-zero exit. `code` is 2 for lock-wait/pre-edit blocks,
 * matching the subprocess exit codes callers already branch on.
 */
export function execCli(argv: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  try {
    const code = runCli(argv, { write: (chunk) => { stdout += chunk; } });
    return { code, stdout, stderr: '' };
  } catch (error) {
    return { code: 1, stdout, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** Compare real paths so package-manager bin shims and symlinks are recognized. */
export function isCliEntrypoint(metaUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(metaUrl) === resolve(argv1);
  }
}
