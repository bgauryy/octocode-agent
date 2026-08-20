#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAwarenessLite, type AgentStatus, type TaskStatus } from './index.js';
import { runPreEditLockGate, type HookHost } from './hooks.js';

type InstallHost = 'claude' | 'codex' | 'cursor';

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

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `octocode-awareness-lite <command> [action]\n\nCommands:\n  status [--stale-after]\n  schema                entities and command shapes\n  plan create|list|done\n  task add|list|claim|done|reopen\n  lock acquire|release|list\n  work start|touch|list|end manual advisory file presence\n  handoff add|list|clear manual notes for later agents\n  agent join|touch|leave|list [--stale-after]\n  message send|inbox|list|read|prune\n  check audit|mark      verify-gate receipt flow\n  verify audit|mark     alias for check\n  memory store|recall|list|forget|delete|prune\n  hooks pre-edit        JSON lock-conflict gate; exits 2 when another agent owns a lock\n  hooks install         writes the optional pre-edit hook for claude|codex|cursor; use --dry-run first\n\nHook install:\n  hooks install --host claude|cursor|codex --project-dir <repo> [--cli <path>] [--dry-run]\n  writes .claude/settings.json, .cursor/hooks.json, or .codex/hooks.json\n\nGlobal flags:\n  --workspace <path>  Workspace root, default cwd\n  --db <path>         SQLite database path`;
}

function hasHelpFlag(parsed: ParsedArgs): boolean {
  return parsed.command === 'help' || parsed.command === '--help' || parsed.action === 'help' || parsed.action === '--help' || parsed.flags.has('help');
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

function installHostHooks(params: { host: InstallHost; projectDir: string; cliPath: string; dryRun: boolean }): { ok: boolean; host: InstallHost; settingsPath: string; resultingSettings: unknown; command: string; dryRun: boolean } {
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
    ...existing.filter((candidate) => !JSON.stringify(candidate).includes('octocode-awareness-lite') && !JSON.stringify(candidate).includes(' hooks pre-edit ')),
    entry,
  ];
  const resultingSettings = { ...current, hooks };
  if (!params.dryRun) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(resultingSettings, null, 2) + '\n');
  }
  return { ok: true, host: params.host, settingsPath, resultingSettings, command, dryRun: params.dryRun };
}

