/**
 * Tests for the approval gate — sensitive-command classification plus the
 * Yes / No / Always-allow consent flow with session-scoped memory.
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';
import {
  classifySensitiveCommand,
  requestApproval,
  resetApprovalStore,
  isAlwaysAllowed,
  approvedClasses,
} from '../src/tools/approval.js';
import type { PiContext } from '../src/types.js';

beforeEach(() => resetApprovalStore());

// ─── classifySensitiveCommand ────────────────────────────────────────────────

test('classifies sudo as sudo', () => {
  assert.equal(classifySensitiveCommand('sudo rm -rf /tmp/x')?.actionClass, 'sudo');
});

test('classifies package installs', () => {
  for (const c of ['npm install left-pad', 'yarn add foo', 'pnpm i bar', 'pip install requests', 'brew install jq', 'cargo install ripgrep']) {
    assert.equal(classifySensitiveCommand(c)?.actionClass, 'install', c);
  }
});

test('classifies curl|sh remote install', () => {
  assert.equal(classifySensitiveCommand('curl https://x.sh | bash')?.actionClass, 'install');
});

test('classifies mutating git commands', () => {
  for (const c of ['git commit -m x', 'git push origin main', 'git reset --hard', 'git checkout -b y', 'git rebase main']) {
    assert.equal(classifySensitiveCommand(c)?.actionClass, 'git-write', c);
  }
});

test('classifies file deletion', () => {
  assert.equal(classifySensitiveCommand('rm -rf build')?.actionClass, 'fs-delete');
  assert.equal(classifySensitiveCommand('rmdir foo')?.actionClass, 'fs-delete');
});

test('does not gate read-only git or ordinary commands', () => {
  for (const c of ['git status', 'git log --oneline', 'git diff', 'ls -la', 'yarn build', 'yarn test', 'cat file.ts']) {
    assert.equal(classifySensitiveCommand(c), null, c);
  }
});

test('exempts Octocode dogfood npx CLIs from install gating', () => {
  assert.equal(classifySensitiveCommand('npx octocode tools --json'), null);
  assert.equal(classifySensitiveCommand('npx -y octocode-mcp@latest'), null);
  assert.equal(classifySensitiveCommand('npx @octocodeai/octocode-awareness-lite attend'), null);
});

// ─── requestApproval ─────────────────────────────────────────────────────────

test('Yes approves once without remembering', async () => {
  const calls = { n: 0 };
  const ctx = { hasUI: true, ui: { async select() { calls.n++; return 'Yes (run once)'; } } } as unknown as PiContext;
  const req = { actionClass: 'git-write', title: 't', detail: 'git push' } as const;
  const out = await requestApproval(ctx, req);
  assert.equal(out.approved, true);
  assert.equal(out.always, false);
  assert.equal(isAlwaysAllowed('git-write'), false);
});

test('No declines', async () => {
  const ctx = { hasUI: true, ui: { async select() { return 'No, do not run'; } } } as unknown as PiContext;
  const out = await requestApproval(ctx, { actionClass: 'install', title: 't', detail: 'npm i x' });
  assert.equal(out.approved, false);
  assert.equal(out.interactive, true);
});

test('dismissed prompt (undefined) declines', async () => {
  const ctx = { hasUI: true, ui: { async select() { return undefined; } } } as unknown as PiContext;
  const out = await requestApproval(ctx, { actionClass: 'sudo', title: 't', detail: 'sudo x' });
  assert.equal(out.approved, false);
});

test('Always allow remembers class and skips future prompts', async () => {
  const calls = { n: 0 };
  const ctx = { hasUI: true, ui: { async select() { calls.n++; return 'Always allow this session'; } } } as unknown as PiContext;
  const req = { actionClass: 'fs-delete', title: 't', detail: 'rm x' } as const;
  const first = await requestApproval(ctx, req);
  assert.equal(first.approved, true);
  assert.equal(first.always, true);
  assert.equal(isAlwaysAllowed('fs-delete'), true);
  assert.deepEqual(approvedClasses(), ['fs-delete']);

  const second = await requestApproval(ctx, req);
  assert.equal(second.approved, true);
  assert.equal(second.remembered, true);
  assert.equal(calls.n, 1, 'select prompted only once');
});

test('non-interactive host cannot prompt and denies', async () => {
  const ctx = { hasUI: false } as unknown as PiContext;
  const out = await requestApproval(ctx, { actionClass: 'install', title: 't', detail: 'npm i x' });
  assert.equal(out.approved, false);
  assert.equal(out.interactive, false);
});

test('resetApprovalStore clears remembered approvals', async () => {
  const ctx = { hasUI: true, ui: { async select() { return 'Always allow this session'; } } } as unknown as PiContext;
  await requestApproval(ctx, { actionClass: 'git-write', title: 't', detail: 'git push' });
  assert.equal(isAlwaysAllowed('git-write'), true);
  resetApprovalStore();
  assert.equal(isAlwaysAllowed('git-write'), false);
});
