import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAskUser } from './ask.js';
import { BrowserTool, registerBrowserTool } from './browser.js';
import { registerCompaction } from './compaction.js';
import { FileGuard, registerFileTool } from './file-tool.js';
import { mcpToolName } from './mcp-config.js';
import { describeServers, McpHub, registerMcpLoader } from './mcp.js';
import { octocodePrompt } from './prompt.js';
import { registerSkills } from './skills.js';
import { loadProfiles, registerAgentTool, SUBAGENT_ENV, type AgentProfile } from './subagents.js';
import { packageVersion, registerUi, updateStatus } from './ui.js';
import { registerWebTool } from './web.js';

const PROMPT_MCP_WAIT_MS = 10_000;
/** Octocode's file reader; while it is active it stands in for Pi's read. */
const OCTOCODE_READ_TOOL = mcpToolName('octocode', 'localGetFileContent');

/**
 * Octocode for Pi. Everything here builds on Pi's own tools, skills, sessions
 * and compaction; Octocode adds guarded file edits, MCP, subagents, web and
 * browser tools, askUser, a focused prompt and quiet UI chrome.
 */
export default function octocode(pi: ExtensionAPI): void {
  const isSubagent = process.env[SUBAGENT_ENV] === '1';
  const guard = new FileGuard();
  const hub = new McpHub(pi);
  const browser = new BrowserTool();
  let profiles = new Map<string, AgentProfile>();
  let prompt: string | undefined;
  /** Ready MCP servers the current prompt was built for; the prompt and tool set change together. */
  let promptServers: string | undefined;
  /** True while Octocode's local file tool stands in for Pi's read; read comes back if Octocode goes away. */
  let readReplaced = false;

  registerFileTool(pi, guard);
  registerMcpLoader(pi, hub);
  registerWebTool(pi);
  registerBrowserTool(pi, browser);
  if (!isSubagent) {
    registerAskUser(pi);
    registerAgentTool(pi, () => profiles);
  }
  registerSkills(pi);
  registerCompaction(pi, guard);
  registerUi(pi, hub, isSubagent);

  pi.on('session_start', async (_event, ctx) => {
    profiles = loadProfiles(ctx.cwd, undefined, ctx.isProjectTrusted());
    prompt = undefined;
    promptServers = undefined;
    guard.reset();
    readReplaced = false;
    hub.start(ctx, {
      onConfigError: (file, error) => {
        if (ctx.hasUI) ctx.ui.notify(`Ignoring invalid MCP config ${file}: ${String(error)}`, 'warning');
      },
      onStatusChange: () => {
        try {
          updateStatus(ctx, hub);
        } catch {
          // The session was replaced while a server was connecting.
        }
      },
    });
  });

  pi.on('before_agent_start', async (event) => {
    if (prompt === undefined) await hub.ready(PROMPT_MCP_WAIT_MS);
    // One active-set update per turn (getActiveTools does not reflect a set made earlier in this handler):
    // add newly connected eager MCP tools; `file` replaces Pi's edit/write, and Octocode's local tools
    // replace read once they are connected.
    // The prompt and the read replacement use the same snapshot, so the prompt never names a tool that is gone.
    const ready = [...hub.servers.values()].filter((server) => server.status === 'ready').map((server) => server.name);
    const current = pi.getActiveTools();
    const candidates = [...new Set([...current, ...hub.takePendingActivation()])];
    // Replace Pi's tools only with replacements that are actually active: a `--tools` allowlist or
    // `--exclude-tools` may leave out `file` or Octocode's reader, and the agent must never lose editing or reading.
    const octocodeReady = ready.includes('octocode') && candidates.includes(OCTOCODE_READ_TOOL);
    const replaced = new Set([...(candidates.includes('file') ? ['edit', 'write'] : []), ...(octocodeReady ? ['read'] : [])]);
    const next = candidates.filter((name) => !replaced.has(name));
    if (octocodeReady && current.includes('read')) readReplaced = true;
    else if (!octocodeReady && readReplaced) {
      // Octocode disconnected after replacing read: without this the agent could not read files at all.
      readReplaced = false;
      if (!next.includes('read')) next.push('read');
    }
    if (next.length !== current.length || next.some((name, index) => name !== current[index])) pi.setActiveTools(next);
    // Rebuilt only when the ready servers change (e.g. Octocode connected after the first turn), keeping the cache stable otherwise.
    if (prompt === undefined || promptServers !== ready.join(',')) {
      promptServers = ready.join(',');
      prompt = octocodePrompt({
        mcpServers: ready,
        profiles: [...profiles.values()].map(({ name, description }) => ({ name, description })),
        canDelegate: !isSubagent,
      });
    }
    // The run's tools come from the prompt options, so they must match the new active set.
    event.systemPromptOptions.selectedTools = next;
    // A named section (not a whole-prompt override) lets Pi record a small transcript delta.
    event.systemPromptOptions.sections['octocode'] = prompt;
    return undefined;
  });

  pi.on('session_shutdown', async () => {
    await hub.close();
  });

  pi.registerCommand('mcp', {
    description: 'Show MCP servers and their tools',
    handler: async (_args, ctx) => {
      await hub.ready(5_000);
      ctx.ui.notify(describeServers(hub), 'info');
    },
  });

  pi.registerCommand('octocode', {
    description: 'Show Octocode status: version, MCP servers, subagent profiles',
    handler: async (_args, ctx) => {
      const servers = [...hub.servers.values()].map((server) => `${server.name} (${server.status}, ${server.tools.length} tools)`);
      ctx.ui.notify(
        [
          `Octocode ${packageVersion() ?? ''}`.trim(),
          `MCP: ${servers.join(', ') || 'none'}`,
          `Subagents: ${[...profiles.keys()].join(', ') || 'none'}`,
        ].join('\n'),
        'info',
      );
    },
  });
}
