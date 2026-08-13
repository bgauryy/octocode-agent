import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuthWizard, upsertEnvFile, type WizardIO } from '../src/onboard.js';

let tmps: string[] = [];
function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-onboard-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  tmps = [];
});

function fakeIO(answers: Array<string | null>): WizardIO & { lines: string[] } {
  const lines: string[] = [];
  let i = 0;
  return {
    lines,
    out: (l) => lines.push(l),
    ask: () => Promise.resolve(answers[i++] ?? null),
  };
}

describe('upsertEnvFile', () => {
  it('creates .env with 0600 and the key', () => {
    const home = tmpHome();
    upsertEnvFile(path.join(home, '.env'), 'ANTHROPIC_API_KEY', 'sk-ant-abc123');
    const content = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(content).toBe('ANTHROPIC_API_KEY=sk-ant-abc123\n');
    expect(fs.statSync(path.join(home, '.env')).mode & 0o777).toBe(0o600);
  });
  it('replaces an existing key without duplicating', () => {
    const home = tmpHome();
    const envPath = path.join(home, '.env');
    upsertEnvFile(envPath, 'OPENAI_API_KEY', 'sk-old-000000');
    upsertEnvFile(envPath, 'OPENAI_API_KEY', 'sk-new-111111');
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).toContain('sk-new-111111');
    expect(content).not.toContain('sk-old-000000');
  });
});

describe('runAuthWizard', () => {
  it('happy path: pick provider, masked key, saves to home .env', async () => {
    const home = tmpHome();
    const io = fakeIO(['2', 'sk-test-key-123456']);
    const code = await runAuthWizard({ env: {}, io, octocodeHome: home });
    expect(code).toBe(0);
    const content = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(content).toBe('OPENAI_API_KEY=sk-test-key-123456\n');
    expect(io.lines.join('\n')).toContain('octocode-agent auth login');
    expect(io.lines.join('\n')).toContain('auth status');
  });

  it('cancel on empty choice → 1, no file written', async () => {
    const home = tmpHome();
    const io = fakeIO(['']);
    const code = await runAuthWizard({ env: {}, io, octocodeHome: home });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false);
  });

  it('rejects junk keys (too short / spaces) without writing', async () => {
    const home = tmpHome();
    const io = fakeIO(['1', 'bad key']);
    const code = await runAuthWizard({ env: {}, io, octocodeHome: home });
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(home, '.env'))).toBe(false);
    expect(io.lines.join('\n')).toContain('does not look like an API key');
  });

  it('non-interactive (no injected io, no TTY) → 3 with guidance', async () => {
    const io = { out: (l: string) => { void l; } };
    const code = await runAuthWizard({ env: {} });
    expect(code).toBe(3);
    void io;
  });
});
