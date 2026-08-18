/**
 * askUser — interactive elicitation tool.
 *
 * Lets the agent ask the human a question and get a real answer through the TUI
 * instead of dumping a numbered list in prose and hoping the user types the
 * matching token. Two modes, chosen from the arguments:
 *
 *   • options[]  → a keyboard-navigable SelectList overlay (↑↓ / enter / esc).
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
import { runSelectOverlay } from './ui-overlays.js';

type TypeBoxBuilder = (typeof import('typebox'))['Type'];
type RegisterFn = typeof registerUniqueTool;

interface AskOption {
  value: string;
  label?: string;
  description?: string;
}

interface AskParams {
  question: string;
  options?: Array<AskOption | string>;
  allowFreeText?: boolean;
  placeholder?: string;
}

interface AskOutcome {
  status: 'selected' | 'text' | 'cancelled' | 'unavailable';
  value?: string;
  label?: string;
}

function normalizeOptions(raw: AskParams['options']): AskOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => (typeof o === 'string' ? { value: o } : o))
    .filter((o): o is AskOption => Boolean(o && typeof o.value === 'string' && o.value.length > 0))
    .map((o) => ({ value: o.value, label: o.label || o.value, description: o.description }));
}

function hasInteractiveUi(ctx?: PiContext): boolean {
  return Boolean(ctx?.hasUI && typeof ctx.ui?.custom === 'function');
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
  const items = options.map((o) => ({ value: o.value, label: o.label ?? o.value, description: o.description }));
  if (allowFreeText) {
    items.push({ value: FREE_TEXT_SENTINEL, label: '✎ Type my own answer…', description: undefined });
  }

  const picked = await runSelectOverlay(ctx, { title: question, items });

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
    ].join('\n'),
    promptSnippet: 'Ask the user a question via an interactive list picker or text input (real UI, not prose)',
    promptGuidelines: [
      'When you would otherwise print "reply 1/2/3", call askUser with options[] so the user selects from a real list.',
      'Keep option labels short and add a description for nuance; order options by recommendation with the safe default first.',
      'If askUser reports the host is non-interactive or the user cancelled, fall back to asking the question directly in your reply.',
    ],
    parameters: Type.Object({
      question: Type.String({ description: 'The question to show the user. Keep it one clear sentence.' }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            value: Type.String({ description: 'Value returned to you when this option is chosen.' }),
            label: Type.Optional(Type.String({ description: 'Short display label (defaults to value).' })),
            description: Type.Optional(Type.String({ description: 'Optional one-line nuance shown under the label.' })),
          }),
          { description: 'Options for a list picker. Omit for a free-text prompt.' },
        ),
      ),
      allowFreeText: Type.Optional(
        Type.Boolean({ description: 'When true with options[], add a "Type my own answer" entry that opens a text input.' }),
      ),
      placeholder: Type.Optional(Type.String({ description: 'Placeholder for the free-text input.' })),
    }),

    async execute(_id: string, raw: Record<string, unknown>, _signal, _onUpdate, ctx?: PiContext): Promise<ToolCallResult> {
      const p = raw as unknown as AskParams;
      const question = String(p.question ?? '').trim();
      if (!question) {
        return { content: [{ type: 'text', text: '[askUser] error: question is required.' }], isError: true };
      }
      const options = normalizeOptions(p.options);

      if (!hasInteractiveUi(ctx)) {
        const mode = ctx?.mode ?? 'unknown';
        const listHint = options.length
          ? ` Present these options inline and ask them to choose: ${options.map((o) => o.label).join(', ')}.`
          : '';
        return {
          content: [{
            type: 'text',
            text: `[askUser] No interactive UI available (mode=${mode}). Ask the user this question directly in your next message.${listHint}`,
          }],
          details: { status: 'unavailable', mode },
        } as unknown as ToolCallResult;
      }

      let outcome: AskOutcome;
      try {
        outcome = options.length
          ? await pickFromList(ctx!, question, options, Boolean(p.allowFreeText), p.placeholder)
          : await askText(ctx!, question, p.placeholder);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `[askUser] UI error: ${err instanceof Error ? err.message : String(err)}. Ask the user inline instead.` }],
          isError: true,
        };
      }

      switch (outcome.status) {
        case 'selected':
          return {
            content: [{ type: 'text', text: `User selected: ${outcome.label}\nvalue: ${outcome.value}` }],
            details: outcome,
          } as unknown as ToolCallResult;
        case 'text':
          return {
            content: [{ type: 'text', text: `User answered: ${outcome.value}` }],
            details: outcome,
          } as unknown as ToolCallResult;
        case 'cancelled':
          return {
            content: [{ type: 'text', text: '[askUser] User cancelled (esc). Proceed without a forced choice or ask again if the answer is essential.' }],
            details: outcome,
          } as unknown as ToolCallResult;
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
      const suffix = count > 0 ? ` (${count} options)` : ' (free text)';
      const title = cliToolTitle(theme, 'askUser');
      const body = paint(theme, 'dim', q + suffix);
      return makeRenderer((w) => [truncateToWidth(`${title} ${body}`, w)]);
    },

    renderResult(result: ToolCallResult, _opts: unknown, theme?: PiTheme) {
      const d = (result.details ?? {}) as AskOutcome;
      let line: string;
      if (d.status === 'selected') line = paint(theme, 'success', `${CLI_GLYPH.success} ${d.label}`);
      else if (d.status === 'text') line = paint(theme, 'success', `${CLI_GLYPH.success} ${d.value}`);
      else if (d.status === 'cancelled') line = paint(theme, 'warning', `⨯ ${CLI_STATUS_TEXT.cancelled}`);
      else line = paint(theme, 'dim', CLI_STATUS_TEXT.unavailable);
      return makeRenderer((w) => [truncateToWidth(line, w)]);
    },
  });
}
