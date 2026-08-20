/**
 * omp-deltas.test.ts — the OMP-parity feature set.
 *
 * Covers: per-terminal -c breadcrumbs (P0-3), bucketed session listing (P1-1),
 * config get|set|list (P0-2), OCTOCODE_PI_* mirroring (P1-2), versioned setup
 * state (P0-1), --smoke-test + `session` alias (P2-lite).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listSessions,
  listProjectSessions,
  newestProjectSession,
  decodeBucketName,
} from '../src/sessions.js';
import {
  AGENT_STATE_VERSION,
  readAgentState,
  writeAgentState,
  markSetupDone,
  terminalId,
  readBreadcrumb,
  writeBreadcrumb,
} from '../src/state.js';
import {
  buildLaunchEnv,
  parseInvocation,
  rewriteContinueFlag,
  runConfigGet,
  runConfigSet,
  runConfigList,
  runSmokeTest,
  main,
} from '../src/launcher.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-agent-omp-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fixture: one bucket per project with a properly-headed JSONL session file. */
function seedSession(root: string, bucket: string, file: string, id: string, cwd: string, mtime: number): string {
  const dir = path.join(root, bucket);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  fs.writeFileSync(p, JSON.stringify({ type: 'session', version: 3, id, timestamp: 'x', cwd }) + '\n');
  fs.utimesSync(p, mtime / 1000, mtime / 1000);
  return p;
}

// ── sessions.ts (P1-1) ──────────────────────────────────────────────────────────

