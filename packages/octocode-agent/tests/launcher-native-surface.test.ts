import { describe, expect, it, vi } from 'vitest';
import { completionScript, helpReport, main, parseInvocation, updateCommand } from '../src/launcher.js';

describe('native launcher public surface', () => {
  it('preserves the command inventory in help and parsing', () => {
    for (const command of ['setup', 'auth', 'models', 'sessions', 'resume', 'session', 'update', 'config', 'doctor', 'completion', 'run', 'serve', 'tools', 'skills', 'memory', 'awareness']) {
      expect(parseInvocation([command]).command).toBe(command);
      expect(helpReport()).toContain(command);
    }
    expect(parseInvocation(['--help'])).toMatchObject({ command: 'help', args: [] });
    expect(parseInvocation(['-h'])).toMatchObject({ command: 'help', args: [] });
    expect(parseInvocation(['--version'])).toMatchObject({ command: 'version', args: [] });
    expect(parseInvocation(['-v'])).toMatchObject({ command: 'version', args: [] });
  });

  it('keeps completion and update paths native', () => {
    expect(completionScript('zsh')).toContain('sessions');
    expect(updateCommand('core')).toEqual({ cmd: 'npm', args: ['install', '-g', '@octocodeai/agent-core@latest'] });
  });

  it('routes resume into the native launcher composition', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('native composition reached'); });
    await expect(main(['resume', 's1'], { createRuntime })).rejects.toThrow('native composition reached');
    expect(createRuntime).toHaveBeenCalled();
  });
});
