import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'vitest';

test('default tests cannot inherit live-integration flags', () => {
  assert.equal(process.env['OCTOCODE_CHROME_DEBUG_E2E'], undefined);
  assert.equal(process.env['RUN_CHROME_LIVE'], undefined);
  assert.equal(process.env['RUN_MCP_LIVE'], undefined);
});

test('default tests block browser and system-opener processes', () => {
  assert.throws(
    () => spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['https://example.com']),
    /TEST_EXTERNAL_EFFECT_BLOCKED.*inject a process\/browser mock/i,
  );
  assert.throws(
    () => spawnSync('open', ['https://example.com']),
    /TEST_EXTERNAL_EFFECT_BLOCKED.*inject a process\/browser mock/i,
  );
  assert.throws(
    () => spawnSync('npx', ['some-remote-package']),
    /TEST_EXTERNAL_EFFECT_BLOCKED.*inject a process\/browser mock/i,
  );
});

test('default tests block outbound network and allow deterministic Node subprocesses', async () => {
  await assert.rejects(
    () => fetch('https://example.com/'),
    /TEST_EXTERNAL_EFFECT_BLOCKED.*inject a fetch mock/i,
  );

  const child = spawnSync(process.execPath, ['--eval', 'process.stdout.write("ok")'], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'ok');
});
