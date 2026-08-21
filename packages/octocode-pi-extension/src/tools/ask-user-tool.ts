/**
 * askUser — interactive elicitation tool.
 *
 * Lets the agent ask the human a question and get a real answer through the TUI
 * instead of dumping a numbered list in prose and hoping the user types the
 * matching token. Modes are chosen from the arguments and rendered INLINE via
 * ctx.ui.custom(builder) (no overlay options), so the prompt appears in the
 * conversation/message flow at the bottom — reading as part of the message list
 * — rather than as a floating modal box pinned over the conversation:
 *
 *   • options[]  → a keyboard-navigable numbered list (↑↓ / 1-9 quick-select /
 *     enter / esc) with an always-available custom free-text answer; long lists
 *     scroll in a window around the cursor.
 *   • options[] + multiSelect → a checkbox list (space or 1-9 toggles, enter
 *     confirms once min/max are satisfied, esc cancels) with a live selection
 *     count in the footer; options may carry a preview block shown while focused.
 *   • fields[]   → a simple sequential form; required fields warn once before
 *     rejecting.
 *   • no options → a single-line text prompt.
 *
 * Non-interactive hosts (rpc / json / print, or any host without overlay
 * support) return a clear instruction telling the agent to ask the question
 * inline in its next message. The tool never uses Pi's built-in select/input
 * surfaces, and it never blocks or fakes an answer.
 */

import { CLI_GLYPH, CLI_STATUS_TEXT, cliToolTitle, paint } from '../tui/cli-design.js';
import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { makeRenderer, truncateToWidth, visibleWidth } from './render-helpers.js';
import { CURSOR_MARKER, Key, matchesKey } from '@earendil-works/pi-tui';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

interface AskOption {
  value: string;
  label?: string;
  description?: string;
  /** Optional multi-line preview shown under the option while it is focused (multi-select overlay). */
  preview?: string;
}

interface AskField {
  name: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
}

interface AskParams {
  question: string;
  options?: Array<AskOption | string>;
  placeholder?: string;
  multiSelect?: boolean;
  min?: number;
  max?: number;
  fields?: AskField[];
}

interface AskOutcome {
  status: 'selected' | 'text' | 'cancelled' | 'unavailable' | 'multiSelected' | 'form';
  value?: string;
  label?: string;
  /** multiSelected → string[] of chosen values; form → Record<fieldName, answer>. */
  values?: string[] | Record<string, string>;
}

function normalizeOptions(raw: AskParams['options']): AskOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (typeof o === 'string' ? { value: o } : o))
    .filter((o): o is AskOption => Boolean(o && typeof o.value === 'string' && o.value.length > 0))
    .map((o) => ({ value: o.value, label: o.label || o.value, description: o.description, preview: o.preview }));
}

function normalizeFields(raw: AskParams['fields']): AskField[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is AskField => Boolean(f && typeof f.name === 'string' && f.name.length > 0));
}
function supportsAskOverlay(ctx?: PiContext): boolean {
  // Guard on mode === 'tui': in RPC mode hasUI is true and custom() exists but
  // RETURNS undefined (per pi docs), which would make askUser silently resolve
  // as cancelled instead of falling back to an inline question. custom() is a
  // TUI-only feature.
  return Boolean(ctx?.mode === 'tui' && ctx?.hasUI && typeof ctx.ui?.custom === 'function');
}

function hasInteractiveUi(ctx?: PiContext): boolean {
  return supportsAskOverlay(ctx);
}

function isCancelKey(data: string): boolean {
  return data === '\x1b' || data === '\x03';
}

function isEnterKey(data: string): boolean {
  return data === '\r' || data === '\n';
}

function isBackspaceKey(data: string): boolean {
  return data === '\x7f' || data === '\b';
}

function isPrintableInput(data: string): boolean {
  if (!data) return false;
  return [...data].every((ch) => {
    const code = ch.charCodeAt(0);
    return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  });
}

/**
 * A width-aware “smart separator”: paint `prefixPlain` then fill the rest of the
 * row with the box rule char up to the terminal width, so every widget frame
 * spans the panel cleanly at any size instead of a fixed stub.
 */
