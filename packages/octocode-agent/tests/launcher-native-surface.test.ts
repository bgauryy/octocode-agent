import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { completionScript, fatalErrorReport, helpReport, main, modelsData, modelsReport, parseInvocation, runSurface, updateCommand } from '../src/launcher.js';
import { FileSettingsStorage } from '../src/native-settings.js';

describe('native launcher public surface', () => {
  it('preserves the command inventory in help and parsing', () => {
    for (const command of ['setup', 'auth', 'models', 'sessions', 'resume', 'session', 'update', 'config', 'doctor', 'completion', 'run', 'serve', 'acp', 'tools', 'skills', 'memory', 'awareness']) {
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

  it('turns OpenTUI FFI startup failures into an actionable one-line diagnostic', () => {
    expect(fatalErrorReport(
      new Error('Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet'),
      'v26.4.0',
    )).toBe('octocode-agent: OpenTUI is unavailable on v26.4.0. Re-run with NODE_OPTIONS=--experimental-ffi, or use --print for non-interactive output.');
  });

  it('reports the exact native model protocol boundary', () => {
    const data = modelsData({ OCTOCODE_MODEL_ENDPOINT: 'https://models.example/v1' });
    expect(data.protocol).toBe('openai-chat-completions');
    expect(data.endpoint).toBe('https://models.example/v1');
    expect(data.protocolSupport.filter((entry) => entry.supported)).toEqual([
      { protocol: 'openai-chat-completions', supported: true },
      { protocol: 'openai-responses', supported: true },
      { protocol: 'anthropic-messages', supported: true },
    ]);
    expect(modelsData({}).protocol).toBe('openai-responses');
    expect(modelsData({ OCTOCODE_MODEL_PROTOCOL: 'openai-chat-completions' }).protocol).toBe('openai-chat-completions');
    expect(modelsData({ OCTOCODE_MODEL_PROTOCOL: 'anthropic-messages' })).toMatchObject({
      protocol: 'anthropic-messages',
      endpoint: 'https://api.anthropic.com/v1',
    });
    expect(modelsReport({})).not.toContain('anthropic-messages:');
  });

  it('routes config and model mutations through typed, atomic settings transactions', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-launcher-settings-'));
    const env = { OCTOCODE_HOME: home };
    const dir = path.join(home, 'agent');
    const storage = new FileSettingsStorage(path.join(dir, 'settings.json'));
    storage.commit('0', { arbitrary: { preserved: true } });
    const out = vi.fn();

    await expect(main(['config', 'set', 'theme', 'plain-dark'], { env, out })).resolves.toBe(2);
    await expect(main(['models', '--set', 'anthropic/claude-custom'], { env, out })).resolves.toBe(0);

    expect(storage.read().values).toEqual({
      arbitrary: { preserved: true },
      defaultProvider: 'anthropic',
      defaultModel: 'claude-custom',
    });
    expect(out).toHaveBeenCalledWith(expect.stringMatching(/validation/i));
  });

  it('routes resume into the native launcher composition', async () => {
    const createRuntime = vi.fn(async () => { throw new Error('native composition reached'); });
    await expect(main(['resume', 's1'], { createRuntime })).rejects.toThrow('native composition reached');
    expect(createRuntime).toHaveBeenCalled();
  });

  it('maps the public plural skills command to the Octocode singular skill surface', () => {
    const spawn = vi.fn(() => ({ status: 0 } as never));
    expect(runSurface('skills', ['--help'], { spawn })).toBe(0);
    expect(spawn).toHaveBeenCalledWith('npx', ['octocode', 'skill', '--help'], expect.any(Object));
  });
});