export function runCli(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed.command || hasHelpFlag(parsed)) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const aw = openAwarenessLite({
    workspace: getFlag(parsed.flags, 'workspace'),
    dbPath: getFlag(parsed.flags, 'db'),
  });

  try {
    switch (parsed.command) {
      case 'status':
        print(aw.status({ staleAfterMs: getDurationFlag(parsed.flags, 'stale-after') }));
        return 0;
      case 'schema':
        print(aw.schema());
        return 0;
      case 'plan': {
        switch (parsed.action) {
          case 'create':
            print(aw.createPlan({ title: requireFlag(parsed.flags, 'title'), goal: getFlag(parsed.flags, 'goal') }));
            return 0;
          case 'list':
            print(aw.listPlans());
            return 0;
          case 'done':
            print(aw.donePlan({ planId: requireFlag(parsed.flags, 'plan-id'), force: parsed.flags.has('force') }));
            return 0;
          default:
            throw new Error('plan action must be create, list, or done');
        }
      }
      case 'task': {
        switch (parsed.action) {
          case 'add':
            print(aw.addTask({
              planId: requireFlag(parsed.flags, 'plan-id'),
              title: requireFlag(parsed.flags, 'title'),
              filePath: getFlag(parsed.flags, 'file'),
              checkCommand: getFlag(parsed.flags, 'check'),
            }));
            return 0;
          case 'list': {
            const status = getFlag(parsed.flags, 'status') as TaskStatus | undefined;
            print(aw.listTasks({ planId: getFlag(parsed.flags, 'plan-id'), status }));
            return 0;
          }
          case 'claim':
            print(aw.claimTask({ taskId: requireFlag(parsed.flags, 'task-id'), agentId: requireFlag(parsed.flags, 'agent-id') }));
            return 0;
          case 'done':
            print(aw.doneTask({ taskId: requireFlag(parsed.flags, 'task-id'), agentId: requireFlag(parsed.flags, 'agent-id') }));
            return 0;
          case 'reopen':
            print(aw.reopenTask({
              taskId: requireFlag(parsed.flags, 'task-id'),
              agentId: requireFlag(parsed.flags, 'agent-id'),
              reason: getFlag(parsed.flags, 'reason'),
            }));
            return 0;
          default:
            throw new Error('task action must be add, list, claim, done, or reopen');
        }
      }
      case 'lock': {
        switch (parsed.action) {
          case 'acquire':
            print(aw.acquireLock({
              filePath: requireFlag(parsed.flags, 'file'),
              agentId: requireFlag(parsed.flags, 'agent-id'),
              reason: getFlag(parsed.flags, 'reason'),
              ttlSeconds: Number(getFlag(parsed.flags, 'ttl') ?? 1800),
            }));
            return 0;
          case 'release':
            print(aw.releaseLock({ filePath: requireFlag(parsed.flags, 'file'), agentId: requireFlag(parsed.flags, 'agent-id') }));
            return 0;
          case 'list':
            print(aw.listLocks());
            return 0;
          default:
            throw new Error('lock action must be acquire, release, or list');
        }
      }
      case 'work': {
        switch (parsed.action) {
          case 'start':
          case 'touch':
            print(aw.startWork({
              filePath: requireFlag(parsed.flags, 'file'),
              agentId: requireFlag(parsed.flags, 'agent-id'),
              reason: getFlag(parsed.flags, 'reason'),
              ttlSeconds: Number(getFlag(parsed.flags, 'ttl') ?? 1800),
            }));
            return 0;
          case 'list':
            print(aw.listWork());
            return 0;
          case 'end':
            print(aw.endWork({ filePath: requireFlag(parsed.flags, 'file'), agentId: requireFlag(parsed.flags, 'agent-id') }));
            return 0;
          default:
            throw new Error('work action must be start, touch, list, or end');
        }
      }
      case 'handoff': {
        switch (parsed.action) {
          case 'add':
            print(aw.addHandoff({
              agentId: requireFlag(parsed.flags, 'agent-id'),
              summary: requireFlag(parsed.flags, 'summary'),
              files: getFlag(parsed.flags, 'file'),
            }));
            return 0;
          case 'list':
            print(aw.listHandoffs({ includeCleared: parsed.flags.has('include-cleared') }));
            return 0;
          case 'clear':
            print(aw.clearHandoff({ handoffId: requireFlag(parsed.flags, 'handoff-id') }));
            return 0;
          default:
            throw new Error('handoff action must be add, list, or clear');
        }
      }
      case 'agent': {
        switch (parsed.action) {
          case 'join':
            print(aw.joinAgent({
              agentId: requireFlag(parsed.flags, 'agent-id'),
              name: getFlag(parsed.flags, 'name'),
              role: getFlag(parsed.flags, 'role'),
              metadata: getFlag(parsed.flags, 'meta'),
            }));
            return 0;
          case 'touch':
            print(aw.touchAgent({
              agentId: requireFlag(parsed.flags, 'agent-id'),
              status: (getFlag(parsed.flags, 'status') as AgentStatus | undefined) ?? 'ACTIVE',
            }));
            return 0;
          case 'leave':
            print(aw.leaveAgent({ agentId: requireFlag(parsed.flags, 'agent-id') }));
            return 0;
          case 'list':
            print(aw.listAgents({ includeLeft: parsed.flags.has('include-left'), staleAfterMs: getDurationFlag(parsed.flags, 'stale-after') }));
            return 0;
          default:
            throw new Error('agent action must be join, touch, leave, or list');
        }
      }
      case 'message': {
        switch (parsed.action) {
          case 'send':
            print(aw.sendMessage({
              fromAgentId: requireFlag(parsed.flags, 'from'),
              toAgentId: getFlag(parsed.flags, 'to'),
              topic: getFlag(parsed.flags, 'topic'),
              text: requireFlag(parsed.flags, 'text'),
              files: getFlag(parsed.flags, 'file'),
            }));
            return 0;
          case 'inbox':
            print(aw.listMessages({
              agentId: requireFlag(parsed.flags, 'agent-id'),
              includeRead: parsed.flags.has('include-read'),
              topic: getFlag(parsed.flags, 'topic'),
              limit: Number(getFlag(parsed.flags, 'limit') ?? 20),
            }));
            return 0;
          case 'list':
            print(aw.listMessages({
              agentId: getFlag(parsed.flags, 'agent-id'),
              includeRead: parsed.flags.has('include-read'),
              topic: getFlag(parsed.flags, 'topic'),
              limit: Number(getFlag(parsed.flags, 'limit') ?? 20),
            }));
            return 0;
          case 'read':
            print(aw.markMessageRead({
              messageId: requireFlag(parsed.flags, 'message-id'),
              agentId: requireFlag(parsed.flags, 'agent-id'),
            }));
            return 0;
          case 'prune':
            print(aw.pruneMessages({
              olderThanMs: requireDurationFlag(parsed.flags, 'older-than'),
              readOnly: parsed.flags.has('read-only'),
              dryRun: !parsed.flags.has('confirm'),
            }));
            return 0;
          default:
            throw new Error('message action must be send, inbox, list, read, or prune');
        }
      }
      case 'check':
      case 'verify': {
        switch (parsed.action) {
          case 'audit':
            print(aw.auditChecks());
            return 0;
          case 'mark':
            print(aw.markCheck({
              taskId: requireFlag(parsed.flags, 'task-id'),
              agentId: requireFlag(parsed.flags, 'agent-id'),
              message: requireFlag(parsed.flags, 'message'),
            }));
            return 0;
          default:
            throw new Error(`${parsed.command} action must be audit or mark`);
        }
      }
      case 'hooks': {
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
      case 'memory': {
        switch (parsed.action) {
          case 'store':
            print(aw.storeMemory({
              label: requireFlag(parsed.flags, 'label'),
              text: requireFlag(parsed.flags, 'text'),
              tags: getFlag(parsed.flags, 'tags'),
            }));
            return 0;
          case 'recall':
            print(aw.recallMemory({
              query: getFlag(parsed.flags, 'query'),
              label: getFlag(parsed.flags, 'label'),
              limit: Number(getFlag(parsed.flags, 'limit') ?? 10),
            }));
            return 0;
          case 'list':
            print(aw.recallMemory({ limit: Number(getFlag(parsed.flags, 'limit') ?? 10) }));
            return 0;
          case 'forget':
          case 'delete':
            print(aw.forgetMemory({ memoryId: requireFlag(parsed.flags, 'memory-id') }));
            return 0;
          case 'prune':
            print(aw.pruneMemories({
              olderThanMs: requireDurationFlag(parsed.flags, 'older-than'),
              label: getFlag(parsed.flags, 'label'),
              dryRun: !parsed.flags.has('confirm'),
            }));
            return 0;
          default:
            throw new Error('memory action must be store, recall, list, forget, delete, or prune');
        }
      }
      default:
        throw new Error(`unknown command: ${parsed.command}`);
    }
  } finally {
    aw.close();
  }
}

export function isCliEntrypoint(metaUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return fileURLToPath(metaUrl) === resolve(argv1);
  }
}

if (isCliEntrypoint()) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