function ruleLine(theme: PiTheme | undefined, prefixPlain: string, width: number, token: 'brand' | 'dim' | 'warning'): string {
  const fill = Math.max(0, (width || 0) - visibleWidth(prefixPlain));
  return paint(theme, token, prefixPlain + '─'.repeat(fill));
}

function askHeaderLines(theme: PiTheme | undefined, question: string, width: number): string[] {
  const bar = paint(theme, 'brand', '│');
  return [
    ruleLine(theme, '╭─ ◆ USER INPUT REQUIRED ', width, 'brand'),
    `${bar} ${question}`,
    bar,
  ];
}

function askFooterLine(theme: PiTheme | undefined, help: string, width: number, warning?: string): string {
  return warning
    ? ruleLine(theme, `╰─ ⚠ ${warning} `, width, 'warning')
    : ruleLine(theme, `╰─ ${help} `, width, 'dim');
}

/** Max option rows painted at once; longer lists scroll in a window around the cursor. */
const ASK_LIST_MAX_VISIBLE = 8;

function renderAskChoiceLines(
  theme: PiTheme | undefined,
  question: string,
  items: Array<{ label: string; description?: string; preview?: string; freeText?: boolean }>,
  cursor: number,
  selected: Set<number> | undefined,
  help: string,
  width: number,
  warning?: string,
): string[] {
  const bar = paint(theme, 'brand', '│');
  // Scroll window: long lists would overflow the terminal height (pi clips the
  // component), so paint at most ASK_LIST_MAX_VISIBLE rows centered on the
  // cursor with dim "N more" markers for the hidden remainder.
  let start = 0;
  let end = items.length;
  if (items.length > ASK_LIST_MAX_VISIBLE) {
    start = Math.min(
      Math.max(0, cursor - Math.floor(ASK_LIST_MAX_VISIBLE / 2)),
      items.length - ASK_LIST_MAX_VISIBLE,
    );
    end = start + ASK_LIST_MAX_VISIBLE;
  }
  const rows = items.slice(start, end).flatMap((item, offset) => {
    const index = start + offset;
    const active = index === cursor;
    const marker = active ? paint(theme, 'brand', '›') : ' ';
    const checked = selected ? (selected.has(index) ? paint(theme, 'success', '☑') : paint(theme, 'dim', '☐')) : '';
    // Numbered rows advertise the 1-9 quick-select keys; the free-text row is unnumbered.
    const ordinal = !item.freeText && index < 9 ? paint(theme, active ? 'brand' : 'dim', `${index + 1}.`) + ' ' : '';
    const rawLabel = item.freeText ? paint(theme, 'brand', item.label) : (active ? paint(theme, 'brand', item.label) : item.label);
    const desc = item.description ? paint(theme, 'dim', ` — ${item.description}`) : '';
    const line = `${bar} ${marker} ${checked ? `${checked} ` : ''}${ordinal}${rawLabel}${desc}`;
    const preview = active && item.preview
      ? item.preview.split('\n').slice(0, 3).map((l) => `${bar}     ${paint(theme, 'dim', l)}`)
      : [];
    return [line, ...preview];
  });
  if (start > 0) rows.unshift(`${bar} ${paint(theme, 'dim', `↑ ${start} more`)}`);
  if (end < items.length) rows.push(`${bar} ${paint(theme, 'dim', `↓ ${items.length - end} more`)}`);
  return [
    ...askHeaderLines(theme, question, width),
    ...rows,
    askFooterLine(theme, help, width, warning),
  ];
}

function renderAskTextLines(
  theme: PiTheme | undefined,
  question: string,
  value: string,
  placeholder: string | undefined,
  help: string,
  width: number,
  warning?: string,
): string[] {
  const bar = paint(theme, 'brand', '│');
  const shown = value.length > 0 ? value : paint(theme, 'dim', placeholder ?? 'type answer…');
  return [
    ...askHeaderLines(theme, question, width),
    `${bar} ${paint(theme, 'brand', '›')} ${shown}`,
    askFooterLine(theme, help, width, warning),
  ];
}

