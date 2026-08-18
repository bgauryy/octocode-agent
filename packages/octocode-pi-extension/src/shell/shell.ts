/**
 * OctocodeShell — Phase C alpha skeleton for an own TUI shell that replaces
 * Pi's InteractiveMode.
 *
 * Design constraints (see docs/SHELL.md):
 *   - NO runtime dependency on `@earendil-works/pi-coding-agent` (peer-dep rule).
 *     The Pi runtime is passed in as a parameter and described only by the local
 *     structural interfaces below (ShellRuntime / ShellSession / ShellSessionEvent).
 *   - `@earendil-works/pi-tui` IS allowed (host-aliased by Pi's extension loader,
 *     same as src/tools/ui-overlays.ts).
 *
 * The shell is split into pure controller logic (createOctocodeShell) and a
 * pluggable I/O surface (ShellUi). The default ShellUi is pi-tui backed; tests
 * inject a fake ShellUi so the loop runs headless with no terminal.
 *
 * THIS MODULE HAS NO SIDE EFFECTS AT IMPORT TIME (safe to unit-test).
 */

import { Container, Editor, ProcessTerminal, Text, TUI } from '@earendil-works/pi-tui';
import type { EditorTheme, SelectListTheme } from '@earendil-works/pi-tui';

import { renderBannerWithTagline } from '../branding/banner.js';
import type { BannerTheme } from '../branding/banner.js';
import { CLI_GLYPH, cliPaint, formatCliToolRow, formatThinkingRow } from '../tui/cli-design.js';

// ── Structural Pi runtime surface ───────────────────────────────────────────
// Verified against @earendil-works/pi-coding-agent@0.80.3 d.ts (see docs/SHELL.md
// "Verified API surface"). Declared locally so the extension never imports the
// host package at type or runtime level.

/** Options accepted by AgentSession.prompt(). */
export interface ShellPromptOptions {
  /** Required by the host only while the agent is already streaming. */
  streamingBehavior?: 'steer' | 'followUp';
}

/**
 * Subset of `AgentSessionEvent` (union of the pi-agent-core AgentEvent plus
 * session events) that the alpha shell consumes. Kept as a wide structural
 * shape so the real event union is assignable at the launcher boundary.
 *
 * Anchors:
 *   - message_update.assistantMessageEvent: AssistantMessageEvent
 *     ({ type: "text_delta"; delta: string; ... }) — pi-ai/dist/types.d.ts.
 *   - tool_execution_start: { toolName; toolCallId; args } — pi-agent-core AgentEvent.
 */
export interface ShellSessionEvent {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    id?: string;
    toolName?: string;
    toolCall?: { id?: string; name?: string; input?: unknown; arguments?: unknown };
    contentIndex?: number;
  };
}

/** Structural view of AgentSession (agent-session.d.ts). */
export interface ShellSession {
  /** AgentSession.prompt(text, options?) */
  prompt(text: string, options?: ShellPromptOptions): Promise<void>;
  /** AgentSession.subscribe(listener) → unsubscribe */
  subscribe(listener: (event: ShellSessionEvent) => void): () => void;
  /** AgentSession.abort() */
  abort(): Promise<void>;
  /** AgentSession.isStreaming getter */
  readonly isStreaming: boolean;
}

/** Structural view of AgentSessionRuntime (agent-session-runtime.d.ts). */
export interface ShellRuntime {
  /** AgentSessionRuntime.session getter */
  readonly session: ShellSession;
}

// ── I/O surface ──────────────────────────────────────────────────────────────

/**
 * Pluggable rendering + input surface. The default implementation is pi-tui
 * backed; tests inject a fake to run the loop without a terminal.
 */
export interface ShellUi {
  /** Enter raw mode / start rendering. */
  start(): void;
  /** Restore the terminal and stop rendering. */
  stop(): void;
  /** Append a finished transcript line (implicit trailing newline). */
  print(line: string): void;
  /** Stream assistant text without a trailing newline. */
  appendDelta(text: string): void;
  /** Register the submit handler for editor input. */
  onSubmit(handler: (text: string) => void | Promise<void>): void;
  /** Register the abort handler (Escape / Ctrl+C). */
  onAbort(handler: () => void): void;
}

