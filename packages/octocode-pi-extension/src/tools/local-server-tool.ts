/**
 * localServer — first-class wrapper around the shared loopback static server.
 *
 * Features such as plan HTML, design reviews, diffs, and reports can use the
 * internal helper directly, but agents also need a visible, validated tool for
 * serving already-authored local artifacts. The server remains loopback-only,
 * static-only, and path-guarded.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolCallResult, PiContext, PiTheme } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { assertPathAllowed } from './path-guard.js';
import { resolveFilePath } from './file-state.js';
import { getLocalServerBaseUrl, listLocalServerMounts, serveDirectory, stopLocalServer, unmount } from './local-server.js';
import { cliStatusGlyph, cliToolTitle, paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

type LocalServerAction = 'serve' | 'unmount' | 'status' | 'stop';

interface LocalServerParams {
  action: LocalServerAction;
  name?: string;
  dir?: string;
  indexFile?: string;
}

function textResult(text: string, details: Record<string, unknown>, isError = false): ToolCallResult {
  return { content: [{ type: 'text', text }], details, isError } as unknown as ToolCallResult;
}

function cleanMountName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : '';
}

function renderStatus(): string {
  const baseUrl = getLocalServerBaseUrl();
  const mounts = listLocalServerMounts();
  if (!baseUrl) return '[localServer] stopped';
  if (mounts.length === 0) return `[localServer] running at ${baseUrl} (no mounts)`;
  return [`[localServer] running at ${baseUrl}`, ...mounts.map((m) => `- ${m.name}: ${baseUrl}${m.name}/ -> ${m.dir} (${m.indexFile})`)].join('\n');
}

export function registerLocalServerTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  registerFn(pi, registeredToolNames, {
    name: 'localServer',
    label: 'Local Server',
    description: [
      'Serve local, agent-authored static artifacts over a shared loopback-only HTTP server.',
      'Actions: serve (mount a directory), unmount (remove one mount), status (show base URL and mounts), stop (stop server and clear mounts).',
      'Use for HTML plan/design/report artifacts when a browser view helps. Do not open a browser automatically; ask the user first, or use a slash command that represents explicit user intent.',
      'Security: static files only, bound to 127.0.0.1, mount names are a single URL segment, and served directories must pass the Octocode path guard (cwd/home/tmp/ALLOWED_PATHS).',
    ].join('\n'),
    promptSnippet: 'Serve local static artifacts over a loopback-only, path-guarded local server.',
    promptGuidelines: [
      'Use localServer for generated HTML/Markdown artifacts that are clearer in a browser (plans, design diagrams, reports).',
      'Always ask before opening a browser; returning the localhost URL is safe, opening it is user-visible.',
      'Serve only directories you authored or inspected; never expose secrets, home directories wholesale, or untrusted downloads.',
      'Unmount or stop surfaces when they are no longer useful.',
    ],
    parameters: Type.Object({
      action: Type.Unsafe({ type: 'string', enum: ['serve', 'unmount', 'status', 'stop'], description: 'serve|unmount|status|stop' }),
      name: Type.Optional(Type.String({ description: 'Mount name: one safe URL path segment. Required for serve/unmount.' })),
      dir: Type.Optional(Type.String({ description: 'Directory to serve for action:serve. Relative paths resolve against cwd.' })),
      indexFile: Type.Optional(Type.String({ description: 'File served at the mount root for action:serve. Default index.html.' })),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext): Promise<ToolCallResult> {
      const p = raw as unknown as LocalServerParams;
      const cwd = ctx?.cwd ?? process.cwd();
      if (p.action === 'status') {
        return textResult(renderStatus(), { action: p.action, baseUrl: getLocalServerBaseUrl(), mounts: listLocalServerMounts() });
      }
      if (p.action === 'stop') {
        stopLocalServer();
        return textResult('[localServer] stopped', { action: p.action, baseUrl: undefined, mounts: [] });
      }

      const name = cleanMountName(p.name);
      if (!name) return textResult(`[localServer] ${p.action} requires a mount name.`, { action: p.action, error: 'missing-name' }, true);

      if (p.action === 'unmount') {
        unmount(name);
        return textResult(`[localServer] unmounted ${name}`, { action: p.action, name, baseUrl: getLocalServerBaseUrl(), mounts: listLocalServerMounts() });
      }

      if (p.action !== 'serve') {
        return textResult(`[localServer] unknown action: ${String(p.action)}`, { action: p.action, error: 'unknown-action' }, true);
      }

      const dirInput = typeof p.dir === 'string' ? p.dir.trim() : '';
      if (!dirInput) return textResult('[localServer] serve requires dir.', { action: p.action, name, error: 'missing-dir' }, true);
      const dir = resolveFilePath(dirInput, cwd);
      try {
        assertPathAllowed(dir, cwd, 'localServer serve');
        if (!fs.statSync(dir).isDirectory()) {
          return textResult(`[localServer] not a directory: ${dir}`, { action: p.action, name, dir, error: 'not-directory' }, true);
        }
      } catch (err) {
        return textResult(`[localServer] ${(err as Error).message}`, { action: p.action, name, dir, error: 'path-blocked' }, true);
      }

      const indexFile = typeof p.indexFile === 'string' && p.indexFile.trim() ? path.basename(p.indexFile.trim()) : 'index.html';
      const served = await serveDirectory(name, dir, { indexFile });
      if (!served) {
        return textResult('[localServer] could not mount directory (invalid name or server start failed).', { action: p.action, name, dir, indexFile, error: 'mount-failed' }, true);
      }
      return textResult(
        `[localServer] ${name}: ${served.url}\nServing ${dir} (${indexFile})`,
        { action: p.action, name, dir, indexFile, url: served.url, baseUrl: getLocalServerBaseUrl(), mounts: listLocalServerMounts() },
      );
    },

    renderCall(raw: unknown, theme?: PiTheme) {
      const p = raw as LocalServerParams;
      const suffix = p.action === 'serve' ? `${p.name ?? '?'} -> ${p.dir ?? '?'}` : p.name ? `${p.action} ${p.name}` : p.action;
      return makeRenderer((width) => [truncateToWidth(`${cliToolTitle(theme, 'localServer')} ${paint(theme, 'dim', suffix)}`, width)]);
    },

    renderResult(result: ToolCallResult, _opts: unknown, theme?: PiTheme) {
      const ok = !result.isError;
      const text = result.content.find((c) => c.type === 'text')?.text ?? '';
      const first = text.split('\n').find(Boolean) ?? (ok ? 'localServer ok' : 'localServer failed');
      return makeRenderer((width) => [truncateToWidth(`${paint(theme, ok ? 'success' : 'error', cliStatusGlyph(ok))} ${cliToolTitle(theme, 'localServer')} ${paint(theme, 'dim', first)}`, width)]);
    },
  });
}
