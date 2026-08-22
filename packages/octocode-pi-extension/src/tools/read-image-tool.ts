/**
 * read-image-tool — registers the `readImage` tool: load a local image file and
 * return it as an image content block so a vision-capable model can see it.
 *
 * Why this exists: the Octocode harness disables pi's built-in `read` (which
 * natively returns image content), and our reading path (`localGetFileContent`,
 * MCP) is text-only. So the model otherwise cannot see local images/screenshots.
 * This tool bridges that gap using Pi's native multimodal pipeline — it does NOT
 * do recognition/OCR itself; the configured vision model does that.
 *
 * The returned block matches pi-ai's ImageContent shape ({type:"image", data,
 * mimeType}); Pi normalizes/auto-resizes oversized images as they enter history.
 */

import path from 'node:path';
import type { TSchema, ToolCallResult, ToolDefinition, PiTheme } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { cliStatusGlyph, cliStatusToken, cliToolTitle, paint } from '../tui/cli-design.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { assertPathAllowed } from './path-guard.js';
import { resolveFilePath } from './file-state.js';
import { formatBytes, isTerminalImageCapable, loadImageForRender } from './image-render.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

export interface ReadImageResult {
  ok: boolean;
  message: string;
  mimeType?: string;
  base64?: string;
  bytes?: number;
}

/**
 * Core: resolve + load an image file. Pure of Pi types so it is unit-testable.
 * Returns ok:false with a reason for missing/oversized/non-image files
 * (loadImageForRender enforces the 4MB cap + format sniffing, never throws).
 */
export function readImageFile(filePath: string, cwd: string): ReadImageResult {
  const abs = resolveFilePath(filePath, cwd);
  assertPathAllowed(abs, cwd, 'readImage');
  const loaded = loadImageForRender(abs);
  if (!loaded) {
    return {
      ok: false,
      message: `Cannot read image "${filePath}": missing, empty, larger than 4MB, or not a supported image (png/jpeg/gif/webp).`,
    };
  }
  const bytes = Math.floor((loaded.base64.length * 3) / 4);
  return {
    ok: true,
    message: `Read image ${path.basename(abs)} [${loaded.mimeType}, ${formatBytes(bytes)}]`,
    mimeType: loaded.mimeType,
    base64: loaded.base64,
    bytes,
  };
}

function buildParameters(Type: TypeBoxBuilder): TSchema {
  return Type.Object(
    {
      path: Type.String({ minLength: 1, description: 'Path to a local image file (png/jpeg/gif/webp), relative or absolute.' }),
    },
    { additionalProperties: false },
  );
}

export function registerReadImageTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  registerFn(pi, registeredToolNames, {
    name: 'readImage',
    label: 'Read Image',
    description:
      'Load a local image file (png/jpeg/gif/webp) and return it so a vision-capable model can see it. ' +
      'Use for screenshots, diagrams, or UI captures on disk — the model does the recognition/OCR, this tool only delivers the pixels. ' +
      'Returns an image block plus a short text note; oversized images are auto-resized by the host. Requires a vision-capable model.',
    promptSnippet: 'Show a local image/screenshot file to the vision model (no OCR engine — the model reads it).',
    promptGuidelines: [
      'Use readImage to let the model actually see a local image/screenshot; localGetFileContent is text-only and cannot.',
      'Recognition/OCR is the model\'s job — readImage only delivers the image. Needs a vision-capable model (input includes "image").',
      'Only png/jpeg/gif/webp up to 4MB are supported; larger or non-image files are rejected with a reason.',
      'On terminals without inline-image support (VS Code/tmux), the image won\'t render — OFFER to open the file in a browser and ALWAYS ask the user first (askUser); never open a browser automatically.',
    ],
    parameters: buildParameters(Type),
    async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal, _onUpdate?: unknown, ctx?: { cwd?: string }): Promise<ToolCallResult> {
      if (signal?.aborted) throw new Error('Operation aborted');
      const filePath = params['path'];
      if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('readImage: `path` is required.');
      const cwd = ctx?.cwd ?? process.cwd();
      const res = readImageFile(filePath, cwd);
      if (!res.ok) {
        return { content: [{ type: 'text', text: res.message }], isError: true, details: { ok: false } };
      }
      // On terminals without inline-image support the picture won't render; the
      // file is already on disk, so tell the agent to offer opening it in a
      // browser — asking the user first, never auto-opening.
      const capable = isTerminalImageCapable();
      const note = capable
        ? res.message
        : `${res.message} — this terminal has no inline-image support (e.g. VS Code / tmux), so it won't render here. Offer to open ${resolveFilePath(filePath, cwd)} in a browser; ask the user first, never open automatically.`;
      return {
        content: [
          { type: 'image', data: res.base64!, mimeType: res.mimeType! },
          { type: 'text', text: note },
        ],
        details: { ok: true, mimeType: res.mimeType, bytes: res.bytes, terminalSupportsImages: capable },
      };
    },

    renderCall(args: unknown, theme?: PiTheme) {
      const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      const filePath = typeof input['path'] === 'string' ? (input['path'] as string) : '(missing path)';
      const title = cliToolTitle(theme, 'readImage');
      return makeRenderer((width) => [truncateToWidth(`${title} ${paint(theme, 'dim', filePath)}`, width)]);
    },

    renderResult(result: ToolCallResult, opts: { expanded?: boolean; isPartial?: boolean }, theme?: PiTheme) {
      if (opts.isPartial) return makeRenderer(() => [paint(theme, 'brand', '… reading image')]);
      const ok = !result.isError;
      const note = (result.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? (ok ? 'image loaded' : 'read failed');
      const icon = paint(theme, cliStatusToken(ok), cliStatusGlyph(ok));
      // The image itself is rendered by pi's tool-execution component from the
      // returned {type:'image'} content block (Kitty/iTerm2) — we only render the
      // status line here, otherwise the image would appear twice.
      return makeRenderer((width) => [truncateToWidth(`${icon} ${cliToolTitle(theme, 'readImage')} · ${note}`, width)]);
    },
  });
}
