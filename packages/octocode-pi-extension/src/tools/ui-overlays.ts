/**
 * ui-overlays — reusable Octocode TUI overlay helpers built on `@earendil-works/pi-tui`.
 *
 * We deliberately depend ONLY on pi-tui (which Pi's extension loader aliases to the
 * host copy), NOT on `@earendil-works/pi-coding-agent` helpers like getSelectListTheme /
 * DynamicBorder / SessionSelectorComponent: those are not our dependency and are not
 * guaranteed to resolve from the extension's install location at runtime. We reimplement
 * the small pieces we need (theme mapping, a framed select overlay with type-to-filter)
 * against the pi-tui primitives so the overlay works on any Pi that ships pi-tui.
 */

import { Box, Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { PiTheme, PiContext } from "../types.js";
import { MultiSelectList, multiSelectKeyAction, type MultiSelectTheme } from "./multi-select-list.js";
import { truncateToWidth } from "./render-helpers.js";
import { CLI_GLYPH } from "../tui/cli-design.js";

/** Branded overlay title line, consistent across select / multi-select overlays. */
function overlayHeading(theme: PiTheme | undefined, title: string): string {
  const text = `${CLI_GLYPH.brand} ${title}`;
  return theme?.fg?.("accent", theme?.bold?.(text) ?? text) ?? text;
}

/** pi-tui SelectList theme shape (5 colorizer fns). */
export interface SelectListThemeFns {
  selectedPrefix: (t: string) => string;
  selectedText: (t: string) => string;
  description: (t: string) => string;
  scrollInfo: (t: string) => string;
  noMatch: (t: string) => string;
}

const id = (t: string) => t;

/** Map the Octocode/Pi theme to a pi-tui SelectList theme (accent/muted/dim/warning). */
export function octocodeSelectListTheme(theme?: PiTheme): SelectListThemeFns {
  const fg = (color: Parameters<PiTheme['fg']>[0]) => (t: string) => theme?.fg?.(color, t) ?? id(t);
  return {
    selectedPrefix: fg("accent"),
    selectedText: fg("accent"),
    description: fg("muted"),
    scrollInfo: fg("dim"),
    noMatch: fg("warning"),
  };
}

export interface FilterKeyResult {
  buffer: string;
  changed: boolean;
}

/**
 * Pure key handler for a type-to-filter buffer. Returns the next buffer and whether it
 * changed. Appends printable chars, deletes on backspace (DEL 0x7f / BS 0x08), and
 * ignores navigation/control keys (arrows, enter, tab, esc, ctrl-c) which the SelectList
 * handles itself.
 */
export function applyFilterKey(
  buffer: string,
  keyData: string,
): FilterKeyResult {
  if (keyData === "\x7f" || keyData === "\b") {
    if (buffer.length === 0) return { buffer, changed: false };
    return { buffer: buffer.slice(0, -1), changed: true };
  }
  // Single printable character (space through ~). Excludes ESC-sequences (multi-char),
  // CR/LF, TAB, and control bytes.
  if (keyData.length === 1 && keyData >= " " && keyData <= "~") {
    return { buffer: buffer + keyData, changed: true };
  }
  return { buffer, changed: false };
}

export interface SelectOverlayItem {
  value: string;
  label: string;
  description?: string;
  /** Optional multi-line preview shown under the item while focused (multi-select overlay only). */
  preview?: string;
}

export interface SelectOverlayOptions {
  title: string;
  items: SelectOverlayItem[];
  /** Enable type-to-filter (adds a filter line + wires SelectList.setFilter). Default true when >8 items. */
  filter?: boolean;
  maxVisible?: number;
}

/**
 * Present a framed, keyboard-navigable select overlay and resolve with the chosen value
 * (or null on cancel). Type-to-filter is wired through the pure `applyFilterKey` buffer.
 * Returns undefined when the host has no interactive UI.
 */
export async function runSelectOverlay(
  ctx: PiContext | undefined,
  opts: SelectOverlayOptions,
): Promise<string | null | undefined> {
  if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") return undefined;
  const enableFilter = opts.filter ?? opts.items.length > 8;

  return ctx.ui.custom<string | null>(
    (
      tui: any,
      theme: PiTheme,
      _kb: unknown,
      done: (v: string | null) => void,
    ) => {
      const container = new Container();
      container.addChild(new Text(overlayHeading(theme, opts.title), 1, 0));

      let filter = "";
      const filterLine = enableFilter
        ? new Text(theme?.fg?.("dim", "filter: ") ?? "filter: ", 1, 0)
        : undefined;
      if (filterLine) container.addChild(filterLine);

      const list = new SelectList(
        opts.items.map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description,
        })) as any,
        Math.min(opts.maxVisible ?? 10, Math.max(1, opts.items.length)),
        octocodeSelectListTheme(theme) as any,
      );
      (list as any).onSelect = (item: { value: string }) => done(item.value);
      (list as any).onCancel = () => done(null);

      // Frame the list body with a padded Box for a native, distinct look.
      const body = new Box(1, 0);
      body.addChild(list);
      container.addChild(body);

      const help = enableFilter
        ? "↑↓ navigate • type to filter • enter select • esc cancel"
        : "↑↓ navigate • enter select • esc cancel";
      container.addChild(new Text(theme?.fg?.("dim", help) ?? help, 1, 0));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (enableFilter) {
            const next = applyFilterKey(filter, data);
            if (next.changed) {
              filter = next.buffer;
              (list as any).setFilter?.(filter);
              filterLine?.setText?.(
                theme?.fg?.("dim", `filter: ${filter}`) ?? `filter: ${filter}`,
              );
              tui?.requestRender?.();
              return;
            }
          }
          (list as any).handleInput(data);
          tui?.requestRender?.();
        },
      };
    },
    { overlay: true },
  );
}

