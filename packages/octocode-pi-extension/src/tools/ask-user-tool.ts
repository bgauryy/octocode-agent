/**
 * askUser — interactive elicitation tool.
 *
 * Lets the agent ask the human a question and get a real answer through the TUI
 * instead of dumping a numbered list in prose and hoping the user types the
 * matching token. Two modes, chosen from the arguments:
 *
 *   • options[]  → a keyboard-navigable SelectList overlay (↑↓ / enter / esc).
 *   • options[] + multiSelect → a checkbox overlay (space toggles, enter
 *     confirms once min/max are satisfied, esc cancels); options may carry a
 *     preview block shown while focused.
 *   • fields[]   → a simple sequential form: one input prompt per field,
 *     required fields re-prompt once before rejecting.
 *   • no options → a single-line text input prompt.
 *
 * Non-interactive hosts (rpc / json / print, or any host without `ctx.ui.custom`)
 * cannot show an overlay, so the tool returns a clear instruction telling the
 * agent to ask the question inline in its next message. It never blocks or fakes
 * an answer.
 */

import { CLI_GLYPH, CLI_STATUS_TEXT, cliToolTitle, paint } from '../tui/cli-design.js';
import type { ToolDefinition, ToolCallResult, PiTheme, PiContext } from '../types.js';
import type { registerUniqueTool } from './octocode-tools.js';
import { makeRenderer, truncateToWidth } from './render-helpers.js';
import { runMultiSelectOverlay, runSelectOverlay } from './ui-overlays.js';

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
  allowFreeText?: boolean;
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
function hasInteractiveUi(ctx?: PiContext): boolean {
  return Boolean(
    ctx?.hasUI &&
      (typeof ctx.ui?.select === 'function' ||
        typeof ctx.ui?.custom === 'function' ||
        typeof ctx.ui?.input === 'function'),
  );
}

const FREE_TEXT_SENTINEL = '__octocode_ask_free_text__';

/** Present a SelectList overlay and resolve with the picked option (or cancel). */
async function pickFromList(
  ctx: PiContext,
  question: string,
  options: AskOption[],
  allowFreeText: boolean,
  placeholder?: string,
): Promise<AskOutcome> {
  const items = options.map((o) => ({ value: o.value, label: o.label ?? o.value, description: o.description, preview: o.preview }));
  if (allowFreeText) {
    items.push({ value: FREE_TEXT_SENTINEL, label: '✎ Type my own answer…', description: undefined, preview: undefined });
  }

  const canUseNativeSelector = !allowFreeText && items.every((item) => !item.description && !item.preview && item.label === item.value);
  const picked = canUseNativeSelector && typeof ctx.ui?.select === 'function'
    ? await ctx.ui.select(question, items.map((item) => item.value))
    : await runSelectOverlay(ctx, { title: question, items });

  if (picked === null || picked === undefined) return { status: 'cancelled' };
  if (picked === FREE_TEXT_SENTINEL) return askText(ctx, question, placeholder);
  const match = options.find((o) => o.value === picked);
  return { status: 'selected', value: picked, label: match?.label ?? picked };
}

/** Present a single-line input prompt and resolve with the typed text. */
async function askText(ctx: PiContext, question: string, placeholder?: string): Promise<AskOutcome> {
  if (typeof ctx.ui?.input === 'function') {
    const text = await ctx.ui.input(question, placeholder);
    if (text === undefined) return { status: 'cancelled' };
    return { status: 'text', value: text };
  }
  return { status: 'unavailable' };
}

/** Present the checkbox multi-select overlay and resolve with the toggled values. */
async function pickMulti(
  ctx: PiContext,
  question: string,
  options: AskOption[],
  min?: number,
  max?: number,
): Promise<AskOutcome> {
  if (typeof ctx.ui?.custom !== 'function') return { status: 'unavailable' };
  const items = options.map((o) => ({ value: o.value, label: o.label ?? o.value, description: o.description, preview: o.preview }));
  const picked = await runMultiSelectOverlay(ctx, { title: question, items, min, max });
  if (picked === undefined) return { status: 'cancelled' };
  return { status: 'multiSelected', values: picked };
}

/**
 * Run a simple sequential form: one input prompt per field. Esc anywhere
 * cancels the whole form. A required field left empty re-prompts once with a
 * "(required)" suffix, then rejects (cancelled outcome carrying the field label).
 */
async function runForm(ctx: PiContext, question: string, fields: AskField[]): Promise<AskOutcome> {
  if (typeof ctx.ui?.input !== 'function') return { status: 'unavailable' };
  const values: Record<string, string> = {};
  for (const field of fields) {
    const label = field.label || field.name;
    let text = await ctx.ui.input(`${question} — ${label}`, field.placeholder);
    if (text === undefined) return { status: 'cancelled' };
    if (field.required && !text.trim()) {
      text = await ctx.ui.input(`${question} — ${label} (required)`, field.placeholder);
      if (text === undefined) return { status: 'cancelled' };
      if (!text.trim()) return { status: 'cancelled', label };
    }
    values[field.name] = text;
  }
  return { status: 'form', values };
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
      'Omit options (or set allowFreeText) to collect a free-text reply via an input prompt.',
      'Returns the selected value/label or the typed text. On cancel (esc) it reports the cancellation; on non-interactive hosts (rpc/json/print) it tells you to ask inline instead.',
      'Use for genuine decision points (pick a branch, choose an approach, confirm a target). Do not use it to replace normal conversation or to ask trivial yes/no — for yes/no prefer a two-option list.',
      'Set multiSelect (with optional min/max) to let the user toggle several options with space and confirm with enter — returns the chosen values[]. Options may carry a preview block shown while focused.',
      'Provide fields[] for a simple sequential form (one input prompt per field, required fields re-prompt once) — returns values keyed by field name.',
    ].join('\n'),
    promptSnippet: 'Ask the user a question via an interactive list picker or text input (real UI, not prose)',
    promptGuidelines: [
      'When you would otherwise print "reply 1/2/3", call askUser with options[] so the user selects from a real list.',
      'Keep option labels short and add a description for nuance; order options by recommendation with the safe default first.',
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
      allowFreeText: Type.Optional(
        Type.Boolean({ description: 'When true with options[], add a "Type my own answer" entry that opens a text input.' }),
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
        outcome = fields.length
          ? await runForm(ctx!, question, fields)
          : options.length
            ? p.multiSelect
              ? await pickMulti(ctx!, question, options, p.min, p.max)
              : await pickFromList(ctx!, question, options, Boolean(p.allowFreeText), p.placeholder)
            : await askText(ctx!, question, p.placeholder);
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