export interface OctocodeShellDeps {
  /** Inject a custom (or fake, for tests) I/O surface. Default: pi-tui backed. */
  ui?: ShellUi;
  /** Theme for the banner. Default: identity (no color). */
  theme?: BannerTheme;
  /** Version string shown after the wordmark. */
  version?: string;
  /** Banner width in columns. Default: 80. */
  width?: number;
}

export interface OctocodeShell {
  /** Run the interactive loop. Resolves with a process exit code on quit. */
  run(): Promise<number>;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Commands that cleanly exit the shell. */
const QUIT_COMMANDS = new Set(['/quit', '/exit', 'exit']);
const HELP_COMMANDS = new Set(['/help', '/?']);
const SHELL_HELP_LINES = [
  'OctocodeShell commands:',
  '  /help, /?     Show this help.',
  '  /quit, /exit  Exit the shell.',
  'Non-command input is sent to the agent. Unknown /commands are rejected.',
] as const;
/** Identity banner theme used when no themed renderer is supplied. */
const IDENTITY_BANNER_THEME: BannerTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

// ── Controller ───────────────────────────────────────────────────────────────

/**
 * Create the Octocode shell controller.
 *
 * Alpha scope: branded header, single-line-at-a-time editor input, prompt
 * submission to the real runtime, streamed text + tool-call notifications,
 * abort on Escape/Ctrl+C, and clean exit via /quit|/exit|exit.
 *
 * @param runtime  The Pi AgentSessionRuntime (passed by the launcher). Only the
 *                 structural ShellRuntime surface is used.
 * @param deps     Injectable UI/theme/version. Defaults produce a pi-tui shell.
 */
export function createOctocodeShell(
  runtime: ShellRuntime,
  deps: OctocodeShellDeps = {},
): OctocodeShell {
  const ui = deps.ui ?? createPiTuiUi();
  const theme = deps.theme ?? IDENTITY_BANNER_THEME;
  const width = deps.width ?? 80;

  return {
    async run(): Promise<number> {
      const session = runtime.session;

      // Resolve the run() promise exactly once, from either a quit command or
      // an unrecoverable UI teardown.
      let resolveExit!: (code: number) => void;
      const exit = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      let finished = false;
      const finish = (code: number): void => {
        if (finished) return;
        finished = true;
        unsubscribe();
        ui.stop();
        resolveExit(code);
      };

      // Stream runtime events to the screen.
      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case 'message_update': {
            const messageEvent = event.assistantMessageEvent;
            if (messageEvent?.type === 'thinking_start') {
              ui.print(formatThinkingRow('start', theme));
            } else if (messageEvent?.type === 'thinking_delta' && typeof messageEvent.delta === 'string') {
              ui.appendDelta(cliPaint(theme, 'dim', messageEvent.delta));
            } else if (messageEvent?.type === 'thinking_end') {
              ui.print(formatThinkingRow('end', theme));
            } else if (messageEvent?.type === 'toolcall_start') {
              // No row here: Pi's toolcall_start carries only {contentIndex,
              // partial} — no tool name — so printing produced a duplicate
              // "queued" frame with an undefined name. toolcall_end (which
              // carries the full toolCall) prints the single queued row.
            } else if (messageEvent?.type === 'toolcall_delta' && typeof messageEvent.delta === 'string') {
              ui.appendDelta(cliPaint(theme, 'dim', messageEvent.delta));
            } else if (messageEvent?.type === 'toolcall_end') {
              ui.print(formatCliToolRow(
                'queued',
                messageEvent.toolCall?.name ?? messageEvent.toolName ?? event.toolName,
                messageEvent.toolCall?.input ?? messageEvent.toolCall?.arguments,
                theme,
              ));
            } else if (messageEvent?.type === 'text_delta' && typeof messageEvent.delta === 'string') {
              ui.appendDelta(messageEvent.delta);
            }
            break;
          }
          case 'tool_execution_start':
            ui.print(formatCliToolRow('running', event.toolName, event.args, theme));
            break;
          case 'tool_execution_update':
            ui.print(formatCliToolRow('update', event.toolName, event.partialResult, theme));
            break;
          case 'tool_execution_end':
            ui.print(formatCliToolRow(event.isError ? 'failed' : 'done', event.toolName, event.result, theme));
            break;
          case 'agent_end':
            // Close the streamed assistant block with a blank line.
            ui.print('');
            break;
          default:
            // note: message_start/turn_*/compaction/retry/queue_update events are
            // ignored in the alpha loop. See parity-gap list in docs/SHELL.md.
            break;
        }
      });