async function runAskOverlay(
  ctx: PiContext,
  params: {
    question: string;
    options: AskOption[];
    placeholder?: string;
    multiSelect?: boolean;
    min?: number;
    max?: number;
    fields?: AskField[];
  },
): Promise<AskOutcome | undefined> {
  if (!supportsAskOverlay(ctx)) return undefined;

  const options = params.options.map((o) => ({ ...o, label: o.label ?? o.value }));
  const fields = params.fields ?? [];

  // Render INLINE (non-overlay ctx.ui.custom) so the prompt appears in the
  // conversation/message flow at the bottom — reading as part of the message
  // list — instead of a floating modal box pinned over the conversation. When
  // the prompt resolves it disappears and the tool result (renderResult) is what
  // remains in the scrollback. The free-text "type my own answer" row is always
  // appended AFTER the listed options so the user can redirect instead of being
  // boxed into the choices.
  return ctx.ui!.custom!<AskOutcome>(
    (tuiRaw: unknown, theme: PiTheme, _kb: unknown, done: (o: AskOutcome) => void) => {
      const tui = tuiRaw as { requestRender?: () => void };
      let finished = false;
      let cursor = 0;
      let text = '';
      let fieldIndex = 0;
      let requiredRetry = false;
      let warning: string | undefined;
      const selected = new Set<number>();
      const formValues: Record<string, string> = {};
      let mode: 'single' | 'multi' | 'text' | 'form' = fields.length
        ? 'form'
        : options.length
          ? params.multiSelect
            ? 'multi'
            : 'single'
          : 'text';

      const finish = (outcome: AskOutcome): void => {
        if (finished) return;
        finished = true;
        done(outcome);
      };
      const rerender = (): void => tui?.requestRender?.();

      const render = (width: number): string[] => {
        const w = width > 0 ? width : 80;
        if (mode === 'text') {
          return renderAskTextLines(theme, params.question, text, params.placeholder, 'enter submit • esc cancel', w, warning);
        }
        if (mode === 'form') {
          const field = fields[fieldIndex]!;
          const label = field.label || field.name;
          const step = `${fieldIndex + 1}/${fields.length}`;
          return renderAskTextLines(theme, `${params.question} — ${label} (${step})`, text, field.placeholder, 'enter next • esc cancel', w, warning);
        }
        const rows: Array<{ label: string; description?: string; preview?: string; freeText?: boolean }> =
          options.map((o) => ({ label: o.label!, description: o.description, preview: o.preview }));
        rows.push({ label: '✎ Type my own answer…', description: 'custom free-text reply', freeText: true });
        const multiCount = mode === 'multi'
          ? `${selected.size} selected${params.min ? ` · min ${params.min}` : ''}${params.max ? ` · max ${params.max}` : ''} • `
          : '';
        return renderAskChoiceLines(
          theme,
          params.question,
          rows,
          cursor,
          mode === 'multi' ? selected : undefined,
          mode === 'multi'
            ? `${multiCount}↑↓ navigate • space toggle • 1-9 toggle • enter confirm • esc cancel`
            : '↑↓ navigate • 1-9 select • enter select • esc cancel',
          w,
          warning,
        );
      };

      const move = (delta: number): void => {
        const extra = mode === 'single' || mode === 'multi' ? 1 : 0;
        const count = Math.max(1, options.length + extra);
        cursor = (cursor + delta + count) % count;
        warning = undefined;
        rerender();
      };

      const handle = (data: string): void => {
        if (finished) return;
        if (isCancelKey(data)) { finish({ status: 'cancelled' }); return; }

        if (mode === 'single' || mode === 'multi') {
          if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl('p'))) { move(-1); return; }
          if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl('n'))) { move(1); return; }
          // Digit quick keys mirror the numbered rows: single-select picks the
          // option outright; multi-select toggles it (enter still confirms).
          if (/^[1-9]$/.test(data)) {
            const index = Number(data) - 1;
            if (index < options.length) {
              cursor = index;
              warning = undefined;
              if (mode === 'single') {
                const picked = options[index]!;
                finish({ status: 'selected', value: picked.value, label: picked.label ?? picked.value });
                return;
              }
              if (selected.has(index)) selected.delete(index);
              else if (params.max === undefined || selected.size < params.max) selected.add(index);
              else warning = `Choose at most ${params.max} option${params.max === 1 ? '' : 's'}.`;
              rerender();
            }
            return;
          }
          if (mode === 'multi' && data === ' ') {
            if (cursor === options.length) { mode = 'text'; text = ''; warning = undefined; rerender(); return; }
            if (selected.has(cursor)) selected.delete(cursor);
            else if (params.max === undefined || selected.size < params.max) selected.add(cursor);
            else warning = `Choose at most ${params.max} option${params.max === 1 ? '' : 's'}.`;
            rerender();
            return;
          }
          if (isEnterKey(data)) {
            if (cursor === options.length) { mode = 'text'; text = ''; warning = undefined; rerender(); return; }
            if (mode === 'multi') {
              const min = params.min ?? 0;
              if (selected.size < min) {
                warning = `Choose at least ${min} option${min === 1 ? '' : 's'}.`;
                rerender();
                return;
              }
              finish({ status: 'multiSelected', values: [...selected].sort((a, b) => a - b).map((i) => options[i]!.value) });
              return;
            }
            const picked = options[cursor];
            finish({ status: 'selected', value: picked?.value, label: picked?.label ?? picked?.value });
            return;
          }
          return;
        }

        if (isEnterKey(data)) {
          if (mode === 'form') {
            const field = fields[fieldIndex]!;
            const label = field.label || field.name;
            if (field.required && !text.trim()) {
              if (requiredRetry) { finish({ status: 'cancelled', label }); return; }
              requiredRetry = true;
              warning = `${label} is required.`;
              rerender();
              return;
            }
            formValues[field.name] = text;
            fieldIndex += 1;
            text = '';
            requiredRetry = false;
            warning = undefined;
            if (fieldIndex >= fields.length) finish({ status: 'form', values: formValues });
            else rerender();
            return;
          }
          finish({ status: 'text', value: text });
          return;
        }
        if (isBackspaceKey(data)) { text = text.slice(0, -1); warning = undefined; rerender(); return; }
        if (isPrintableInput(data)) { text += data; warning = undefined; rerender(); return; }
      };

      // Focusable component: when the overlay has focus in a text/form mode we
      // emit CURSOR_MARKER at the input caret so pi positions the hardware cursor
      // there (IME candidate windows for CJK etc.). The marker MUST be appended
      // AFTER truncateToWidth — our sanitizer strips the marker's trailing BEL,
      // and pi strips the marker itself before display.
      const comp: {
        focused: boolean;
        render: (w: number) => string[];
        invalidate: () => void;
        handleInput: (data: string) => void;
      } = {
        focused: false,
        render: (w: number) => {
          const lines = render(w).map((line) => truncateToWidth(line, w));
          if (comp.focused && (mode === 'text' || mode === 'form')) {
            const caret = lines.findIndex((l) => l.includes('\u203a'));
            if (caret >= 0) lines[caret] = lines[caret] + CURSOR_MARKER;
          }
          return lines;
        },
        invalidate: () => { /* stateless: re-render pulls current state */ },
        handleInput: (data: string) => handle(data),
      };
      return comp;
    },
    // No overlay options: a non-overlay component renders inline in the message
    // flow (at the bottom of the conversation, where input normally lives) and
    // automatically owns input focus while active, so the prompt appears in the
    // message list rather than as a floating modal. pi sets `comp.focused` for
    // the active inline component, which drives the IME cursor marker.
  );
}

