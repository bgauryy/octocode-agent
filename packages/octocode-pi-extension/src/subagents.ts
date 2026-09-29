import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Usage } from '@earendil-works/pi-ai';
import { parseFrontmatter, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { preview } from './render.js';
import { capOutput, isRecord } from './util.js';

/** Set in child processes so a subagent cannot spawn further subagents. */
export const SUBAGENT_ENV = 'OCTOCODE_SUBAGENT';

export interface AgentProfile {
  name: string;
  description: string;
  prompt: string;
  tools?: string;
  /** Comma-separated tools the child must not have (Pi's --exclude-tools), e.g. `file` for read-only profiles. */
  excludeTools?: string;
  model?: string;
}

const BUNDLED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'subagents');

/** Project profiles (prompts, tools, models) load only when Pi trusts the project. */
export function loadProfiles(cwd: string, home = os.homedir(), projectTrusted = true): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();
  const dirs = [BUNDLED_DIR, path.join(home, '.pi', 'agent', 'agents'), ...(projectTrusted ? [path.join(cwd, '.pi', 'agents')] : [])];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((file) => file.endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of files) {
      const profile = parseProfile(path.basename(file, '.md'), fs.readFileSync(path.join(dir, file), 'utf8'));
      profiles.set(profile.name, profile);
    }
  }
  return profiles;
}

export function parseProfile(fallbackName: string, text: string): AgentProfile {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
  const field = (key: string) => (typeof frontmatter[key] === 'string' ? (frontmatter[key] as string).trim() : undefined);
  const tools = field('tools');
  const excludeTools = field('excludeTools');
  const model = field('model');
  return {
    name: field('name') ?? fallbackName,
    description: field('description') ?? '',
    prompt: body.trim(),
    ...(tools ? { tools } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(model ? { model } : {}),
  };
}

/** The Pi CLI that runs this process, else the installed Pi package's CLI, else `pi` on PATH. */
export function piInvocation(argv = process.argv): { command: string; prefix: string[] } {
  const script = argv[1];
  if (script && /(^|[\\/])(pi|cli\.js)$/.test(script) && fs.existsSync(script)) return { command: process.execPath, prefix: [script] };
  try {
    const main = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const cli = path.join(path.dirname(main), 'bundle', 'cli.js');
    if (fs.existsSync(cli)) return { command: process.execPath, prefix: [cli] };
  } catch {
    // Fall through to PATH lookup.
  }
  return { command: 'pi', prefix: [] };
}

/** This extension's entry file, so children load the same Octocode tools the parent has. */
export function selfExtensionPath(): string | undefined {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return ['index.js', 'index.ts'].map((file) => path.join(dir, file)).find((file) => fs.existsSync(file));
}

export function buildAgentArgs(task: string, profile: AgentProfile | undefined, model: string | undefined, extension = selfExtensionPath()): string[] {
  const args = ['--mode', 'json', '--no-session'];
  if (extension) args.push('--no-extensions', '-e', extension);
  const chosenModel = model ?? profile?.model;
  if (chosenModel) args.push('--model', chosenModel);
  if (profile?.tools) args.push('--tools', profile.tools);
  if (profile?.excludeTools) args.push('--exclude-tools', expandExcludes(profile.excludeTools));
  if (profile?.prompt) args.push('--append-system-prompt', profile.prompt);
  args.push(task);
  return args;
}

/** Excluding `file` makes a profile read-only, so Pi's own edit and write must go too. */
export function expandExcludes(excludeTools: string): string {
  const names = excludeTools.split(',').map((name) => name.trim()).filter(Boolean);
  return [...new Set(names.includes('file') ? [...names, 'edit', 'write'] : names)].join(',');
}

interface RunDetails {
  profile: string;
  toolCalls: number;
  activity: string[];
  seconds?: number;
}

/** How long a cancelled subagent gets to exit after SIGTERM before it is killed. */
const KILL_GRACE_MS = 5_000;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total: Usage, usage: unknown): void {
  if (!isRecord(usage)) return;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  total.input += num(usage['input']);
  total.output += num(usage['output']);
  total.cacheRead += num(usage['cacheRead']);
  total.cacheWrite += num(usage['cacheWrite']);
  total.totalTokens += num(usage['totalTokens']);
  const cost = isRecord(usage['cost']) ? usage['cost'] : {};
  total.cost.input += num(cost['input']);
  total.cost.output += num(cost['output']);
  total.cost.cacheRead += num(cost['cacheRead']);
  total.cost.cacheWrite += num(cost['cacheWrite']);
  total.cost.total += num(cost['total']);
}

interface SubagentOutcome {
  text: string;
  usage: Usage;
  /** Set when the child's model call failed (stopReason error/aborted). */
  error?: string;
}

