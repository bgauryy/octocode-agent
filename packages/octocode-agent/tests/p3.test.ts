import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, setDefaultModelInSettings, readDefaultModel } from '../src/settings.js';
import { selectOne } from '../src/picker.js';
import { makePainter } from '../src/ui.js';
import { runModelsSet, formatAge, suggestCommand, main } from '../src/launcher.js';

let tmps: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-p3-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  tmps = [];
});

describe('settings', () => {
  it('readSettings tolerates missing/garbage files', () => {
    const d = tmpHome();
    expect(readSettings(d)).toEqual({});
    fs.writeFileSync(path.join(d, 'settings.json'), 'not json');
    expect(readSettings(d)).toEqual({});
  });
  it('setDefaultModelInSettings merges without clobbering other keys', () => {
    const d = tmpHome();
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ followUpMode: 'one-at-a-time' }));
    setDefaultModelInSettings(d, 'openai', 'gpt-4o');
    expect(readSettings(d)).toEqual({ followUpMode: 'one-at-a-time', defaultProvider: 'openai', defaultModel: 'gpt-4o' });
    expect(readDefaultModel(d)).toBe('openai/gpt-4o');
  });
});

describe('selectOne', () => {
  it('resolves null on non-TTY stdin (caller falls back)', async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: false });
    const p = makePainter(false);
    const got = await selectOne(p, { title: 't', rows: [{ id: 'a', label: 'a' }] }, stdin);
    expect(got).toBeNull();
  });
  it('navigates with keys: down down enter picks the third row', async () => {
    const stdin = new PassThrough({ objectMode: false }) as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => undefined });
    const p = makePainter(false);
    const pending = selectOne(p, { title: 't', rows: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }] }, stdin);
    for (const name of ['down', 'down', 'return']) {
      (stdin as unknown as PassThrough).emit('keypress', undefined, { name });
    }
    expect(await pending).toBe('c');
  });
});

describe('runModelsSet', () => {
  it('persists provider/model to settings.json (arg path)', async () => {
    const d = tmpHome();
    const lines: string[] = [];
    const code = await runModelsSet('gpt-4o', { out: (l) => lines.push(l), env: {} }, d);
    expect(code).toBe(0);
    expect(readDefaultModel(d)).toBe('openai/gpt-4o');
    expect(lines.join('\n')).toContain('default model');
  });
  it('accepts explicit provider/id form', async () => {
    const d = tmpHome();
    const code = await runModelsSet('anthropic/claude-opus-4-5', { out: () => undefined, env: {} }, d);
    expect(code).toBe(0);
    expect(readDefaultModel(d)).toBe('anthropic/claude-opus-4-5');
  });
  it('unknown model → 2 with guidance', async () => {
    const d = tmpHome();
    const lines: string[] = [];
    const code = await runModelsSet('nope-9000', { out: (l) => lines.push(l), env: {} }, d);
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unknown model');
  });
});

describe('suggestCommand / typo guard', () => {
  it('suggests the nearest verb for a single bare near-verb token', () => {
    expect(suggestCommand('confg')).toBe('config');
    expect(suggestCommand('dcotor')).toBe('doctor');
    expect(suggestCommand('authh')).toBe('auth');
  });
  it('never fires for quoted prompts, flags, or real verbs', () => {
    expect(suggestCommand('fix config')).toBeNull();
    expect(suggestCommand('--model')).toBeNull();
    expect(suggestCommand('doctor')).toBeNull();
    expect(suggestCommand(undefined)).toBeNull();
  });
  it('main(): typo exits 2 with a suggestion instead of launching', async () => {
    const lines: string[] = [];
    const code = await main(['confg'], { out: (l) => lines.push(l), env: {} });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('did you mean: octocode-agent config');
  });
});

describe('formatAge', () => {
  it('formats minutes/hours/days', () => {
    expect(formatAge(5 * 60_000)).toBe('5m ago');
    expect(formatAge(3 * 3_600_000)).toBe('3h ago');
    expect(formatAge(4 * 86_400_000)).toBe('4d ago');
  });
});
