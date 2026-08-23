/**
 * Octocode `bash` — same-name override of Pi's built-in bash.
 * Keeps full shell power for git/builds/sed, but blocks redirects / tee /
 * cp|mv destinations that escape Octocode path-guard roots.
 */
/** Output lines shown under a collapsed bash result row. */
const BASH_COLLAPSED_LINES = 3;

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { TSchema, ToolCallResult, ToolDefinition, PiTheme } from '../types.js';
import { cliToolTitle, paint, cliStatusGlyph, cliStatusToken } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { assertPathAllowed } from './path-guard.js';
import { classifySensitiveCommand, requestApproval, type ApprovalRequest } from './approval.js';
import { isPlanMode, PLAN_MODE_BLOCK_REASON } from './plan-mode.js';
import type { PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const BASH_TOOL_DISPLAY_NAME = 'bash (Octocode)';

const PLAN_MODE_MUTATING_BASH_RE = /(^|[;|&(`\n])\s*(?:sudo\s+)?(?:touch|mkdir|rm|rmdir|mv|cp|install|ln|chmod|chown|truncate|dd|sed\s+[^;|&\n]*\s-i\b|perl\s+[^;|&\n]*\s-i\b|node\s+(?:--[^\s]+\s+)*-[ep]\b|python3?\s+-c\b|ruby\s+-e\b)\b|>>?|\btee\b/i;

/** Catastrophic patterns we refuse even when paths look local. */
const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // Disk/filesystem destruction
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)*\/\s*$/m,
  /\brm\s+(-[a-zA-Z]*rf[a-zA-Z]*|-[a-zA-Z]*fr[a-zA-Z]*)\s+\/(\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+.*\bof=\/dev\//,
  />\s*\/dev\/sd[a-z]/,
  // Power-state commands (shutdown, restart, halt) — matched only when they appear as
  // the command itself, not as an argument. Patterns: command-start or after a shell
  // separator (; & | ( { newline), optionally preceded by sudo/nohup/exec.
  // Case-insensitive to catch REBOOT, SHUTDOWN, etc.
  // Limitation: does not detect power commands inside backtick or $() subshells.
  /(^|[;|&({\n])\s*(?:sudo\s+|nohup\s+|exec\s+)*\s*(?:shutdown|reboot|halt|poweroff)\b/im,
];

/**
 * Extract likely write targets from a shell command for path-guard checks.
 * Best-effort — not a full shell parser. Misses are fail-open for non-redirect
 * commands; hits outside roots are blocked.
 */
export function bashLooksMutatingForPlanMode(command: string, cwd: string = process.cwd()): boolean {
  return extractBashWriteTargets(command, cwd).length > 0 || classifySensitiveCommand(command) !== null || PLAN_MODE_MUTATING_BASH_RE.test(command);
}

export function extractBashWriteTargets(command: string, cwd: string): string[] {
  const targets: string[] = [];
  const push = (raw: string) => {
    const cleaned = raw
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\ /g, ' ');
    if (!cleaned || cleaned === '-' || cleaned.startsWith('&') || cleaned.startsWith('(')) return;
    // Skip /dev/null and process substitutions.
    if (cleaned === '/dev/null' || cleaned.startsWith('/dev/fd/')) return;
    targets.push(path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned));
  };

  // Redirects: > file, >> file, 2> file, &> file, exec > file.
  // Note: destinations containing shell variable references ($VAR, ${VAR}) are recorded
  // as the literal token (resolved relative to cwd if not absolute) and passed to the
  // path guard. This is intentionally fail-open: the guard sees "$OUTFILE" as a relative
  // path inside cwd, which is allowed. Agents should use explicit paths instead.
  const redirectRe = /(?:^|[\s;|&])(?:\d*)?>>?\s*([^\s;|&<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = redirectRe.exec(command)) !== null) {
    push(match[1]!);
  }

  // tee [-a] file...
  const teeRe = /\btee\b(?:\s+-a)?\s+([^\n;|&]+)/g;
  while ((match = teeRe.exec(command)) !== null) {
    for (const part of match[1]!.trim().split(/\s+/)) {
      if (part.startsWith('-')) continue;
      push(part);
    }
  }

  // cp/mv ... dest (last non-flag arg) — only when dest looks like a path
  const copyRe = /\b(?:cp|mv|install)\b(?:\s+-[a-zA-Z]+|\s+--[^\s]+)*\s+(.+)$/gm;
  while ((match = copyRe.exec(command)) !== null) {
    const args = match[1]!.trim().split(/\s+/).filter((a) => !a.startsWith('-'));
    const dest = args[args.length - 1];
    if (dest) push(dest);
  }

  // In-place editors (sed -i, perl -i) write their file arguments directly,
  // bypassing shell redirects. Extract those files so the guard sees them.
  // Opaque interpreters (node -e, python -c) can still write arbitrary paths and
  // are not statically parseable — the tool description documents that gap.
  for (const seg of command.split(/[;|&\n]+/)) {
    for (const file of extractInPlaceEditTargets(seg)) push(file);
  }

  return [...new Set(targets)];
}

/**
 * Split a shell segment into tokens, keeping single/double-quoted runs intact.
 * Best-effort — enough to isolate the file arguments of an in-place editor.
 */
function tokenizeShellSegment(seg: string): string[] {
  const tokens: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) tokens.push(m[0]);
  return tokens;
}

function stripOuterQuotes(t: string): string {
  return t.replace(/^['"]/, '').replace(/['"]$/, '');
}

/**
 * Extract file targets written by `sed -i` / `perl -i` in a single command
 * segment. Returns [] when no in-place editor is present.
 *
 * Correctly separates the SCRIPT from the FILE operands across dialects, so a
 * script token (e.g. the BSD/macOS `sed -i '' '/^re/d' file` address, which
 * starts with `/`) is never mistaken for an absolute output path:
 *  - GNU `sed -i 's/a/b/' f` / attached suffix `sed -i.bak 's/a/b/' f`
 *  - BSD `sed -i '' 's/a/b/' f` (separate empty backup-suffix arg)
 *  - explicit script via `-e <script>` / script file via `-f <file>` (skipped)
 *  - `perl -i -pe 's/a/b/' f` (script is the token after the flag bundle)
 */
function extractInPlaceEditTargets(seg: string): string[] {
  const tokens = tokenizeShellSegment(seg);
  const cmdIdx = tokens.findIndex((t) => t === 'sed' || t === 'perl');
  if (cmdIdx === -1) return [];
  const rest = tokens.slice(cmdIdx + 1);
  if (!rest.some((t) => /^-i/.test(t) || /^--in-place/.test(t))) return [];

  // An explicit `-e`/`-f` script means every positional token is a FILE (no
  // inline positional script to skip).
  const hasExplicitScript = rest.some((t) => t === '-e' || t === '--expression' || t === '-f' || t === '--file');

  const files: string[] = [];
  let inlineScriptSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith('-')) {
      if (t === '-e' || t === '--expression' || t === '-f' || t === '--file') {
        i++; // the next token is a script / script-file, not an output file
        continue;
      }
      if (t === '-i' || t === '--in-place') {
        // BSD sed takes a SEPARATE backup-suffix arg (often ''); GNU -i takes
        // none. Consume the next token only when it is unambiguously a suffix
        // (empty or dotted), never a script or a real filename.
        const next = rest[i + 1] !== undefined ? stripOuterQuotes(rest[i + 1]!) : undefined;
        if (next !== undefined && (next === '' || /^\.[\w.-]*$/.test(next))) i++;
        continue;
      }
      continue; // other flags (-n, -E, -pe, …)
    }
    if (!hasExplicitScript && !inlineScriptSeen) {
      inlineScriptSeen = true; // first positional is the inline script, not a file
      continue;
    }
    files.push(t);
  }
  return files;
}

export function classifyEnvExfilCommand(command: string): ApprovalRequest | null {
  const cmd = command.trim();
  const obviousEnvironmentDump = /(^|[;|&(`\n])\s*(?:env|printenv)(?:\s|$)/i.test(cmd) ||
    /(^|[;|&(`\n])\s*(?:set|declare)(?:\s|$)/i.test(cmd) ||
    /\/proc\/(?:self|\d+)\/environ\b/.test(cmd);
  const obviousSecretEcho = /\b(?:echo|printf)\b[^;|&\n]*(?:\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH)[A-Z0-9_]*\}?)/i.test(cmd);
  if (!obviousEnvironmentDump && !obviousSecretEcho) return null;
  return {
    actionClass: 'system',
    title: 'Expose inherited environment variables',
    detail: cmd,
  };
}

export function assertBashCommandAllowed(command: string, cwd: string): void {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `bash blocked: command matches a catastrophic pattern. ` +
          `Refusing to run. Rewrite the command to a safer form.`,
      );
    }
  }
  for (const target of extractBashWriteTargets(command, cwd)) {
    assertPathAllowed(target, cwd, 'bash write');
  }
}

function truncateOutput(text: string): string {
  const lines = text.split('\n');
  let out = text;
  if (lines.length > DEFAULT_MAX_LINES) {
    out = lines.slice(-DEFAULT_MAX_LINES).join('\n');
    out = `[truncated to last ${DEFAULT_MAX_LINES} lines]\n${out}`;
  }
  if (Buffer.byteLength(out, 'utf8') > DEFAULT_MAX_BYTES) {
    // Keep the tail.
    let end = out.length;
    while (end > 0 && Buffer.byteLength(out.slice(0, end), 'utf8') > DEFAULT_MAX_BYTES) {
      end = Math.floor(end * 0.9);
    }
    out = `${out.slice(Math.max(0, out.length - end))}\n[truncated to last ${DEFAULT_MAX_BYTES} bytes]`;
  }
  return out;
}

async function runBash(
  command: string,
  cwd: string,
  timeoutSec: number | undefined,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; aborted: boolean }> {
  await access(cwd, constants.F_OK).catch(() => {
    throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
  });
  if (signal?.aborted) throw new Error('Operation aborted');

  const shell = process.env.SHELL || '/bin/bash';
  return await new Promise((resolve, reject) => {
    const child = spawn(shell, ['-lc', command], {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const killChild = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, sig);
        } else {
          child.kill(sig);
        }
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* ignore */
        }
      }
    };
    const terminateChild = () => {
      killChild('SIGTERM');
      // A SIGTERM-trapping or uninterruptible child would otherwise leave the
      // execute promise pending forever (abort has no other backstop).
      const escalate = setTimeout(() => {
        if (!settled) killChild('SIGKILL');
      }, 2000);
      escalate.unref?.();
    };
    const timer =
      timeoutSec && timeoutSec > 0
        ? setTimeout(() => {
            terminateChild();
            if (!settled) {
              settled = true;
              reject(new Error(`bash timed out after ${timeoutSec}s`));
            }
          }, timeoutSec * 1000)
        : null;

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      terminateChild();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Decode per-stream so multibyte UTF-8 sequences split across chunk
    // boundaries are not corrupted; flush trailing partial bytes on close.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += outDec.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += errDec.write(chunk);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        stdout += outDec.end();
        stderr += errDec.end();
        resolve({ stdout, stderr, code, signal: sig, aborted });
      }
    });
  });
}

export function registerBashTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  const parameters = Type.Object(
    {
      command: Type.String({ description: 'Bash command to execute' }),
      reasoning: Type.String({ description: 'REQUIRED. Why this shell command is necessary; shown to users so they understand the intent before/while it runs.' }),
      timeout: Type.Optional(
        Type.Integer({ description: 'Timeout in seconds (optional, no default timeout)' }),
      ),
    },
    { additionalProperties: false },
  ) as TSchema;

  registerFn(pi, registeredToolNames, {
    name: 'bash',
    label: 'bash (Octocode)',
    description:
      'Octocode custom bash tool. Replaces Pi built-in bash with the same shell execution plus Octocode path-guard on redirect/tee/cp/mv and sed -i / perl -i in-place write targets (cwd / home / OS temp / ALLOWED_PATHS), a small blocklist of catastrophic commands, and approval for obvious environment-variable exfiltration commands. Requires a non-empty reasoning field explaining why the command is necessary. Note: opaque interpreters (node -e, python -c) can still write arbitrary paths and are not guarded — prefer edit/write for file mutations; use bash for git, builds, tests, and bulk mechanical edits.',
    promptSnippet: 'Run shell commands with Octocode path-guard on write targets.',
    promptGuidelines: [
      'Octocode custom bash replaces Pi built-in bash; prefer edit/write for ordinary file creates and surgical edits.',
      'Use bash for git, builds, tests, package managers, and bulk mechanical edits (e.g. sed).',
      'Commands that obviously print inherited environment variables or secret-like env vars require approval; bash otherwise keeps the inherited environment for compatibility.',
      'Redirects (>, >>, tee) and cp/mv destinations must stay inside the working directory, home, OS temp, or ALLOWED_PATHS.',
      'Do not use bash to bypass the edit/write path-guard.',
    ],
    parameters,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: PiContext,
    ): Promise<ToolCallResult> {
      if (typeof params['command'] !== 'string' || params['command'].trim().length === 0) {
        throw new Error('Bash tool input is invalid. command must be a non-empty string.');
      }
      if (typeof params['reasoning'] !== 'string' || params['reasoning'].trim().length === 0) {
        throw new Error('Bash tool input is invalid. reasoning is required — provide a non-empty string explaining why this command is necessary.');
      }
      const command = params['command'];
      const timeout =
        typeof params['timeout'] === 'number' && Number.isFinite(params['timeout'])
          ? params['timeout']
          : undefined;
      const cwd = ctx?.cwd ?? process.cwd();
      assertBashCommandAllowed(command, cwd);
      if (isPlanMode() && bashLooksMutatingForPlanMode(command, cwd)) {
        throw new Error(`bash blocked: ${PLAN_MODE_BLOCK_REASON}`);
      }

      // Context-aware consent: installs, mutating git, file deletes, and sudo are
      // protected. Ask before running (Yes / No / Always allow this session).
      const sensitive = classifySensitiveCommand(command) ?? classifyEnvExfilCommand(command);
      if (sensitive) {
        const outcome = await requestApproval(ctx, sensitive);
        if (!outcome.approved) {
          const why = outcome.interactive
            ? 'The user declined this action.'
            : 'This host is non-interactive, so consent could not be collected. Ask the user inline to confirm before retrying.';
          throw new Error(
            `bash blocked: "${sensitive.title}" requires user approval. ${why}`,
          );
        }
      }

      if (signal?.aborted) throw new Error('Operation aborted');

      const { stdout, stderr, code, signal: killedBy, aborted } = await runBash(command, cwd, timeout, signal);
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      // A process killed by a signal (code === null) is a failure, not a quiet
      // success — including our own abort; the old `code !== null` guard let a
      // SIGTERM-ed child report ok. Always surface the reason: Pi records
      // non-throwing results as success, so this line is the model's only
      // failure signal when the command printed normal-looking output.
      const isError = aborted || code !== 0;
      const exitNote = aborted ? '(aborted)' : killedBy ? `(killed by ${killedBy})` : `(exit ${code ?? 'null'})`;
      const body = isError && combined ? `${combined}\n${exitNote}` : combined;
      const text = truncateOutput(body || exitNote);
      return {
        content: [{ type: 'text', text }],
        isError,
        details: { code, stdout, stderr },
      };
    },
    renderCall(args: unknown, theme?: PiTheme) {
      const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      const command = typeof input['command'] === 'string' ? input['command'] : '(missing command)';
      const reasoning = typeof input['reasoning'] === 'string' ? input['reasoning'].trim() : '';
      const title = cliToolTitle(theme, BASH_TOOL_DISPLAY_NAME);
      const suffix = paint(theme, 'dim', command);
      return makeRenderer((width) => [
        truncateToWidth(`${title} ${suffix}`, width),
        ...(reasoning ? [truncateToWidth(`  why: ${paint(theme, 'dim', reasoning)}`, width)] : []),
      ]);
    },
    renderResult(result: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme) {
      if (opts.isPartial) {
        const prog = paint(theme, 'brand', `… running ${BASH_TOOL_DISPLAY_NAME}`);
        return makeRenderer((width) => [truncateToWidth(prog, width)]);
      }
      const text = result.content.find((c) => c.type === 'text')?.text ?? '';
      const allLines = text.split('\n').filter((l) => l.length > 0);
      const ok = !result.isError;
      const code = (result.details as { code?: number | null } | undefined)?.code;
      // Every result row carries the result: status glyph, exit code, line
      // count, then the output itself — a short head when collapsed, everything
      // when expanded (ctrl+o). Paint per line, not the whole block: a single
      // fg-wrap only colours the first row once the block is split.
      const head = `${paint(theme, cliStatusToken(ok), cliStatusGlyph(ok))} ${cliToolTitle(theme, BASH_TOOL_DISPLAY_NAME)}${
        paint(theme, 'dim', ` · exit ${code ?? 'null'} · ${allLines.length} line${allLines.length === 1 ? '' : 's'}`)}`;
      const shown = opts.expanded ? allLines : allLines.slice(0, BASH_COLLAPSED_LINES);
      const hidden = allLines.length - shown.length;
      return makeRenderer((width) => [
        truncateToWidth(head, width),
        ...shown.map((line) => truncateToWidth(ok ? paint(theme, 'dim', `  ${line}`) : paint(theme, 'error', `  ${line}`), width)),
        ...(hidden > 0 ? [truncateToWidth(paint(theme, 'muted', `  … ${hidden} more line${hidden === 1 ? '' : 's'} — ctrl+o expands`), width)] : []),
      ]);
    },
  });
}