      // Route editor submissions.
      ui.onSubmit(async (raw) => {
        const text = raw.trim();
        if (text.length === 0) return;
        const command = text.toLowerCase();
        if (QUIT_COMMANDS.has(command)) {
          finish(0);
          return;
        }
        if (HELP_COMMANDS.has(command)) {
          for (const line of SHELL_HELP_LINES) ui.print(line);
          return;
        }
        if (command.startsWith('/')) {
          ui.print(`unknown command: ${text} (try /help)`);
          return;
        }
        ui.print(`${CLI_GLYPH.prompt} ${text}`);
        try {
          // streamingBehavior is required by the host only mid-stream; queue as
          // a steer so a busy agent still accepts the new input.
          // note: alpha always steers; the steer/followUp toggle + message-queue
          // UI is a parity gap.
          await session.prompt(text, session.isStreaming ? { streamingBehavior: 'steer' } : undefined);
        } catch (err) {
          ui.print(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      // Escape / Ctrl+C aborts the current operation.
      // note: single-key abort only; double Ctrl+C-to-exit and Escape-to-clear
      // semantics are a parity gap.
      ui.onAbort(() => {
        void session.abort();
      });

      ui.start();

      // Branded header.
      for (const line of renderBannerWithTagline(theme, width, deps.version)) {
        ui.print(line);
      }
      ui.print('');

      return exit;
    },
  };
}

// ── Default pi-tui backed UI ──────────────────────────────────────────────────

const IDENTITY_SELECT_LIST_THEME: SelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
};

/**
 * Build the default pi-tui shell surface: a scrolling transcript Container above
 * a focused Editor. Real terminal I/O; not exercised by unit tests (they inject
 * a fake ShellUi), so this stays intentionally small.
 *
 * note: alpha has no footer/status bar, no autocomplete provider, no slash-command
 * palette, and no theme wiring. Those are parity gaps tracked in docs/SHELL.md.
 */
function createPiTuiUi(): ShellUi {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const transcript = new Container();
  const editorTheme: EditorTheme = {
    borderColor: (s) => s,
    selectList: IDENTITY_SELECT_LIST_THEME,
  };
  const editor = new Editor(tui, editorTheme);
  tui.addChild(transcript);
  tui.addChild(editor);

  // Streaming assistant buffer: a single Text component that grows with deltas
  // until the next finished line flushes it.
  let streaming: Text | null = null;
  let streamBuffer = '';

  const flushStream = (): void => {
    streaming = null;
    streamBuffer = '';
  };

  let submitHandler: ((text: string) => void | Promise<void>) | undefined;
  let abortHandler: (() => void) | undefined;

  editor.onSubmit = (text: string): void => {
    void submitHandler?.(text);
  };

  const removeInputListener = tui.addInputListener((data: string) => {
    // \x03 = Ctrl+C, \x1b (lone) = Escape.
    if (data === '\u0003' || data === '\u001b') {
      abortHandler?.();
      return { consume: true };
    }
    return undefined;
  });

  return {
    start(): void {
      tui.start();
      tui.setFocus(editor);
    },
    stop(): void {
      removeInputListener();
      tui.stop();
    },
    print(line: string): void {
      flushStream();
      transcript.addChild(new Text(line));
      tui.requestRender();
    },
    appendDelta(text: string): void {
      streamBuffer += text;
      if (!streaming) {
        streaming = new Text('');
        transcript.addChild(streaming);
      }
      streaming.setText(streamBuffer);
      tui.requestRender();
    },
    onSubmit(handler): void {
      submitHandler = handler;
    },
    onAbort(handler): void {
      abortHandler = handler;
    },
  };
}
