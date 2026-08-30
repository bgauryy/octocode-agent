import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  NATIVE_SLASH_COMMANDS,
  WorkspaceFileCatalog,
  applyComposerSuggestion,
  parseComposerTrigger,
} from '../src/native-composer.js';

describe('native composer completion', () => {
  it('recognizes slash commands only at the start of the composer', () => {
    expect(parseComposerTrigger('/pla', 4)).toEqual({ mode: 'command', fragment: 'pla', start: 0, end: 4 });
    expect(parseComposerTrigger('explain /plan', 13)).toBeUndefined();
  });

  it('recognizes an active @ file token and replaces only that token', () => {
    const value = 'review @src/old.ts please';
    const trigger = parseComposerTrigger(value, 18);
    expect(trigger).toEqual({ mode: 'file', fragment: 'src/old.ts', start: 7, end: 18 });
    expect(applyComposerSuggestion(value, trigger!, {
      id: 'file-new', kind: 'file', label: 'src/new file.ts', insertText: 'src/new file.ts',
    })).toEqual({ value: 'review @"src/new file.ts" please', cursor: 25 });
  });

  it('provides stable described native commands', () => {
    expect(NATIVE_SLASH_COMMANDS.map(({ name }) => name)).toEqual([
      'cancel', 'clear', 'compact', 'exit', 'help', 'plan', 'quit', 'settings', 'skills', 'status', 'steer', 'thinking', 'tools',
      'commands',
    ]);
    expect(NATIVE_SLASH_COMMANDS.every(({ description }) => description.length > 0)).toBe(true);
  });

  it('discovers bounded safe workspace files and excludes generated and secret paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-composer-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'alpha file.ts'), 'export {};');
    fs.writeFileSync(path.join(root, 'src', 'beta.ts'), 'export {};');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=value');
    fs.writeFileSync(path.join(root, 'node_modules', 'hidden', 'bad.ts'), '');

    const catalog = new WorkspaceFileCatalog(root);
    const matches = await catalog.search('alp');

    expect(matches.map(({ label }) => label)).toEqual(['src/alpha file.ts']);
    expect((await catalog.search('')).some(({ label }) => label.includes('.env'))).toBe(false);
    expect((await catalog.search('')).some(({ label }) => label.includes('node_modules'))).toBe(false);
  });
});
