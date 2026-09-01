import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNativePortableCustomizationV1 } from '../src/native-portable-customization.js';
import { encodeNativeWorkerBootstrapPacketV1 } from '../src/native-worker-bootstrap.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('native worker bootstrap real host', () => {
  it('loads fd 3 and recreates portable callbacks before runtime composition', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octocode-bootstrap-host-'));
    roots.push(root);
    const modulePath = path.join(root, 'portable.mjs');
    const moduleSource = `
      export async function activate({ target }) {
        return {
          schemaVersion: 1,
          id: 'com.acme.real-host',
          tools: [{
            id: 'portableTool', name: 'portableTool', label: 'Portable', description: 'Portable tool',
            schemaVersion: 1, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, outputVersion: 1,
            policy: { effects: ['read'], trust: 'none', approval: 'never', plan: 'allowed' },
            execute: async () => ({ ok: true, content: target, detailsVersion: 1 }),
          }],
        };
      }
    `;
    await fs.writeFile(modulePath, moduleSource);
    const integrity = `sha256-${createHash('sha256').update(moduleSource).digest('hex')}` as const;
    const resolution = await resolveNativePortableCustomizationV1({
      schemaVersion: 1,
      id: 'com.acme.real-host',
      entrypoint: {
        kind: 'module', moduleUrl: pathToFileURL(modulePath).href, exportName: 'activate', integrity,
      },
      workerContributions: ['tool:portableTool'],
    }, { target: 'root' });
    const bootstrap = encodeNativeWorkerBootstrapPacketV1({
      schemaVersion: 1,
      type: 'native.worker.bootstrap',
      workerId: 'worker-real-host',
      correlationId: 'correlation-real-host',
      promptSnapshotId: 'prompt-real-host',
      customization: resolution.descriptor,
    });
    const launcherUrl = pathToFileURL(path.resolve('src/native-launcher.ts')).href;
    const script = `
      import { launchNativeAgent } from ${JSON.stringify(launcherUrl)};
      import { Readable, Writable } from 'node:stream';
      const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      const extensions = {
        snapshot: () => ({ discovered: true }),
        activateEligible: async () => undefined,
        deactivateAll: () => undefined,
      };
      try {
        await launchNativeAgent(['--mode', 'rpc', '--no-session'], {
          env: process.env,
          cwd: process.env.OCTOCODE_REAL_HOST_CWD,
          stdin: Readable.from([]), stdout: sink, stderr: sink,
          createExtensions: async () => extensions,
          createRuntime: async (options) => {
            const names = options.customization?.tools?.map(({ name }) => name) ?? [];
            process.stdout.write(JSON.stringify({ names, targetResult: await options.customization.tools[0].execute({}, { signal: new AbortController().signal }) }) + '\\n');
            throw new Error('REAL_HOST_OBSERVED');
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'REAL_HOST_OBSERVED') process.exit(0);
        throw error;
      }
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        OCTOCODE_HOME: path.join(root, '.octocode'),
        OCTOCODE_REAL_HOST_CWD: root,
        OCTOCODE_NATIVE_WORKER: '1',
        OCTOCODE_NATIVE_WORKER_BOOTSTRAP_FD: '3',
        OCTOCODE_WORKER_ID: 'worker-real-host',
        OCTOCODE_WORKER_CORRELATION_ID: 'correlation-real-host',
        OCTOCODE_EXPECTED_PROMPT_SHA256: 'prompt-real-host',
        OCTOCODE_WORKER_ALLOWED_TOOLS: JSON.stringify(['portableTool']),
        OCTOCODE_WORKER_ALLOWED_MODELS: '[]',
        OCTOCODE_WORKER_MAX_TURNS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    (child.stdio[3] as Writable).end(Buffer.from(bootstrap));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    (child.stdout as Readable).on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    (child.stderr as Readable).on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(exit, Buffer.concat(stderr).toString('utf8')).toEqual({ code: 0, signal: null });
    expect(JSON.parse(Buffer.concat(stdout).toString('utf8'))).toMatchObject({
      names: ['portableTool'],
      targetResult: { ok: true, content: 'worker' },
    });
  }, 30_000);
});
