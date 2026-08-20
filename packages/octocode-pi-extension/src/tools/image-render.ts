/**
 * image-render — inline terminal images for tool renderers (F1).
 *
 * index.ts wiring: NONE required. chrome-debug-tool.ts and browser-agent-tool.ts
 * import buildImageLines / appendImageLines directly; there is no registration
 * step and nothing to add to src/index.ts.
 *
 * Renders screenshots inline in expanded tool views via pi-tui's Image
 * component (Kitty graphics / iTerm2 inline images). Capability-gated: under
 * terminals without an image protocol (tmux, VSCode, Windows Terminal,
 * alacritty, …) a one-line themed placeholder is emitted instead.
 *
 * CRITICAL invariant: lines returned for a real image contain raw escape
 * sequences plus empty height-padding lines that pi's TUI special-cases via
 * isImageLine(). They MUST NEVER pass through truncateToWidth or any other
 * width-truncation helper — truncation would corrupt the escape payload and
 * break the TUI's image-row accounting. Everything returned by buildImageLines
 * is already final: placeholders are pre-truncated, image lines are raw.
 * Callers must append these lines verbatim (see appendImageLines).
 */

import fs from 'node:fs';
import path from 'node:path';

import { Image, detectCapabilities } from '@earendil-works/pi-tui';

import { paint } from '../tui/palette.js';
import type { PiTheme, RenderCallReturn, RenderContext } from '../types.js';
import { truncateToWidth } from './render-helpers.js';

// ─── Limits / constants ───────────────────────────────────────────────────────

/** Refuse to inline files larger than this — base64 blows up memory and the terminal. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

/** ctx.state cache-key prefix so re-renders reuse the same Image instance (and Kitty image ID). */
const STATE_KEY_PREFIX = 'octocode-image:';

/** Default max rendered width in terminal cells (pi's own default, clamped to width-2 by Image). */
const MAX_WIDTH_CELLS = 60;

// ─── Mime sniffing ────────────────────────────────────────────────────────────

/**
 * Detect an image mime type from magic bytes. Supports the four formats
 * pi-tui's Image component can size-parse: png / jpeg / gif / webp.
 */
export function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12
    && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

// ─── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load an image file for terminal rendering. Returns undefined (never throws)
 * when the file is missing, unreadable, not a regular file, larger than 4MB,
 * or not a recognized image format.
 */
export function loadImageForRender(filePath: string): { base64: string; mimeType: string } | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return undefined;
    const buf = fs.readFileSync(filePath);
    const mimeType = sniffImageMime(buf);
    if (!mimeType) return undefined;
    return { base64: buf.toString('base64'), mimeType };
  } catch {
    return undefined;
  }
}

// ─── Capability gate (injectable for tests) ───────────────────────────────────

type CapabilityCheck = () => boolean;

const defaultCapabilityCheck: CapabilityCheck = () => {
  try {
    // images is null under tmux/screen, VSCode, Windows Terminal, alacritty, unknown.
    return detectCapabilities().images != null;
  } catch {
    return false;
  }
};

let capabilityCheck: CapabilityCheck = defaultCapabilityCheck;

/** Test seam: override (or pass undefined to restore) the terminal-image capability check. */
export function setCapabilityCheckForTests(check?: CapabilityCheck): void {
  capabilityCheck = check ?? defaultCapabilityCheck;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileSize(filePath: string, base64: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return Math.floor((base64.length * 3) / 4);
  }
}

/**
 * Build final, ready-to-emit lines that display `filePath` inline.
 *
 * - Unsupported terminal (or ctx.showImages === false): one placeholder line,
 *   themed and pre-truncated to `width` — safe as-is.
 * - Supported terminal: pi-tui Image lines (escape sequence + empty padding
 *   rows). These are RAW — callers must NOT run them through truncateToWidth.
 * - Unloadable / oversized / non-image file: empty array (render nothing).
 *
 * The Image instance is cached in ctx.state['octocode-image:<path>'] so
 * streaming re-renders reuse it (stable Kitty image ID, no re-encode).
 */
export function buildImageLines(
  ctx: RenderContext | undefined,
  filePath: string,
  width: number,
  theme?: PiTheme,
): string[] {
  const loaded = loadImageForRender(filePath);
  if (!loaded) return [];

  const name = path.basename(filePath);
  const supported = capabilityCheck() && ctx?.showImages !== false;

  if (!supported) {
    const size = formatBytes(fileSize(filePath, loaded.base64));
    const placeholder = paint(theme, 'dim', `🖼 image: ${name} (${size})`);
    // Placeholder is plain themed text — truncating it here keeps the contract
    // that everything buildImageLines returns is already final.
    return [truncateToWidth(placeholder, Math.max(4, width))];
  }

  const key = `${STATE_KEY_PREFIX}${filePath}`;
  let img = ctx?.state?.[key] as Image | undefined;
  if (!(img instanceof Image)) {
    img = new Image(
      loaded.base64,
      loaded.mimeType,
      { fallbackColor: (s: string) => paint(theme, 'dim', s) },
      { maxWidthCells: MAX_WIDTH_CELLS, filename: name },
    );
    if (ctx?.state) ctx.state[key] = img;
  }

  // Raw image lines — escape sequences + padding. NEVER truncate these.
  return img.render(width);
}

/**
 * Wrap an existing renderer so it also emits the image at `filePath` after its
 * own (width-truncated) lines. The appended image lines bypass truncation —
 * this is the only sanctioned way to combine makeRenderer output with images.
 */
export function appendImageLines(
  base: RenderCallReturn,
  ctx: RenderContext | undefined,
  filePath: string,
  theme?: PiTheme,
): RenderCallReturn {
  return {
    render: (width = 80) => [
      ...base.render(width),
      ...buildImageLines(ctx, filePath, width, theme),
    ],
    invalidate: () => base.invalidate(),
  };
}
