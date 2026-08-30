import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@octocodeai/agent-core';

import { handleNativeSlashCommand } from '../src/native-slash-commands.js';
import type { OpenTuiTerminal, PresentationEvent } from '../src/terminal/opentui/presentation.js';

function harness() {
  const events: PresentationEvent[] = [];
  const execute = vi.fn(async (
    _command: Parameters<AgentRuntime['execute']>[0],
  ): Promise<Awaited<ReturnType<AgentRuntime['execute']>>> => ({ ok: true, data: ['plan', 'skill'] }));
  const runtime = {
    snapshot: () => ({
      schemaVersion: 1 as const, state: 'ready' as const, sessionId: 's1' as never, activeTurn: false,
      model: { providerId: 'openai', modelId: 'gpt-5' }, thinkingLevel: 'high',
      usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 8, cacheWriteInputTokens: 2 }, revision: 1,
    }),
    execute,
    cancel: vi.fn(async () => undefined),
  } as unknown as AgentRuntime;
  const terminal = {
    accept: (event: PresentationEvent) => events.push(event),
    cancelInteraction: vi.fn(() => false),
  } as unknown as OpenTuiTerminal;
  return { context: { runtime, terminal, currentPlan: () => undefined, skills: () => [{ name: 'research', description: 'Check facts.' }] }, events, execute, runtime, terminal };
}

