/**
 * Discovery file — one machine-readable inventory of everything this session
 * can do: every discovered Agent Skill (across the common ecosystem roots,
 * deduped by name), the full MCP configuration (active sources, servers,
 * discovered tools, plus every MCP config file found in common claude/cursor/
 * codex/octocode/pi locations), and the native tool surface.
 *
 * Written to `.octocode/discovery.json` at session start (after init MCP
 * discovery lands) so users, peer agents, and external tooling can discover
 * the harness surface from one file instead of spelunking prompts and configs.
 * Best-effort: a failed write never affects the session.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiContext } from '../types.js';
import { getOctocodeHome } from '../env.js';
import { getMcpDiscoverySnapshot, type McpDiscoverySnapshot } from './mcp-tool.js';
import type { DiscoveredSkill } from './skill-tool.js';

/** One MCP config file found in a common ecosystem location. */
export interface DiscoveredMcpConfig {
  path: string;
  /** Which ecosystem owns the location: agents | claude | cursor | codex | octocode | pi. */
  host: string;
  scope: 'project' | 'user';
  format: 'json' | 'toml';
  /**
   * True only for the canonical Octocode `agent/mcp/servers.json` files. Foreign configs
   * are inventory ONLY — never auto-spawned; add one explicitly via MCPTool.
   */
  active: boolean;
  servers: Array<{ name: string; command?: string }>;
  /** Parse failure, when the file exists but could not be read as its format. */
  error?: string;
}

/** Per-section character counts for the harness prompt overhead. */
export interface SystemPromptStats {
  /** Octocode system prompt text (prompt.ts + Pi's own prompt). */
  sysChars: number;
  /** MCP catalog addendum chars (all server instructions + tool schemas). */
  mcpChars: number;
  /**
   * Dynamic addenda chars: available-skills block + active-plan block +
   * dynamic-capabilities addendum (changes every turn).
   */
  dynamicChars: number;
  /** Total of all three sections. */
  totalChars: number;
  /** Rough token estimate at 4 chars/token. */
  estimatedTokens: number;
  mcpServers: number;
  mcpTools: number;
  skills: number;
}

export interface DiscoverySnapshot {
  version: 1;
  generatedAt: string;
  workspace: string;
  harness: string;
  /** System prompt overhead snapshot from the last before_agent_start (or session_start). */
  systemPromptStats?: SystemPromptStats;
  /** Model-callable native tool names registered by the extension. */
  nativeTools: string[];
  nativeToolCount: number;
  skills: Array<{ name: string; description: string; source: string; path: string }>;
  mcp: McpDiscoverySnapshot & { discoveredConfigs: DiscoveredMcpConfig[] };
}

// ─── MCP config discoverability across common ecosystem locations ─────────────