export function registerAgentTool(pi: ExtensionAPI, getProfiles: () => Map<string, AgentProfile>): void {
  pi.registerTool({
    name: 'agent',
    label: 'Agent',
    description:
      'Run a subagent: a fresh Pi session with its own context that works on one self-contained task and returns its final answer. ' +
      'Call it several times in one turn to run independent tasks in parallel. The subagent sees none of this conversation, so the task must include every path, constraint and expected output.',
    promptSnippet: 'Delegate a self-contained task to a subagent',
    parameters: Type.Object({
      task: Type.String({ description: 'Complete, self-contained instructions and the exact output you need back' }),
      profile: Type.Optional(Type.String({ description: 'Subagent profile name from the Delegation section; omit for a general subagent' })),
      model: Type.Optional(Type.String({ description: 'Model override (provider/id)' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const profiles = getProfiles();
      const profile = params.profile ? profiles.get(params.profile) : undefined;
      if (params.profile && !profile) throw new Error(`Unknown profile "${params.profile}". Available: ${[...profiles.keys()].join(', ')}`);
      const details: RunDetails = { profile: profile?.name ?? 'general', toolCalls: 0, activity: [] };
      const started = Date.now();
      const outcome = await runSubagent(buildAgentArgs(params.task, profile, params.model), ctx.cwd, signal, (line) => {
        details.toolCalls += 1;
        details.activity = [...details.activity.slice(-4), line];
        onUpdate?.({ content: [{ type: 'text', text: line }], details: { ...details } });
      });
      if (outcome.error) throw new Error(`Subagent failed: ${outcome.error}${outcome.text ? `\n\nPartial answer:\n${outcome.text}` : ''}`);
      details.seconds = Math.round((Date.now() - started) / 1000);
      // The child's model usage counts toward this session's totals.
      return { content: [{ type: 'text', text: capOutput(outcome.text || '(subagent returned no text)') }], details, usage: outcome.usage };
    },
    renderCall(args, theme) {
      const task = String(args.task ?? '').split('\n')[0] ?? '';
      return new Text(`${theme.fg('toolTitle', theme.bold('agent'))} ${theme.fg('accent', args.profile ?? 'general')} ${theme.fg('muted', task.slice(0, 100))}`, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      const details = result.details as RunDetails | undefined;
      const body = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
      if (isPartial) return new Text(theme.fg('dim', (details?.activity ?? []).map((line) => `  ${line}`).join('\n') || '  starting…'), 0, 0);
      if (context.isError) return new Text(theme.fg('error', `✗ ${expanded ? body : (body.split('\n')[0] ?? '')}`), 0, 0);
      const summary = theme.fg('success', `✓ ${details?.profile ?? 'agent'} · ${details?.toolCalls ?? 0} tool calls · ${details?.seconds ?? 0}s`);
      return new Text(`${summary}\n${preview(body, theme, expanded, { max: 3 })}`, 0, 0);
    },
  });
}

function runSubagent(args: string[], cwd: string, signal: AbortSignal | undefined, onActivity: (line: string) => void): Promise<SubagentOutcome> {
  if (signal?.aborted) return Promise.reject(new Error('Subagent cancelled'));
  const { command, prefix } = piInvocation();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, env: { ...process.env, [SUBAGENT_ENV]: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const usage = emptyUsage();
    let finalText = '';
    let error: string | undefined;
    let buffer = '';
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const handleLine = (line: string) => {
      const event = parseEvent(line);
      if (!event) return;
      if (event['type'] === 'tool_execution_start') onActivity(describeToolCall(event['toolName'], event['args']));
      if (event['type'] !== 'message_end' || !isRecord(event['message']) || event['message']['role'] !== 'assistant') return;
      const message = event['message'];
      addUsage(usage, message['usage']);
      finalText = assistantText(message) ?? finalText;
      // Each new model response supersedes an earlier failure (Pi retries), so only the last one counts.
      error = message['stopReason'] === 'error' || message['stopReason'] === 'aborted' ? String(message['errorMessage'] ?? message['stopReason']) : undefined;
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (buffer.trim()) handleLine(buffer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Subagent cancelled'));
      else if (code !== 0 && !finalText) reject(new Error(`Subagent exited with code ${code}: ${stderr.trim() || 'no output'}`));
      else resolve({ text: finalText, usage, ...(error ? { error } : {}) });
    });
  });
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || message['role'] !== 'assistant' || !Array.isArray(message['content'])) return undefined;
  const text = message['content']
    .filter((part): part is { type: 'text'; text: string } => isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
  return text || undefined;
}

function describeToolCall(name: unknown, args: unknown): string {
  const input = isRecord(args) ? args : {};
  const hint = [input['path'], input['command'], input['query'], input['url']].find((value) => typeof value === 'string') as string | undefined;
  return `→ ${String(name)}${hint ? ` ${hint.split('\n')[0]!.slice(0, 80)}` : ''}`;
}
