import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { main, parseInvocation } from '../src/launcher.js';

describe('launcher prompt and command boundary', () => {
  it('launches arbitrary near-command text as a prompt without requiring --', async () => {
    const createRuntime = vi.fn(async () => {
      throw new Error('prompt launch reached');
    });
    const out = vi.fn();

    expect(parseInvocation(['model'])).toEqual({ command: 'launch', args: ['model'], json: false });
    await expect(main(['model'], { createRuntime, out })).rejects.toThrow('prompt launch reached');
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(out).not.toHaveBeenCalledWith(expect.stringContaining('did you mean'));
  });

  it('continues to dispatch the exact models command instead of launching a prompt', async () => {
    const isolated = path.join(os.tmpdir(), `octocode-launcher-prompt-contract-${process.pid}`);
    const createRuntime = vi.fn(async () => {
      throw new Error('exact command was misrouted as a prompt');
    });
    const out = vi.fn();

    expect(parseInvocation(['models'])).toEqual({ command: 'models', args: [], json: false });
    await expect(main(['models'], {
      cwd: isolated,
      env: { HOME: isolated, OCTOCODE_HOME: isolated },
      createRuntime,
      out,
    })).resolves.toBe(0);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(out).toHaveBeenCalledOnce();
  });
});