describe('native slash commands', () => {
  it('does not intercept normal prompts and rejects unknown slash commands locally', async () => {
    const { context, events } = harness();
    await expect(handleNativeSlashCommand('hello', context)).resolves.toBe('not-command');
    await expect(handleNativeSlashCommand('/missing', context)).resolves.toBe('handled');
    expect(events.at(-1)).toMatchObject({ type: 'notification', severity: 'error' });
  });

  it('renders help, status, skills, and tools as structured surfaces', async () => {
    const { context, events } = harness();
    for (const command of ['/help', '/status', '/skills', '/tools']) await handleNativeSlashCommand(command, context);
    expect(events.filter(({ type }) => type === 'presentation-changed')).toHaveLength(4);
    expect(events.some((event) => event.type === 'presentation-changed' && JSON.stringify(event.value).includes('Agent Skills'))).toBe(true);
    expect(events.some((event) => event.type === 'presentation-changed' && JSON.stringify(event.value).includes('/thinking <level>'))).toBe(true);
    expect(events.some((event) => event.type === 'presentation-changed' && JSON.stringify(event.value).includes('/settings [section]'))).toBe(true);
    expect(events.some((event) => event.type === 'presentation-changed'
      && JSON.stringify(event.value).includes('Cached input tokens')
      && JSON.stringify(event.value).includes('Cache write tokens'))).toBe(true);
  });

  it('routes approved Pi command names to native semantic owners', async () => {
    const { context, events, execute } = harness();

    await expect(handleNativeSlashCommand('/commands', context)).resolves.toBe('handled');

    expect(events.some((event) => event.type === 'presentation-changed' && JSON.stringify(event.value).includes('Native commands'))).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not invoke narrower native commands through blocked Pi names', async () => {
    const { context, events, execute } = harness();
    const openSettings = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:43123/' }));

    for (const command of [
      '/octocode', '/octocode-now', '/octocode-tasks', '/octocode-tasks show', '/octocode-skills',
      '/mcp', '/mcp models', '/octocode-plan', '/octocode-plan show', '/octocode-theme',
      '/octocode-palette', '/octocode-dial high',
    ]) {
      await expect(handleNativeSlashCommand(command, { ...context, openSettings, thinkingSupported: true })).resolves.toBe('handled');
      expect(events.at(-1)).toMatchObject({
        type: 'notification', severity: 'error', message: expect.stringContaining('unknown command'),
      });
    }

    expect(openSettings).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('opens settings locally, routes a section, and reports browser failures without model submission', async () => {
    const { context, events, execute } = harness();
    const openSettings = vi.fn(async (): Promise<
      | { ok: true; url: string }
      | { ok: false; url: string; message: string }
    > => ({ ok: true, url: 'http://127.0.0.1:43123/#models' }));
    await expect(handleNativeSlashCommand('/settings models', { ...context, openSettings })).resolves.toBe('handled');
    expect(openSettings).toHaveBeenCalledWith('models');
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: 'notification', severity: 'success', message: 'Settings opened · http://127.0.0.1:43123/#models',
    });

    openSettings.mockResolvedValue({ ok: false, url: 'http://127.0.0.1:43123/', message: 'Open it manually.' });
    await handleNativeSlashCommand('/settings', { ...context, openSettings });
    expect(events.at(-1)).toEqual({
      type: 'notification', severity: 'warning', message: 'Open it manually. · http://127.0.0.1:43123/',
    });
  });

  it('fails closed for unavailable settings and invalid sections', async () => {
    const { context, events } = harness();
    await handleNativeSlashCommand('/settings', context);
    expect(events.at(-1)).toMatchObject({ type: 'notification', severity: 'error' });

    const openSettings = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:43123/' }));
    await handleNativeSlashCommand('/settings nowhere', { ...context, openSettings });
    expect(openSettings).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'notification', severity: 'error', message: expect.stringContaining('section') });
  });

  it('dispatches runtime commands and exit without model submission', async () => {
    const { context, execute } = harness();
    await expect(handleNativeSlashCommand('/thinking high', { ...context, thinkingSupported: true })).resolves.toBe('handled');
    expect(execute).toHaveBeenCalledWith({ type: 'model.thinking', level: 'high' });
    await expect(handleNativeSlashCommand('/exit', context)).resolves.toBe('exit');
  });

  it('clears context by creating a fresh session and resetting presentation state', async () => {
    const { context, events, execute } = harness();
    execute.mockResolvedValueOnce({ ok: true as const, data: { sessionId: 's2' } });

    await expect(handleNativeSlashCommand('/clear', context)).resolves.toBe('handled');

    expect(execute).toHaveBeenCalledWith({ type: 'session.create' });
    expect(events).toContainEqual({ type: 'context-cleared' });
    expect(events.at(-1)).toEqual({
      type: 'notification', severity: 'success', message: 'Context cleared. New session started.',
    });
  });

  it('keeps the current context when clearing cannot create a session', async () => {
    const { context, events, execute } = harness();
    execute.mockResolvedValueOnce({
      ok: false as const,
      error: {
        category: 'conflict' as const,
        message: 'Session mutations require an idle runtime',
        retry: 'safe' as const,
        userVisible: true,
        redaction: 'public' as const,
        terminalEffect: 'operation' as const,
      },
    });

    await expect(handleNativeSlashCommand('/clear', context)).resolves.toBe('handled');

    expect(events).not.toContainEqual({ type: 'context-cleared' });
    expect(events.at(-1)).toMatchObject({
      type: 'notification', severity: 'error', message: expect.stringContaining('idle runtime'),
    });
  });

  it('cancels an open interaction before requesting runtime cancellation', async () => {
    const interaction = harness();
    vi.mocked(interaction.terminal.cancelInteraction!).mockReturnValue(true);

    await expect(handleNativeSlashCommand('/cancel', interaction.context)).resolves.toBe('handled');

    expect(interaction.terminal.cancelInteraction).toHaveBeenCalledOnce();
    expect(interaction.runtime.cancel).not.toHaveBeenCalled();
    expect(interaction.events.at(-1)).toEqual({ type: 'notification', severity: 'info', message: 'Cancellation requested.' });

    const turn = harness();
    await expect(handleNativeSlashCommand('/cancel', turn.context)).resolves.toBe('handled');

    expect(turn.terminal.cancelInteraction).toHaveBeenCalledOnce();
    expect(turn.runtime.cancel).toHaveBeenCalledOnce();
    expect(turn.runtime.cancel).toHaveBeenCalledWith('slash command');
  });

  it('exposes explicit active-turn steering with visible success and validation feedback', async () => {
    const { context, events, execute } = harness();
    await expect(handleNativeSlashCommand('/steer investigate the failing test', context)).resolves.toBe('handled');
    expect(execute).toHaveBeenCalledWith({ type: 'input.steer', text: 'investigate the failing test' });
    expect(events.at(-1)).toEqual({ type: 'notification', severity: 'success', message: 'Steering requested.' });

    await expect(handleNativeSlashCommand('/steer', context)).resolves.toBe('handled');
    expect(events.at(-1)).toMatchObject({ type: 'notification', severity: 'error', message: expect.stringContaining('usage') });
  });

  it('fails closed when the configured adapter cannot honor thinking controls', async () => {
    const { context, events, execute } = harness();
    await expect(handleNativeSlashCommand('/thinking high', context)).resolves.toBe('handled');
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'notification', severity: 'error' });
  });
});
