import { describe, expect, it } from 'vitest';

import { createNodeNativeBrowserDebugPort } from '../src/native-browser-debug.js';

const live = process.env.OCTOCODE_CDP_REAL_HOST === '1' ? describe : describe.skip;

live('native browser diagnostics real Chrome host', () => {
  it('discovers, snapshots, screenshots, and observes fixed diagnostics', async () => {
    const endpoint = process.env.OCTOCODE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
    const signal = new AbortController().signal;
    const port = createNodeNativeBrowserDebugPort({ timeoutMs: 5_000 });
    const targets = await port.listTargets(endpoint, signal);
    const target = targets.find((candidate) => candidate.title === 'Octocode CDP Fixture') ?? targets.find((candidate) => candidate.type === 'page');
    expect(target).toBeDefined();
    const snapshot = await port.command(endpoint, target!.id, 'DOMSnapshot.captureSnapshot', { computedStyles: [] }, signal) as Record<string, unknown>;
    const screenshot = await port.command(endpoint, target!.id, 'Page.captureScreenshot', { format: 'png' }, signal) as { data?: unknown };
    const consoleEvents = await port.observe(endpoint, target!.id, ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'], 400, signal);
    const networkEvents = await port.observe(endpoint, target!.id, ['Network.responseReceived', 'Network.loadingFailed'], 400, signal);
    expect(snapshot.documents).toBeInstanceOf(Array);
    expect(typeof screenshot.data).toBe('string');
    expect((screenshot.data as string).length).toBeGreaterThan(100);
    expect(consoleEvents.length).toBeGreaterThan(0);
    expect(networkEvents.length).toBeGreaterThan(0);
  }, 15_000);
});
