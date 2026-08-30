import { describe, expect, it, vi } from 'vitest';

import { helpReport, main } from '../src/launcher.js';

describe('launcher update contract', () => {
  it('advertises only the platform update target', () => {
    const updateLine = helpReport()
      .split('\n')
      .find((line) => /^\s*update\b/u.test(line));

    expect(updateLine).toBeDefined();
    expect(updateLine).toContain('platform');
    expect(updateLine).not.toContain('core');
  });

  it('rejects the bundled core as an update target without spawning an install', async () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const out = vi.fn();

    await expect(main(['update', 'core'], { env: {}, out, spawn })).resolves.toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    const message = String(out.mock.calls.at(-1)?.[0] ?? '');
    expect(message).toMatch(/unsupported|unknown|usage/iu);
    expect(message).toContain('platform');
  });

  it('rejects trailing update targets instead of silently installing the platform', async () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const out = vi.fn();

    await expect(main(['update', 'platform', 'core'], { env: {}, out, spawn })).resolves.toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(String(out.mock.calls.at(-1)?.[0] ?? '')).toMatch(/usage/iu);
  });

  it('keeps the platform update on the installed launcher package', async () => {
    const spawn = vi.fn(() => ({ status: 0 }));

    await expect(main(['update', 'platform'], { env: {}, spawn })).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'octocode-agent@latest'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });
});