describe('sessions listing (bucketed layout)', () => {
  it('lists sessions across projects, newest first, with header cwd', () => {
    const root = path.join(tmp, 'sessions');
    const t1 = Date.now() - 1000 * 60 * 60 * 3;
    const t2 = Date.now();
    seedSession(root, '--Users-a-proj1--', 't1_aa.jsonl', 'uuid-1', '/Users/a/proj1', t1);
    seedSession(root, '--Users-a-proj2--', 't2_bb.jsonl', 'uuid-2', '/Users/a/proj2', t2);
    const all = listSessions(root);
    expect(all.map((s) => s.uuid)).toEqual(['uuid-2', 'uuid-1']);
    expect(all[0].cwd).toBe('/Users/a/proj2');
    expect(all[1].key).toBe('t1_aa');
    expect(all[0].file).toContain(path.join('--Users-a-proj2--', 't2_bb.jsonl'));
  });

  it('falls back to the uuid segment when the header is unreadable', () => {
    const root = path.join(tmp, 'sessions');
    const dir = path.join(root, '--x--');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't_019ff9a1-dead-beef.jsonl'), 'not-json\n');
    const all = listSessions(root);
    expect(all).toHaveLength(1);
    expect(all[0].uuid).toBe('019ff9a1-dead-beef');
    expect(all[0].cwd).toBe('/x');
  });

  it('returns [] for a missing root and skips unreadable buckets', () => {
    expect(listSessions(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('listProjectSessions filters by header cwd; newestProjectSession picks newest', () => {
    const root = path.join(tmp, 'sessions');
    const old = Date.now() - 100;
    seedSession(root, '--p1--', 'a_x.jsonl', 'u1', '/p1', old);
    seedSession(root, '--p1--', 'b_y.jsonl', 'u2', '/p1', Date.now());
    seedSession(root, '--p2--', 'c_z.jsonl', 'u3', '/p2', Date.now());
    expect(listProjectSessions('/p1', root).map((s) => s.uuid)).toEqual(['u2', 'u1']);
    expect(newestProjectSession('/p1', root)?.uuid).toBe('u2');
    expect(newestProjectSession('/empty', root)).toBeNull();
  });

  it('decodeBucketName is a display fallback only', () => {
    expect(decodeBucketName('--Users-bgaryy-code--')).toBe('/Users/bgaryy/code');
    expect(decodeBucketName('--x--')).toBe('/x');
  });
});

// ── state.ts (P0-1) ─────────────────────────────────────────────────────────────

describe('agent state (versioned setup)', () => {
  it('round-trips state; markSetupDone stamps the current version', () => {
    expect(readAgentState(tmp)).toEqual({});
    writeAgentState(tmp, { setupVersion: 0 });
    expect(readAgentState(tmp).setupVersion).toBe(0);
    markSetupDone(tmp);
    expect(readAgentState(tmp).setupVersion).toBe(AGENT_STATE_VERSION);
    expect(fs.statSync(path.join(tmp, 'state.json')).mode & 0o777).toBe(0o600);
  });

  it('writeAgentState merge-patches (other keys survive)', () => {
    writeAgentState(tmp, { setupVersion: 1 });
    (fs as typeof fs).writeFileSync(
      path.join(tmp, 'state.json'),
      JSON.stringify({ setupVersion: 1, extra: 'keep' }) + '\n',
    );
    writeAgentState(tmp, { setupVersion: 2 });
    const st = readAgentState(tmp) as { setupVersion: number; extra?: string };
    expect(st.setupVersion).toBe(2);
    expect(st.extra).toBe('keep');
  });
});

// ── terminal breadcrumbs (P0-3) ────────────────────────────────────────────────

describe('per-terminal breadcrumbs', () => {
  it('terminalId reads multiplexer envs in order; null when unknown', () => {
    expect(terminalId({ TMUX_PANE: '%3' })).toBe('%3');
    expect(terminalId({ WEZTERM_PANE: 'wp', KITTY_WINDOW_ID: 'kw' })).toBe('kw');
    expect(terminalId({})).toBeNull();
  });

  it('breadcrumb round-trips; stale entries (deleted files) read as null', () => {
    const sess = path.join(tmp, 's.jsonl');
    fs.writeFileSync(sess, '{}\n');
    const file = writeBreadcrumb(tmp, 'tmux%1', { sessionFile: sess, cwd: '/p' });
    expect(file).toContain(path.join(tmp, 'terminal-sessions'));
    expect(readBreadcrumb(tmp, 'tmux%1')?.sessionFile).toBe(sess);
    fs.rmSync(sess);
    expect(readBreadcrumb(tmp, 'tmux%1')).toBeNull();
  });

  it('filenames are sanitized for weird terminal ids', () => {
    fs.writeFileSync(path.join(tmp, 's.jsonl'), '{}\n');
    const file = writeBreadcrumb(tmp, '%weird/id', { sessionFile: path.join(tmp, 's.jsonl'), cwd: null });
    expect(file).toMatch(/_weird_id\.json$/);
  });
});

describe('rewriteContinueFlag', () => {
  it('rewrites -c to --session <file> when a breadcrumb exists', () => {
    const sess = path.join(tmp, 's.jsonl');
    fs.writeFileSync(sess, '{}\n');
    writeBreadcrumb(tmp, '%9', { sessionFile: sess, cwd: '/p' });
    const env = { TMUX_PANE: '%9' };
    expect(rewriteContinueFlag(['-c'], env, tmp)).toEqual(['--session', sess]);
    expect(rewriteContinueFlag(['--model', 'x', '--continue'], env, tmp)).toEqual([
      '--model', 'x', '--session', sess,
    ]);
  });

  it('passes through untouched without a terminal id or breadcrumb', () => {
    expect(rewriteContinueFlag(['-c'], {}, tmp)).toEqual(['-c']);
    const env = { TMUX_PANE: '%nope' };
    expect(rewriteContinueFlag(['-c'], env, tmp)).toEqual(['-c']);
    expect(rewriteContinueFlag(['--model', 'x'], { TMUX_PANE: '%9' }, tmp)).toEqual(['--model', 'x']);
  });
});

// ── settings surface (P0-2) ─────────────────────────────────────────────────────

describe('config get|set|list', () => {
  let piDir: string;
  beforeEach(() => {
    piDir = path.join(tmp, 'pi', 'agent');
    fs.mkdirSync(piDir, { recursive: true });
  });

  it('get/set/list round-trip through Pi settings.json', () => {
    fs.writeFileSync(path.join(piDir, 'settings.json'), '{"defaultProvider":"anthropic"}\n');
    const out: string[] = [];
    const push = (m: string) => out.push(m);
    expect(runConfigGet('defaultProvider', { out: push, env: {} }, false, piDir)).toBe(0);
    expect(out.at(-1)).toBe('anthropic');
    expect(runConfigSet('defaultModel', 'claude-x', { out: push, env: {} }, piDir)).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8')).defaultModel).toBe('claude-x');
    out.length = 0;
    expect(runConfigList({ out: push, env: {} }, false, piDir)).toBe(0);
    expect(out.join('\n')).toContain('defaultModel');
    expect(out.join('\n')).toContain('defaultProvider');
  });

  it('get unknown key → exit 2 with hint; set non-allowlisted key → exit 2, no write', () => {
    const out: string[] = [];
    const push = (m: string) => out.push(m);
    expect(runConfigGet('nope', { out: push, env: {} }, false, piDir)).toBe(2);
    const before = fs.existsSync(path.join(piDir, 'settings.json'));
    expect(runConfigSet('apiKey', 'secret', { out: push, env: {} }, piDir)).toBe(2);
    expect(fs.existsSync(path.join(piDir, 'settings.json'))).toBe(before);
    expect(runConfigSet('defaultModel', undefined, { out: push, env: {} }, piDir)).toBe(2);
  });

  it('get --json prints a {key,value} pair', () => {
    fs.writeFileSync(path.join(piDir, 'settings.json'), '{"defaultModel":"m"}\n');
    const out: string[] = [];
    expect(runConfigGet('defaultModel', { out: (m) => out.push(m), env: {} }, true, piDir)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual({ key: 'defaultModel', value: 'm' });
  });

  it('list on empty settings reports as empty', () => {
    const out: string[] = [];
    expect(runConfigList({ out: (m) => out.push(m), env: {} }, false, piDir)).toBe(0);
    expect(out.join('\n')).toContain('nothing set yet');
  });
});

// ── env mirroring (P1-2) ────────────────────────────────────────────────────────

describe('OCTOCODE_PI_* → PI_* mirroring', () => {
  it('mirrors brand vars; explicit PI_* always wins', () => {
    const env = buildLaunchEnv({
      OCTOCODE_PI_CODING_AGENT_DIR: '/branded',
      PLAIN: 'x',
    });
    expect(env.PI_CODING_AGENT_DIR).toBe('/branded');
    expect(env.PLAIN).toBe('x');

    const env2 = buildLaunchEnv({
      OCTOCODE_PI_CODING_AGENT_DIR: '/branded',
      PI_CODING_AGENT_DIR: '/explicit',
    });
    expect(env2.PI_CODING_AGENT_DIR).toBe('/explicit');
  });

  it('does not mirror undecorated OCTOCODE_* vars', () => {
    const env = buildLaunchEnv({ OCTOCODE_LAUNCHER_MODE: 'subprocess' });
    expect(env.PI_LAUNCHER_MODE).toBeUndefined();
  });
});

// ── smoke + session alias (P2-lite) ─────────────────────────────────────────────

describe('--smoke-test', () => {
  it('prints smoke-test: ok and exits 0 when launcher+core+pi resolve', () => {
    const out: string[] = [];
    const code = runSmokeTest({ out: (m) => out.push(m), env: {} });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/smoke-test: ok/);
  });

  it('main() routes "smoke" and "--smoke-test" identically', async () => {
    const out: string[] = [];
    const code = await main(['--smoke-test'], { out: (m) => out.push(m), env: {} });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/smoke-test: ok/);
  });
});

describe('parseInvocation additions', () => {
  it('session is an alias of resume (rest preserved)', () => {
    expect(parseInvocation(['session', 'abc']).command).toBe('resume');
    expect(parseInvocation(['session', 'abc']).rest).toEqual(['abc']);
  });
  it('--smoke-test maps to the smoke command', () => {
    expect(parseInvocation(['--smoke-test']).command).toBe('smoke');
  });
});
