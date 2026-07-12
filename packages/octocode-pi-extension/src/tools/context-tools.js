import { makeRenderer, truncateToWidth } from './render-helpers.js';
const AUTO_COMPACT_THRESHOLD = 0.80;
function simpleRenderer(line) {
    return makeRenderer((w) => [truncateToWidth(line, w)]);
}
export function registerContextTools(pi, Type, registeredToolNames, registerFn, notify) {
    let lastAutoCompactTokens = null;
    if (pi.on) {
        pi.on('turn_end', (_event, ctx) => {
            const usage = ctx.getContextUsage?.();
            if (!usage)
                return;
            if (!(usage.contextWindow > 0))
                return; // guard divide-by-zero → NaN spurious compaction
            const fill = usage.tokens / usage.contextWindow;
            const prevFill = lastAutoCompactTokens !== null
                ? lastAutoCompactTokens / usage.contextWindow
                : null;
            lastAutoCompactTokens = usage.tokens;
            if (fill < AUTO_COMPACT_THRESHOLD)
                return;
            if (prevFill !== null && prevFill >= AUTO_COMPACT_THRESHOLD)
                return;
            const pctStr = `${Math.round(fill * 100)}%`;
            if (ctx.hasUI) {
                ctx.ui?.notify?.(`Auto-compacting: context at ${pctStr} of context window.`, 'info');
            }
            const continuation = 'Auto-compaction complete. Re-orient from the compacted context, then continue the user task.';
            ctx.compact?.({
                onComplete: () => {
                    if (ctx.hasUI) {
                        ctx.ui?.notify?.('Auto-compaction complete. Resuming…', 'info');
                    }
                    // ctx.compact() drives pi's manual compaction path, which aborts the
                    // running agent operation and never auto-continues (willRetry:false).
                    // Without a queued turn the agent loop halts idle after compaction —
                    // the "stuck after compaction" state. Queue a followUp to resume,
                    // mirroring the compact_context tool.
                    pi.sendUserMessage(continuation, { deliverAs: 'followUp' });
                },
                onError: (error) => {
                    if (ctx.hasUI) {
                        ctx.ui?.notify?.(`Auto-compaction failed: ${error.message}`, 'error');
                    }
                },
            });
        });
    }
    if (pi.registerCommand) {
        pi.registerCommand('_octocode-clear-context-impl', {
            description: '[internal] Start a new session — invoked by the clear_context tool.',
            handler: async (_args, ctx) => {
                if (!ctx.newSession) {
                    notify(ctx, 'clear_context: ctx.newSession not available in this runtime.', 'error');
                    return;
                }
                const result = await ctx.newSession();
                if (result?.cancelled) {
                    notify(ctx, 'clear_context: session switch was cancelled.', 'warning');
                }
            },
        });
    }
    registerFn(pi, registeredToolNames, {
        name: 'manage_context',
        label: 'Manage Context',
        description: 'Compact or reset the conversation context. ' +
            'type:"compact" — summarize history to free context window space; call when ≥60% full, at a research→execution boundary, or before a large task. ' +
            'type:"new" — start a fresh session with no prior context; call only when the next task is fully unrelated to the current conversation.',
        promptSnippet: 'Compact or reset conversation context',
        parameters: Type.Object({
            type: Type.Union([Type.Literal('compact'), Type.Literal('new')], { description: '"compact" summarizes history to free space. "new" starts a completely fresh session.' }),
            instructions: Type.Optional(Type.String({
                description: 'Focus instructions for the compaction summary (e.g. "focus on recent file changes"). Only used when type:"compact".',
            })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (params['type'] === 'new') {
                pi.sendUserMessage('/_octocode-clear-context-impl', { deliverAs: 'followUp' });
                return {
                    content: [
                        {
                            type: 'text',
                            text: 'New session queued. The context will be cleared after this turn completes.',
                        },
                    ],
                };
            }
            // type === 'compact'
            if (!ctx?.compact) {
                throw new Error('manage_context: ctx.compact is not available in this runtime. Use /compact manually.');
            }
            const continuation = 'Compaction is complete. Continue from the compacted context. Re-orient if needed, then proceed with the user task.';
            ctx.compact({
                customInstructions: params['instructions'],
                onComplete: () => {
                    if (ctx.hasUI) {
                        ctx.ui?.notify?.('Compaction completed. Continuing from the compacted context.', 'info');
                    }
                    pi.sendUserMessage(continuation, { deliverAs: 'followUp' });
                },
                onError: (error) => {
                    if (ctx.hasUI) {
                        ctx.ui?.notify?.(`Compaction failed: ${error.message}`, 'error');
                    }
                },
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Compaction triggered. The agent will continue after the summary is saved.',
                    },
                ],
            };
        },
        renderCall(args, theme) {
            const a = (args ?? {});
            const type = typeof a['type'] === 'string' ? a['type'] : 'compact';
            const instructions = type === 'compact' && typeof a['instructions'] === 'string' && a['instructions'] ? a['instructions'] : '';
            const nameStr = theme?.fg('toolTitle', theme.bold('manage_context')) ?? 'manage_context';
            const typeStr = theme?.fg('dim', ` (${type})`) ?? ` (${type})`;
            const detail = instructions
                ? (theme?.fg('dim', ` "${instructions.length > 50 ? instructions.slice(0, 47) + '…' : instructions}"`) ?? ` "${instructions}"`)
                : '';
            return simpleRenderer(`${nameStr}${typeStr}${detail}`);
        },
        renderResult(result, opts, theme) {
            if (opts.isPartial) {
                return simpleRenderer(theme?.fg('warning', 'Processing…') ?? 'Processing…');
            }
            const ok = !result.isError;
            const icon = theme?.fg(ok ? 'success' : 'error', ok ? '✓' : '✗') ?? (ok ? '✓' : '✗');
            const nameStr = theme?.fg('toolTitle', 'manage_context') ?? 'manage_context';
            const msg = ok
                ? (theme?.fg('dim', ' · done') ?? ' · done')
                : '';
            return simpleRenderer(`${icon} ${nameStr}${msg}`);
        },
    });
}
