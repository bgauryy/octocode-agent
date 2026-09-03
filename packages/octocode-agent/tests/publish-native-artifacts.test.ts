import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(packageRoot, 'scripts', 'check-publish-native-artifacts.mjs');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'octocode-agent-publish-'));
  temporaryDirectories.push(directory);
  return directory;
}

function addTarget(root: string, target: string): void {
  const directory = join(root, target);
  mkdirSync(directory, { recursive: true });
  const extension = target.startsWith('win32-') ? '.exe' : '';
  writeFileSync(join(directory, `octocode-agent-core-rust${extension}`), 'fixture');
  writeFileSync(join(directory, `octocode-agent-fs${extension}`), 'fixture');
}

function runGuard(artifactRoot?: string) {
  const env = { ...process.env };
  delete env.OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR;
  if (artifactRoot !== undefined) env.OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR = artifactRoot;
  return spawnSync(process.execPath, [guard], { env, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('publish native artifact guard', () => {
  it('requires an explicit artifact directory', () => {
    const result = runGuard();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('OCTOCODE_AGENT_NATIVE_ARTIFACTS_DIR is required');
  });

  it('rejects a single-platform artifact set', () => {
    const root = temporaryDirectory();
    addTarget(root, 'darwin-arm64');

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing required platforms: linux, win32');
  });

  it('accepts complete macOS, Linux, and Windows artifact sets', () => {
    const root = temporaryDirectory();
    addTarget(root, 'darwin-arm64');
    addTarget(root, 'linux-x64');
    addTarget(root, 'win32-x64');

    const result = runGuard(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('publish artifacts verified');
  });
});
