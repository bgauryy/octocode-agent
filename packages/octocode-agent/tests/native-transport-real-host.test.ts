import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const builtCli = path.join(packageRoot, 'out', 'octocode-agent.mjs');

describe('built native RPC saturation', () => {
  it('reports queue overflow before a blocked stdout consumer resumes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-rpc-saturation-'));
    const child = spawn(process.execPath, [builtCli, '--mode', 'rpc', '--no-session'], {
      cwd: packageRoot,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, OCTOCODE_HOME: path.join(root, 'home'),
        OPENAI_API_KEY: 'saturation-key-must-stay-redacted',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.pause();
    child.stdin.on('error', () => undefined);
    let stderr = '';
    let markerResolve!: () => void;
    const marker = new Promise<void>((resolve) => { markerResolve = resolve; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      if (/RPC output queue exceeded 1048576 bytes/.test(stderr)) markerResolve();
    });
    const batch = Array.from({ length: 50_000 }, (_, index) => `${JSON.stringify({
      protocolVersion: 1, requestId: `saturated-${index}`, command: { type: 'runtime.snapshot' },
    })}\n`).join('');
    child.stdin.end(batch);
    let timedOut = false;
    await Promise.race([
      marker,
      new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, 5_000)),
    ]);
    child.stdout.resume();
    if (timedOut && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
    fs.rmSync(root, { recursive: true, force: true });

    expect(timedOut, `stderr=${stderr}`).toBe(false);
    expect(stderr).toMatch(/RPC output queue exceeded 1048576 bytes/);
    expect(stderr).not.toContain('saturation-key-must-stay-redacted');
  }, 10_000);
});
