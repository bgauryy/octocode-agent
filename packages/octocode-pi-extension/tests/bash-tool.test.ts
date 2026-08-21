import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { extractBashWriteTargets } from '../src/tools/bash-tool.js';

test('extractBashWriteTargets finds redirects and tee', () => {
  const cwd = '/tmp/work';
  assert.deepEqual(extractBashWriteTargets('echo hi > out.txt', cwd), [
    path.join(cwd, 'out.txt'),
  ]);
  assert.deepEqual(extractBashWriteTargets('echo hi >> /tmp/abs.log', cwd), [
    '/tmp/abs.log',
  ]);
  assert.ok(
    extractBashWriteTargets('printf x | tee nested/a.txt', cwd).includes(
      path.join(cwd, 'nested/a.txt'),
    ),
  );
});

test('extractBashWriteTargets finds cp/mv destinations', () => {
  const cwd = '/tmp/work';
  const targets = extractBashWriteTargets('cp a.ts b.ts', cwd);
  assert.deepEqual(targets, [path.join(cwd, 'b.ts')]);
});

test('bash abort terminates the shell process and resolves without hanging', async () => {
  const { default: extension } = await import('../src/index.js');
  const tools = new Map<
    string,
    {
      name: string;
      execute: (
        id: string,
        params: Record<string, unknown>,
        sig?: AbortSignal,
        upd?: unknown,
        ctx?: { cwd?: string },
      ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }
  >();
  await extension({
    on: () => undefined,
    sendUserMessage: () => undefined,
    registerTool: (def: { name: string }) => {
      tools.set(def.name, def as (typeof tools extends Map<string, infer V> ? V : never));
    },
    getActiveTools: () => ['bash'],
    setActiveTools: () => undefined,
  });
  const bash = tools.get('bash')!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-bash-abort-'));
  const controller = new AbortController();
  try {
    const promise = bash.execute(
      'abort',
      { command: 'trap "exit 143" TERM; while true; do echo err >&2; sleep 0.05; done' },
      controller.signal,
      undefined,
      { cwd: tmp },
    );
    setTimeout(() => controller.abort(), 50);
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('bash abort timed out')), 2_000)),
    ]);
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { text: string }).text, /err/);
  } finally {
    controller.abort();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bash override blocks writes outside allowed roots', async () => {
  const { default: extension } = await import('../src/index.js');
  const tools = new Map<
    string,
    {
      name: string;
      label?: string;
      execute: (
        id: string,
        params: Record<string, unknown>,
        sig?: AbortSignal,
        upd?: unknown,
        ctx?: { cwd?: string },
      ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    }
  >();
  const active = ['bash', 'edit', 'write'];
  await extension({
    on: () => undefined,
    sendUserMessage: () => undefined,
    registerTool: (def: { name: string }) => {
      tools.set(def.name, def as (typeof tools extends Map<string, infer V> ? V : never));
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.splice(0, active.length, ...names);
    },
  });
  const bash = tools.get('bash')!;
  assert.equal(bash.label, 'bash (Octocode)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-bash-'));
  try {
    await assert.rejects(
      () =>
        bash.execute(
          '1',
          { command: `echo pwned > /usr/octocode-bash-block-${process.pid}.txt` },
          undefined,
          undefined,
          { cwd: tmp },
        ),
      /bash write blocked|outside the allowed roots/,
    );
    const ok = await bash.execute(
      '2',
      { command: 'echo hello > ok.txt && cat ok.txt' },
      undefined,
      undefined,
      { cwd: tmp },
    );
    assert.match((ok.content[0] as { text: string }).text, /hello/);
    assert.equal(fs.readFileSync(path.join(tmp, 'ok.txt'), 'utf8').trim(), 'hello');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractBashWriteTargets: sed/perl in-place targets the FILE, never the script', () => {
  const cwd = '/repo';
  // BSD/macOS: `sed -i '' <script> file` — the address script starts with '/'
  // and must NOT be treated as an absolute output path (the original bug).
  assert.deepEqual(
    extractBashWriteTargets(`sed -i '' '/^    "x": 1,$/d' package.json`, cwd),
    [path.join(cwd, 'package.json')],
  );
  // GNU: `sed -i <script> file` (no separate suffix).
  assert.deepEqual(extractBashWriteTargets(`sed -i 's/a/b/' f.txt`, cwd), [path.join(cwd, 'f.txt')]);
  // GNU attached suffix.
  assert.deepEqual(extractBashWriteTargets(`sed -i.bak 's/a/b/' f.txt`, cwd), [path.join(cwd, 'f.txt')]);
  // Multiple files.
  assert.deepEqual(
    extractBashWriteTargets(`sed -i '' 's/a/b/' a.txt b.txt`, cwd).sort(),
    [path.join(cwd, 'a.txt'), path.join(cwd, 'b.txt')].sort(),
  );
  // Explicit -e script: every positional is a file.
  assert.deepEqual(extractBashWriteTargets(`sed -i '' -e 's/a/b/' f.txt`, cwd), [path.join(cwd, 'f.txt')]);
  // perl -i -pe.
  assert.deepEqual(extractBashWriteTargets(`perl -i -pe 's/a/b/' f.txt`, cwd), [path.join(cwd, 'f.txt')]);
  // Not in-place → no write target from sed.
  assert.deepEqual(extractBashWriteTargets(`sed 's/a/b/' f.txt`, cwd), []);
});