// ─── Multi-select overlay ─────────────────────────────────────────────────────

export interface MultiSelectOverlayOptions {
  title: string;
  items: SelectOverlayItem[];
  /** Minimum selections required before enter confirms (default 0). */
  min?: number;
  /** Maximum selections allowed — extra toggles are no-ops (default unlimited). */
  max?: number;
  /** Values pre-toggled when the overlay opens. */
  initial?: string[];
}

/**
 * Present a framed, keyboard-navigable multi-select overlay (space toggles,
 * enter confirms once min/max are satisfied, esc cancels) and resolve with the
 * chosen values in display order. Resolves undefined on cancel or when the
 * host has no interactive UI. All list state lives in the pure MultiSelectList;
 * this wrapper only owns host plumbing, mirroring runSelectOverlay.
 */
export async function runMultiSelectOverlay(
  ctx: PiContext | undefined,
  opts: MultiSelectOverlayOptions,
): Promise<string[] | undefined> {
  if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") return undefined;

  const result = await ctx.ui.custom<string[] | null>(
    (
      tui: any,
      theme: PiTheme,
      _kb: unknown,
      done: (v: string[] | null) => void,
    ) => {
      const heading = overlayHeading(theme, opts.title);
      const help = "↑↓ navigate • space toggle • enter confirm • esc cancel";
      const helpLine = theme?.fg?.("dim", help) ?? help;

      const list = new MultiSelectList(
        opts.items.map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description,
          preview: o.preview,
        })),
        { min: opts.min, max: opts.max, initial: opts.initial },
      );

      return {
        render: (w: number) =>
          [heading, ...list.render(w, theme as unknown as MultiSelectTheme), helpLine].map(
            (line) => truncateToWidth(line, w),
          ),
        invalidate: () => {},
        handleInput: (data: string) => {
          const action = multiSelectKeyAction(data);
          if (action === "cancel") {
            done(null);
            return;
          }
          if (action === "confirm") {
            if (list.canConfirm()) {
              done(list.selectedValues());
              return;
            }
            // Not confirmable yet — fall through so the warning footer redraws.
          } else if (action === "up") list.moveCursor(-1);
          else if (action === "down") list.moveCursor(1);
          else if (action === "toggle") list.toggle();
          tui?.requestRender?.();
        },
      };
    },
    { overlay: true },
  );
  return result ?? undefined;
}

// Re-export for callers that only need width-safe truncation alongside overlays.
export { truncateToWidth };