export function registerAskUserTool(
  pi: { registerTool?(def: ToolDefinition): void },
  Type: TypeBoxBuilder,
  registeredToolNames: Set<string>,
  registerFn: RegisterFn,
): void {
  registerFn(pi, registeredToolNames, {
    name: 'askUser',
    label: 'Ask user',
    description: [
      'Ask the human a question and get a real, structured answer through the terminal UI.',
      'Provide options[] to show a keyboard-navigable list the user arrows through and selects — never make the user type a token that matches a prose list.',
      'Omit options to collect a free-text reply; when options[] is present, a custom free-text answer row is always included.',
      'Returns the selected value/label or the typed text. On cancel (esc) it reports the cancellation; on non-interactive hosts (rpc/json/print) it tells you to ask inline instead.',
      'Use for genuine decision points (pick a branch, choose an approach, confirm a target). Do not use it to replace normal conversation or to ask trivial yes/no — for yes/no prefer a two-option list.',
      'Set multiSelect (with optional min/max) to let the user toggle several options with space and confirm with enter — returns the chosen values[]. Options may carry a preview block shown while focused.',
      'Provide fields[] for a simple sequential form (one input prompt per field, required fields re-prompt once) — returns values keyed by field name.',
    ].join('\n'),
    promptSnippet: 'Ask the user a question via an interactive list picker or text input (real UI, not prose)',
    promptGuidelines: [
      'When you would otherwise print "reply 1/2/3", call askUser with options[] so the user selects from a real list.',
      'Keep option labels short and add a description for nuance; order options by recommendation with the safe default first; the UI always includes a custom free-text answer row.',
      'If askUser reports the host is non-interactive or the user cancelled, fall back to asking the question directly in your reply.',
      'Use multiSelect when several answers can be true at once (pick files, pick checks to run); set min/max only when the task genuinely constrains the count.',
      'Use fields[] to gather a few related short answers in one call instead of a chain of separate free-text questions.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'The question to show the user. Keep it one clear sentence.' }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            value: Type.String({ description: 'Value returned to you when this option is chosen.' }),
            label: Type.Optional(Type.String({ description: 'Short display label (defaults to value).' })),
            description: Type.Optional(Type.String({ description: 'Optional one-line nuance shown under the label.' })),
            preview: Type.Optional(Type.String({ description: 'Optional multi-line preview shown under the option while it is focused (multi-select overlay).' })),
          }),
          { description: 'Options for a list picker. Omit for a free-text prompt.' },
        ),
      ),
      placeholder: Type.Optional(Type.String({ description: 'Placeholder for the free-text input.' })),
      multiSelect: Type.Optional(
        Type.Boolean({ description: 'With options[]: let the user toggle several options (space) and confirm (enter). Returns the chosen values[].' }),
      ),
      min: Type.Optional(Type.Integer({ minimum: 0, description: 'Multi-select only: minimum number of selections required to confirm.' })),
      max: Type.Optional(Type.Integer({ minimum: 1, description: 'Multi-select only: maximum number of selections allowed.' })),
      fields: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: 'Key for this answer in the returned values object.' }),
            label: Type.Optional(Type.String({ description: 'Prompt label shown to the user (defaults to name).' })),
            placeholder: Type.Optional(Type.String({ description: 'Placeholder for this field input.' })),
            required: Type.Optional(Type.Boolean({ description: 'Re-prompt once when left empty, then reject the form.' })),
          }),
          { description: 'Simple sequential form: one text input per field, answers returned keyed by name. Takes precedence over options[].' },
        ),
      ),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext): Promise<ToolCallResult> {
      const p = raw as unknown as AskParams;
      const question = String(p.question ?? '').trim();
      if (!question) {
        return { content: [{ type: 'text', text: '[askUser] error: question is required.' }], isError: true };
      }
      const options = normalizeOptions(p.options);
      const fields = normalizeFields(p.fields);

      if (!hasInteractiveUi(ctx)) {
        const mode = ctx?.mode ?? 'unknown';
        const listHint = options.length
          ? ` Present these options inline and ask them to choose: ${options.map((o) => o.label).join(', ')}.`
          : '';
        const multiHint = p.multiSelect && options.length ? ' The user may choose more than one.' : '';
        const fieldHint = fields.length
          ? ` Collect these fields inline: ${fields.map((f) => f.label || f.name).join(', ')}.`
          : '';
        return {
          content: [{
            type: 'text',
            text: `[askUser] No interactive UI available (mode=${mode}). Ask the user this question directly in your next message.${listHint}${multiHint}${fieldHint}`,
          }],
          details: { status: 'unavailable', mode },
        } as unknown as ToolCallResult;
      }

      let outcome: AskOutcome;
      try {
        outcome = (await runAskOverlay(ctx!, {
          question,
          options,
          placeholder: p.placeholder,
          multiSelect: p.multiSelect,
          min: p.min,
          max: p.max,
          fields,
        })) ?? { status: 'cancelled' };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[askUser] UI error: ${err instanceof Error ? err.message : String(err)}. Ask the user inline instead.` }],
          isError: true,
        };
      }

      // Every outcome echoes the question: the tool result is what survives in
      // the transcript (and compaction summaries), and an answer without its
      // question is meaningless there.
      switch (outcome.status) {
        case 'selected':
          return {
            content: [{ type: 'text', text: `Question: ${question}\nUser selected: ${outcome.label}\nvalue: ${outcome.value}` }],
            details: outcome,
          } as unknown as ToolCallResult;
        case 'text':
          return {
            content: [{ type: 'text', text: `Question: ${question}\nUser answered: ${outcome.value}` }],
            details: outcome,
          } as unknown as ToolCallResult;
        case 'multiSelected': {
          const values = Array.isArray(outcome.values) ? outcome.values : [];
          const labels = values.map((v) => options.find((o) => o.value === v)?.label ?? v);
          return {
            content: [{
              type: 'text',
              text: `Question: ${question}\nUser selected ${values.length} option${values.length === 1 ? '' : 's'}: ${labels.join(', ') || '(none)'}\nvalues: ${JSON.stringify(values)}`,
            }],
            details: outcome,
          } as unknown as ToolCallResult;
        }
        case 'form': {
          const record = (outcome.values ?? {}) as Record<string, string>;
          const body = fields.map((f) => `${f.name}: ${record[f.name] ?? ''}`).join('\n');
          return {
            content: [{ type: 'text', text: `Question: ${question}\nUser provided:\n${body}` }],
            details: outcome,
          } as unknown as ToolCallResult;
        }
        case 'cancelled': {
          const requiredNote = outcome.label ? ` Required field "${outcome.label}" was left empty.` : '';
          return {
            content: [{ type: 'text', text: `[askUser] User cancelled (esc) the question: "${question}".${requiredNote} Proceed without a forced choice or ask again if the answer is essential.` }],
            details: outcome,
          } as unknown as ToolCallResult;
        }
        default:
          return {
            content: [{ type: 'text', text: '[askUser] Input prompt unavailable on this host. Ask the user inline instead.' }],
            details: outcome,
          } as unknown as ToolCallResult;
      }
    },

    renderCall(raw: unknown, theme?: PiTheme) {
      const p = raw as AskParams;
      const q = String(p?.question ?? 'ask');
      const count = Array.isArray(p?.options) ? p.options.length : 0;
      const fieldCount = Array.isArray(p?.fields) ? p.fields.length : 0;
      const suffix = fieldCount > 0
        ? ` (form: ${fieldCount} field${fieldCount === 1 ? '' : 's'})`
        : count > 0
          ? p?.multiSelect
            ? ` (${count} options, multi)`
            : ` (${count} options)`
          : ' (free text)';
      const title = cliToolTitle(theme, 'askUser');
      const body = paint(theme, 'dim', q + suffix);
      return makeRenderer((w) => [truncateToWidth(`${title} ${body}`, w)]);
    },

    renderResult(result: ToolCallResult, _opts: unknown, theme?: PiTheme) {
      const d = (result.details ?? {}) as AskOutcome;
      let line: string;
      if (d.status === 'selected') line = paint(theme, 'success', `${CLI_GLYPH.success} ${d.label}`);
      else if (d.status === 'text') line = paint(theme, 'success', `${CLI_GLYPH.success} ${d.value}`);
      else if (d.status === 'multiSelected') {
        const n = Array.isArray(d.values) ? d.values.length : 0;
        line = paint(theme, 'success', `${CLI_GLYPH.success} ${n} selected`);
      } else if (d.status === 'form') {
        const n = d.values && !Array.isArray(d.values) ? Object.keys(d.values).length : 0;
        line = paint(theme, 'success', `${CLI_GLYPH.success} form submitted (${n} field${n === 1 ? '' : 's'})`);
      }
      else if (d.status === 'cancelled') line = paint(theme, 'warning', `⨯ ${CLI_STATUS_TEXT.cancelled}`);
      else line = paint(theme, 'dim', CLI_STATUS_TEXT.unavailable);
      return makeRenderer((w) => [truncateToWidth(line, w)]);
    },
  });
}
