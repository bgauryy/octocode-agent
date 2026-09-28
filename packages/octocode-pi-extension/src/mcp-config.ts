import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './util.js';

/**
 * MCP server configuration in the common `mcpServers` shape used by Claude
 * Code, Cursor and others. Later files override earlier ones per server name:
 *   built-in octocode → ~/.octocode/mcp.json → ~/.pi/agent/mcp.json → ./.mcp.json → ./.pi/mcp.json
 * Set `"disabled": true` on a server (including "octocode") to turn it off.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Activate this server's tools at startup instead of loading them on demand. */
  eager?: boolean;
  /** Older Octocode config name for `eager`. */
  directTools?: boolean;
}

export type McpServers = Record<string, McpServerConfig>;

/** Project files can start arbitrary commands, so they load only when Pi trusts the project. */
export function mcpConfigFiles(cwd: string, home = os.homedir(), projectTrusted = true): string[] {
  const user = [path.join(home, '.octocode', 'mcp.json'), path.join(home, '.pi', 'agent', 'mcp.json')];
  return projectTrusted ? [...user, path.join(cwd, '.mcp.json'), path.join(cwd, '.pi', 'mcp.json')] : user;
}

export function parseMcpServers(text: string): McpServers {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) return {};
  const servers = isRecord(parsed['mcpServers']) ? parsed['mcpServers'] : isRecord(parsed['servers']) ? parsed['servers'] : {};
  const out: McpServers = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) out[name] = value as McpServerConfig;
  }
  return out;
}

export function loadMcpServers(
  cwd: string,
  options: { home?: string; builtIn?: McpServers; projectTrusted?: boolean; onError?: (file: string, error: unknown) => void } = {},
): McpServers {
  const merged: McpServers = { ...(options.builtIn ?? builtInServers(cwd)) };
  for (const file of mcpConfigFiles(cwd, options.home, options.projectTrusted)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    try {
      for (const [name, config] of Object.entries(parseMcpServers(text))) {
        merged[name] = { ...merged[name], ...config };
      }
    } catch (error) {
      options.onError?.(file, error);
    }
  }
  return Object.fromEntries(
    Object.entries(merged)
      .filter(([, config]) => !config.disabled && (config.command || config.url))
      .map(([name, config]) => [name, config.directTools === true ? { ...config, eager: true } : config]),
  );
}

/** GitHub credentials Octocode can use; MCP servers otherwise start with a minimal environment. */
const OCTOCODE_TOKEN_VARS = ['OCTOCODE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * Octocode research (local code, LSP, GitHub, npm) ships with the extension and is
 * eager: its tools are the primary way to read code. The workspace is its allowed root.
 */
export function builtInServers(cwd: string, env: NodeJS.ProcessEnv = process.env): McpServers {
  const serverEnv: Record<string, string> = { WORKSPACE_ROOT: cwd, ALLOWED_PATHS: cwd };
  for (const key of OCTOCODE_TOKEN_VARS) if (env[key]) serverEnv[key] = env[key]!;
  const entry = octocodeMcpEntry();
  const launch = entry ? { command: process.execPath, args: [entry] } : { command: 'npx', args: ['-y', 'octocode-mcp@latest'] };
  return { octocode: { ...launch, env: serverEnv, eager: true } };
}

/** Absolute path of the bundled octocode-mcp bin (its `exports` hide package.json, so walk up from the entry). */
export function octocodeMcpEntry(): string | undefined {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.resolve('octocode-mcp')));
    for (let depth = 0; depth < 4; depth++, dir = path.dirname(dir)) {
      const manifestPath = path.join(dir, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string; bin?: string | Record<string, string> };
      if (manifest.name !== 'octocode-mcp') continue;
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['octocode-mcp'];
      return bin ? path.join(dir, bin) : undefined;
    }
  } catch {
    // Not installed next to the extension.
  }
  return undefined;
}

/** Expand `${VAR}` references so configs can reference secrets without inlining them. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => env[key] ?? '');
}

/** Pi tool names must be short and identifier-like. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${clean(server)}_${clean(tool)}`.slice(0, 64);
}