function parseJsonMcpServers(text: string, allowRootServers: boolean): Array<{ name: string; command?: string }> {
  const json = JSON.parse(text) as Record<string, unknown>;
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(json)) throw new Error('config must contain an object');
  const container = isRecord(json['mcpServers'])
    ? json['mcpServers']
    : isRecord(json['servers'])
      ? json['servers']
      : allowRootServers
        ? json
        : {};
  return Object.entries(container)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, server]) => ({
      name,
      ...(typeof server['command'] === 'string' ? { command: server['command'] } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Minimal Codex config.toml extraction: top-level `[mcp_servers.<name>]` table
 * headers + their `command`. Nested sub-tables (`[mcp_servers.<name>.env]`) are
 * NOT servers and are skipped.
 */
function parseTomlMcpServers(text: string): Array<{ name: string; command?: string }> {
  const servers: Array<{ name: string; command?: string }> = [];
  const sections = text.split(/^\[/m);
  for (const section of sections) {
    const header = section.match(/^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]/);
    if (!header) continue;
    const command = section.match(/^command\s*=\s*["']([^"']+)["']/m);
    const name = header[1] ?? header[2] ?? header[3];
    if (name) servers.push({ name, ...(command ? { command: command[1]! } : {}) });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DiscoverMcpConfigOptions {
  /** OS user home override, primarily for tests. */
  homeDir?: string;
  /** Octocode home override; defaults to getOctocodeHome(). */
  octocodeHome?: string;
}

type McpConfigCandidate = Omit<DiscoveredMcpConfig, 'servers' | 'error'> & {
  /** Only Octocode-owned JSON configs accept an unwrapped root server map. */
  allowRootServers?: boolean;
};

function resolveDiscoveryRoots(options: string | DiscoverMcpConfigOptions | undefined): { homeDir: string; octocodeHome: string } {
  if (typeof options === 'string') {
    return { homeDir: options, octocodeHome: path.join(options, '.octocode') };
  }
  const homeDir = options?.homeDir ?? os.homedir();
  const octocodeHome = options?.octocodeHome
    ?? (options?.homeDir ? path.join(homeDir, '.octocode') : getOctocodeHome());
  return { homeDir, octocodeHome };
}

/**
 * Inventory MCP configs in official host locations. Active=true is restricted to canonical Octocode paths;
 * Claude, Cursor, Codex, and .agents files are metadata-only and never spawned.
 */
export function discoverMcpConfigs(
  cwd: string,
  options?: string | DiscoverMcpConfigOptions,
): DiscoveredMcpConfig[] {
  const { homeDir, octocodeHome } = resolveDiscoveryRoots(options);
  const candidates: McpConfigCandidate[] = [
    { path: path.join(cwd, '.octocode', 'agent', 'mcp', 'servers.json'), host: 'octocode', scope: 'project', format: 'json', active: true, allowRootServers: true },
    // Official and compatibility project inventory (never auto-loaded).
    { path: path.join(cwd, '.mcp.json'), host: 'claude', scope: 'project', format: 'json', active: false },
    { path: path.join(cwd, '.claude', 'mcp.json'), host: 'claude', scope: 'project', format: 'json', active: false },
    { path: path.join(cwd, '.cursor', 'mcp.json'), host: 'cursor', scope: 'project', format: 'json', active: false },
    { path: path.join(cwd, '.codex', 'config.toml'), host: 'codex', scope: 'project', format: 'toml', active: false },
    { path: path.join(cwd, '.agents', 'mcp.json'), host: 'agents', scope: 'project', format: 'json', active: false },
    { path: path.join(cwd, '.octocode', 'mcp.json'), host: 'octocode', scope: 'project', format: 'json', active: false, allowRootServers: true },
    { path: path.join(octocodeHome, 'agent', 'mcp', 'servers.json'), host: 'octocode', scope: 'user', format: 'json', active: true, allowRootServers: true },
    // Official and compatibility user inventory (never auto-loaded).
    { path: path.join(homeDir, '.claude.json'), host: 'claude', scope: 'user', format: 'json', active: false },
    { path: path.join(homeDir, '.claude', 'mcp.json'), host: 'claude', scope: 'user', format: 'json', active: false },
    { path: path.join(homeDir, '.cursor', 'mcp.json'), host: 'cursor', scope: 'user', format: 'json', active: false },
    { path: path.join(homeDir, '.codex', 'config.toml'), host: 'codex', scope: 'user', format: 'toml', active: false },
    { path: path.join(homeDir, '.agents', 'mcp.json'), host: 'agents', scope: 'user', format: 'json', active: false },
    { path: path.join(octocodeHome, 'mcp.json'), host: 'octocode', scope: 'user', format: 'json', active: false, allowRootServers: true },
  ];
  const found: DiscoveredMcpConfig[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.path) || !fs.existsSync(candidate.path)) continue;
    seen.add(candidate.path);
    const { allowRootServers = false, ...metadata } = candidate;
    try {
      const text = fs.readFileSync(candidate.path, 'utf8');
      const servers = candidate.format === 'toml'
        ? parseTomlMcpServers(text)
        : parseJsonMcpServers(text, allowRootServers);
      found.push({ ...metadata, servers });
    } catch (error) {
      found.push({ ...metadata, servers: [], error: (error as Error).message });
    }
  }
  return found;
}

export function getDiscoveryFilePath(cwd: string): string {
  return path.join(cwd, '.octocode', 'discovery.json');
}

export async function buildDiscoverySnapshot(
  ctx: PiContext | undefined,
  opts: {
    skills: DiscoveredSkill[];
    nativeTools: string[];
    home?: string;
    octocodeHome?: string;
    overhead?: {
      sysChars: number; mcpChars: number; dynamicChars: number;
      totalChars: number; mcpServers: number; mcpTools: number; skills: number;
    };
  },
): Promise<DiscoverySnapshot> {
  const workspace = ctx?.cwd ?? process.cwd();
  const sortedTools = [...opts.nativeTools].sort((a, b) => a.localeCompare(b));
  const systemPromptStats: SystemPromptStats | undefined = opts.overhead
    ? {
        sysChars: opts.overhead.sysChars,
        mcpChars: opts.overhead.mcpChars,
        dynamicChars: opts.overhead.dynamicChars,
        totalChars: opts.overhead.totalChars,
        estimatedTokens: Math.round(opts.overhead.totalChars / 4),
        mcpServers: opts.overhead.mcpServers,
        mcpTools: opts.overhead.mcpTools,
        skills: opts.overhead.skills,
      }
    : undefined;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspace,
    harness: '@octocodeai/pi-extension',
    ...(systemPromptStats ? { systemPromptStats } : {}),
    nativeTools: sortedTools,
    nativeToolCount: sortedTools.length,
    skills: opts.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      path: skill.path,
    })),
    mcp: {
      ...(await getMcpDiscoverySnapshot(ctx)),
      discoveredConfigs: discoverMcpConfigs(workspace, { homeDir: opts.home, octocodeHome: opts.octocodeHome }),
    },
  };
}

/**
 * Write the discovery inventory atomically. Returns the file path, or null when
 * the write failed (never throws — discovery is observability, not a dependency).
 */
export async function writeDiscoveryFile(
  ctx: PiContext | undefined,
  opts: {
    skills: DiscoveredSkill[];
    nativeTools: string[];
    home?: string;
    octocodeHome?: string;
    overhead?: { sysChars: number; mcpChars: number; dynamicChars: number;
                 totalChars: number; mcpServers: number; mcpTools: number; skills: number };
  },
): Promise<string | null> {
  try {
    const snapshot = await buildDiscoverySnapshot(ctx, opts);
    const filePath = getDiscoveryFilePath(snapshot.workspace);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
    return filePath;
  } catch {
    return null;
  }
}
