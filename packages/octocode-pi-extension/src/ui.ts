import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { McpHub } from './mcp.js';

const BANNER_ENTRY = 'octocode-banner';

const WORDMARK = [
  ' ██████╗  ██████╗████████╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔═══██╗██╔════╝╚══██╔══╝██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║   ██║██║        ██║   ██║   ██║██║     ██║   ██║██║  ██║█████╗  ',
  '██║   ██║██║        ██║   ██║   ██║██║     ██║   ██║██║  ██║██╔══╝  ',
  '╚██████╔╝╚██████╗   ██║   ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═════╝  ╚═════╝   ╚═╝    ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
];
const WORDMARK_WIDTH = Math.max(...WORDMARK.map((line) => line.length));

export function packageVersion(): string | undefined {
  try {
    const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Pure in (theme, width) and always the same height: the banner is the first
 * transcript entry, and a height change on resize would make Pi redraw (and
 * clear) the whole scrollback.
 */
export function bannerLines(fg: (color: string, text: string) => string, width: number, version?: string): string[] {
  const art = width >= WORDMARK_WIDTH ? WORDMARK.map((line) => fg('accent', line)) : [fg('accent', 'octocode'), ...WORDMARK.slice(1).map(() => '')];
  const tagline = `${fg('muted', 'research-driven coding agent')}${version ? fg('dim', `  v${version}`) : ''}`;
  // Every line must fit the width, however narrow the terminal.
  return [...art, tagline, ''].map((line) => truncateToWidth(line, Math.max(1, width)));
}

export function registerUi(pi: ExtensionAPI, hub: McpHub, isSubagent: boolean): void {
  if (isSubagent) return;
  const version = packageVersion();
  pi.registerEntryRenderer(BANNER_ENTRY, (_entry, _options, theme) => ({
    render: (width: number) => bannerLines((color, text) => theme.fg(color as never, text), width, version),
    invalidate: () => undefined,
  }));

  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const shown = ctx.sessionManager.getEntries().some((entry) => entry.type === 'custom' && entry.customType === BANNER_ENTRY);
    if (!shown) pi.appendEntry(BANNER_ENTRY, {});
    ctx.ui.setTitle(`octocode · ${path.basename(ctx.cwd)}`);
    ctx.ui.setWorkingIndicator({
      frames: ['·', '•', '●', '•'].map((frame) => ctx.ui.theme.fg('accent', frame)),
      intervalMs: 140,
    });
    updateStatus(ctx, hub);
  });

  // Generation speed of the last run as a quiet footer segment (never a pop-up). Only time spent streaming
  // assistant messages counts: tool calls, subagents and askUser waits would otherwise drag the number down.
  let generated = { output: 0, ms: 0 };
  let messageStartedAt: number | undefined;
  pi.on('agent_start', async () => {
    generated = { output: 0, ms: 0 };
    messageStartedAt = undefined;
  });
  pi.on('message_start', async (event) => {
    if (event.message.role === 'assistant') messageStartedAt = Date.now();
  });
  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant' || messageStartedAt === undefined) return;
    generated.ms += Date.now() - messageStartedAt;
    generated.output += event.message.usage.output;
    messageStartedAt = undefined;
  });
  pi.on('agent_end', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const speed = tokensPerSecond(generated.output, generated.ms);
    if (speed !== undefined) ctx.ui.setStatus('octocode-speed', ctx.ui.theme.fg('dim', `${speed.toFixed(0)} tok/s`));
  });
}

/** Output tokens per second of streaming time, or undefined when nothing was generated. */
export function tokensPerSecond(outputTokens: number, streamingMs: number): number | undefined {
  return streamingMs > 0 && outputTokens > 0 ? outputTokens / (streamingMs / 1000) : undefined;
}

/** One quiet footer segment: MCP health. Called when servers finish connecting. */
export function updateStatus(ctx: ExtensionContext, hub: McpHub): void {
  if (!ctx.hasUI) return;
  const servers = [...hub.servers.values()];
  if (servers.length === 0) return ctx.ui.setStatus('octocode', undefined);
  const ready = servers.filter((server) => server.status === 'ready').length;
  const failed = servers.filter((server) => server.status === 'failed').length;
  const connecting = servers.length - ready - failed;
  const theme = ctx.ui.theme;
  const parts = [`mcp ${ready}/${servers.length}`];
  if (connecting > 0) parts.push(theme.fg('dim', 'connecting'));
  if (failed > 0) parts.push(theme.fg('error', `${failed} failed`));
  ctx.ui.setStatus('octocode', parts.join(' '));
}
