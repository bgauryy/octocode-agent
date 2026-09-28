import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { showAskDialog, type AskQuestion, type AskResult } from './ask-dialog.js';

const OTHER = 'Type something.';

/** RPC hosts have dialogs but no custom TUI components: fall back to select/input per question. */
export async function askWithDialogs(ctx: ExtensionContext, questions: AskQuestion[], signal?: AbortSignal): Promise<AskResult> {
  const answers: AskResult['answers'] = [];
  for (const q of questions) {
    const labels = q.options.map((option) => (option.description ? `${option.label} — ${option.description}` : option.label));
    const picked = await ctx.ui.select(q.question, [...labels, OTHER], signal ? { signal } : undefined);
    if (picked === undefined) return { answers, cancelled: true };
    if (picked === OTHER) {
      const typed = await ctx.ui.input(q.question, undefined, signal ? { signal } : undefined);
      if (typed === undefined) return { answers, cancelled: true };
      answers.push({ question: q.question, answer: typed, custom: true });
    } else {
      answers.push({ question: q.question, answer: q.options[labels.indexOf(picked)]?.label ?? picked, custom: false });
    }
  }
  return { answers, cancelled: false };
}

export function formatAnswers(result: AskResult): string {
  const answered = result.answers.map((entry) => `"${entry.question}" → ${entry.custom ? `(typed) ${entry.answer}` : entry.answer}`);
  if (!result.cancelled) return answered.join('\n');
  // Answers given before the user cancelled still count.
  const declined = `The user declined to answer${answered.length > 0 ? ' the remaining questions' : ''}. Continue with your best judgment and state the assumption you made, or stop if the choice is not safe to make.`;
  return [...answered, declined].join('\n');
}

export function registerAskUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'askUser',
    label: 'Ask user',
    description:
      'Ask the user 1–4 multiple-choice questions when the right choice depends on their preference or on information you cannot find with tools (requirements, scope, trade-offs between valid approaches). ' +
      "Put the recommended option first and append ' (Recommended)' to its label. Each option must be a complete answer; users can always type their own, so do not add an 'Other' option. " +
      'Do not use it for questions you can answer by reading code or running commands, or to ask permission for routine steps.',
    promptSnippet: 'Ask the user multiple-choice questions and wait for the answers',
    executionMode: 'sequential',
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: 'The complete question, ending with "?"' }),
          header: Type.String({ description: 'Very short label shown as a tab, max 12 characters (e.g. "Auth", "Scope")' }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: 'The answer, 1–5 words' }),
              description: Type.String({ description: 'What choosing it means or its trade-off' }),
            }),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Optional(Type.Boolean({ description: 'Allow choosing several options' })),
        }),
        { minItems: 1, maxItems: 4 },
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: 'text', text: 'No interactive user is available. Proceed with the recommended option and state that assumption.' }],
          details: { answers: [], cancelled: true } satisfies AskResult,
        };
      }
      const questions = params.questions.map((q) => ({ ...q, header: q.header.slice(0, 12) }));
      const result = ctx.mode === 'tui' ? await showAskDialog(ctx, questions, signal) : await askWithDialogs(ctx, questions, signal);
      return { content: [{ type: 'text', text: formatAnswers(result) }], details: result };
    },
    renderCall(args, theme) {
      const headers = (args.questions ?? []).map((q) => q.header).filter(Boolean).join(', ');
      return new Text(`${theme.fg('toolTitle', theme.bold('askUser'))} ${theme.fg('muted', headers)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as AskResult | undefined;
      if (!details) return new Text('', 0, 0);
      const lines = details.answers.map((entry) => `${theme.fg('success', '✓')} ${theme.fg('muted', entry.question)} ${entry.answer}`);
      if (details.cancelled) lines.push(theme.fg('warning', lines.length > 0 ? 'Declined the remaining questions' : 'Declined'));
      return new Text(lines.join('\n'), 0, 0);
    },
  });
}
